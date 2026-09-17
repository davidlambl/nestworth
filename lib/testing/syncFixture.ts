// Shared test fixture for the sync engine.
//
// The DB layer is backed by a real in-memory SQLite (better-sqlite3) wrapped to
// expose the async expo-sqlite surface `lib/sync.ts` uses, so the actual
// UPSERT/reconcile SQL runs. Supabase is a small in-memory fake supporting the
// query chains the sync code builds.
//
// This module lives OUTSIDE `lib/__tests__/` on purpose: jest's default
// testMatch treats every file under `__tests__/` as a suite, and a helper module
// with no tests in it fails with "Your test suite must contain at least one
// test". For the same reason it contains NO jest globals — `jest.mock()` calls
// are hoisted per file and stay in the test files that need them, and the mock
// wiring below is written against a structural view of a mock function so `tsc`
// never needs jest's types here.
//
// Test files that import this module MUST declare the same mocks sync.test.ts
// does (`jest.mock('../supabase')`, `jest.mock('../db')`), because the imports
// below resolve through the same registry.

import Database from 'better-sqlite3';
import { supabase } from '../supabase';
import { getDb, getSyncMeta, setSyncMeta } from '../db';

export const SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, icon TEXT, initial_balance REAL DEFAULT 0, exclude_from_total INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, txn_date TEXT, payee TEXT, amount REAL, check_number TEXT, memo TEXT, status TEXT DEFAULT 'pending', transfer_link_id TEXT, receipt_path TEXT, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transaction_splits (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, amount REAL, memo TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE recurring_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, frequency TEXT, next_date TEXT, end_date TEXT, template TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
`;

// --- expo-sqlite-shaped adapter over better-sqlite3 ---------------------------
export function makeAdapter() {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA);
  return {
    _sqlite: sqlite,
    getAllAsync: async (sql: string, params: any[] = []) =>
      sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, params: any[] = []) =>
      sqlite.prepare(sql).get(...params) ?? null,
    runAsync: async (sql: string, params: any[] = []) => {
      const info = sqlite.prepare(sql).run(...params);
      return {
        lastInsertRowId: Number(info.lastInsertRowid),
        changes: info.changes,
      };
    },
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await fn();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// --- minimal in-memory PostgREST-ish fake -------------------------------------
export type Store = Record<string, any[]>;

/** PostgREST renders timestamptz as '+00:00', never the 'Z' toISOString emits. */
export function toPgTimestamp(iso: string): string {
  return iso.endsWith('Z') ? iso.slice(0, -1) + '+00:00' : iso;
}

export interface SupabaseOpts {
  offline?: boolean;
  failWrites?: boolean;
  /** Per-table write failure, mirroring errorReadsOn on the read side. */
  failWritesOn?: Set<string>;
  errorReadsOn?: Set<string>;
  /** Timestamp the server stamps onto UPDATEs, mirroring the Postgres trigger. */
  serverNow?: string;
  /**
   * Simulates the `accounts_tombstone_children` trigger (default on). Switchable
   * so a test can prove the client does not DEPEND on the trigger: it pushes
   * child tombstones itself and must stay correct on a server without it.
   */
  cascadeTombstones?: boolean;
  /**
   * Fires after the server has accepted an upsert but before the caller sees
   * the response — i.e. exactly the window in which a concurrent local edit
   * can land during push's network round trip. Lets a test drive that race
   * deterministically instead of hand-waving it.
   */
  onAfterUpsert?: (table: string) => Promise<void>;
}

/**
 * PostgREST returns only the requested columns. Modelling that matters: with a
 * permissive fake, narrowing `.select('id, updated_at')` to `.select('id')` is
 * invisible, and a read-back the client depends on can regress silently.
 */
function project(rows: any[], cols?: string): any[] {
  if (!cols || cols.trim() === '*') return rows;
  const want = cols.split(',').map((c) => c.trim());
  return rows.map((r) =>
    Object.fromEntries(want.filter((c) => c in r).map((c) => [c, r[c]]))
  );
}

/**
 * `.is(col, null)` is PostgREST's `IS NULL`. A missing key must count as NULL:
 * fixture rows predate `deleted_at` and simply omit it, so a strict `=== null`
 * would make every `.is('deleted_at', null)` read return nothing — and a test
 * asserting "the tombstoned row was excluded" would pass for the wrong reason.
 */
function isPred(col: string, val: any): (r: any) => boolean {
  return (r: any) => (val === null ? r[col] == null : r[col] === val);
}

/**
 * Mirrors `accounts_tombstone_children` from 005_tombstones.sql: tombstoning an
 * account stamps its still-live transactions and rules, and each child's own
 * BEFORE UPDATE trigger bumps its updated_at, so other devices pull the whole
 * subtree on the next incremental pull.
 */
function cascadeAccountTombstone(
  store: Store,
  accountId: string,
  deletedAt: any,
  stamp: string
) {
  for (const child of ['transactions', 'recurring_rules']) {
    for (const row of store[child] ?? []) {
      if (row.account_id === accountId && row.deleted_at == null) {
        row.deleted_at = deletedAt;
        row.updated_at = stamp;
      }
    }
  }
}

export function makeSupabase(store: Store, opts: SupabaseOpts = {}) {
  const ERR = { message: 'network unreachable' };
  function from(table: string) {
    const readFails = () => !!(opts.offline || opts.errorReadsOn?.has(table));
    const writeFails = () =>
      !!(opts.offline || opts.failWrites || opts.failWritesOn?.has(table));
    /**
     * Postgres stamps updated_at from a BEFORE UPDATE trigger that fires on
     * EVERY update, so the fake stamps unconditionally too. `serverNow` lets a
     * test choose a timestamp OLDER than the client's, which is the drift that
     * used to strand a row permanently out of sync.
     */
    const serverStamp = () =>
      opts.serverNow ?? toPgTimestamp(new Date().toISOString());

    const preds: ((r: any) => boolean)[] = [];
    let orderCol: string | null = null;
    const rows = () => {
      let out = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0));
      }
      return out;
    };
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        preds.push((r) => r[col] === val);
        return builder;
      },
      gt: (col: string, val: any) => {
        preds.push((r) => r[col] != null && String(r[col]) > String(val));
        return builder;
      },
      in: (col: string, vals: any[]) => {
        const set = new Set(vals);
        preds.push((r) => set.has(r[col]));
        return builder;
      },
      is: (col: string, val: any) => {
        preds.push(isPred(col, val));
        return builder;
      },
      order: (col: string) => {
        orderCol = col;
        return builder;
      },
      limit: (_n: number) => builder,
      range: (a: number, b: number) =>
        Promise.resolve(
          readFails()
            ? { data: null, error: ERR }
            : { data: rows().slice(a, b + 1), error: null }
        ),
      then: (resolve: any, reject: any) =>
        Promise.resolve(
          readFails()
            ? { data: null, error: ERR }
            : { data: rows(), error: null }
        ).then(resolve, reject),
      // Mirrors Postgres: an UPDATE fires the BEFORE UPDATE trigger that
      // overwrites updated_at with server time, while an INSERT keeps the
      // client's value (the real trigger is UPDATE-only).
      upsert: (rowOrRows: any) => {
        let ran: { data: any; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (writeFails()) {
            ran = { data: null, error: ERR };
            return ran;
          }
          const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          store[table] = store[table] ?? [];
          const saved: any[] = [];
          for (const row of incoming) {
            const i = store[table].findIndex((r) => r.id === row.id);
            if (i >= 0) {
              const stamped =
                opts.serverNow && 'updated_at' in row
                  ? { ...row, updated_at: opts.serverNow }
                  : row;
              // Merge, never replace: PostgREST only writes the keys the
              // payload carries, so a column the client omitted (notably
              // deleted_at) survives an upsert. That is what makes "delete
              // wins over a concurrent edit" true server-side.
              store[table][i] = { ...store[table][i], ...stamped };
              saved.push({ ...store[table][i] });
            } else {
              // INSERT keeps the client's value (the trigger is UPDATE-only),
              // but PostgREST still re-serializes timestamptz on the way back:
              // '...Z' from toISOString() comes home as '...+00:00'. Modelling
              // that keeps the first-push-of-a-new-row path honest — the client
              // must adopt the server's RENDERING, not assume its own survives.
              const rendered =
                typeof row.updated_at === 'string'
                  ? { ...row, updated_at: toPgTimestamp(row.updated_at) }
                  : row;
              store[table].push({ ...rendered });
              saved.push({ ...rendered });
            }
          }
          ran = { data: saved, error: null };
          return ran;
        };
        const thenable: any = {
          select: (cols?: string) => ({
            single: async () => {
              const r = run();
              if (!r.error && opts.onAfterUpsert) {
                await opts.onAfterUpsert(table);
              }
              return {
                data: r.error ? null : (project(r.data ?? [], cols)[0] ?? null),
                error: r.error,
              };
            },
            then: (resolve: any, reject: any) =>
              Promise.resolve(run())
                .then(async (r) => {
                  if (!r.error && opts.onAfterUpsert) {
                    await opts.onAfterUpsert(table);
                  }
                  return r.error
                    ? r
                    : { data: project(r.data ?? [], cols), error: null };
                })
                .then(resolve, reject),
          }),
          then: (resolve: any, reject: any) =>
            Promise.resolve(run()).then(resolve, reject),
        };
        return thenable;
      },
      /**
       * A tombstoning delete is an UPDATE: `.update({ deleted_at })
       * .eq('id', id).is('deleted_at', null)`. Chainable filters, thenable on
       * its own (PostgREST answers 204 with no body, hence `data: null`), and
       * `.select(cols)` to read the affected rows back.
       *
       * Zero matched rows is NOT an error on the thenable path — the client
       * relies on that: a row that was never pushed, already purged, or already
       * tombstoned matches nothing and must still fall through to the local
       * hard delete. Only `.single()` errors on zero rows, exactly as PostgREST
       * does (PGRST116), which is why the sync code never chains it here.
       */
      update: (patch: any) => {
        const up: ((r: any) => boolean)[] = [];
        let ran: { data: any[]; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (writeFails()) {
            ran = { data: [], error: ERR };
            return ran;
          }
          const stamp = serverStamp();
          const matched = (store[table] ?? []).filter((r) =>
            up.every((p) => p(r))
          );
          for (const row of matched) {
            const wasLive = row.deleted_at == null;
            Object.assign(row, patch, { updated_at: stamp });
            if (
              table === 'accounts' &&
              opts.cascadeTombstones !== false &&
              wasLive &&
              row.deleted_at != null
            ) {
              cascadeAccountTombstone(store, row.id, row.deleted_at, stamp);
            }
          }
          ran = { data: matched.map((r) => ({ ...r })), error: null };
          return ran;
        };
        const upd: any = {
          eq: (col: string, val: any) => {
            up.push((r) => r[col] === val);
            return upd;
          },
          in: (col: string, vals: any[]) => {
            const set = new Set(vals);
            up.push((r) => set.has(r[col]));
            return upd;
          },
          is: (col: string, val: any) => {
            up.push(isPred(col, val));
            return upd;
          },
          select: (cols?: string) => ({
            single: async () => {
              const r = run();
              if (r.error) return { data: null, error: r.error };
              const got = project(r.data, cols);
              if (got.length !== 1) {
                return {
                  data: null,
                  error: {
                    code: 'PGRST116',
                    message:
                      'JSON object requested, multiple (or no) rows returned',
                    details: `Results contain ${got.length} rows`,
                  },
                };
              }
              return { data: got[0], error: null };
            },
            then: (resolve: any, reject: any) =>
              Promise.resolve(run())
                .then((r) =>
                  r.error
                    ? { data: null, error: r.error }
                    : { data: project(r.data, cols), error: null }
                )
                .then(resolve, reject),
          }),
          then: (resolve: any, reject: any) =>
            Promise.resolve(run())
              .then((r) =>
                r.error
                  ? { data: null, error: r.error }
                  : { data: null, error: null }
              )
              .then(resolve, reject),
        };
        return upd;
      },
      /**
       * A plain INSERT. Thenable on its own (PostgREST answers with no body
       * unless asked, hence `data: null`), and `.select(cols)` resolves the
       * inserted rows narrowed to those columns — which is how push reads back
       * what the server stored for the splits it just uploaded (#20).
       *
       * Three properties of the real thing are modelled deliberately:
       *
       *  - A row that OMITS `updated_at` gets the column default (`now()`, per
       *    006_split_updated_at.sql), while one carrying an EXPLICIT null is
       *    rejected with 23502, because the column is `not null`. The client
       *    depends on both halves: a local split whose timestamp is NULL sends
       *    no key at all, and a fake that quietly accepted the null would hide
       *    a push that fails for every such row in production.
       *  - A row that carries one keeps it, but re-rendered the way PostgREST
       *    serializes timestamptz ('...Z' comes home as '...+00:00'), because
       *    `update_updated_at()` is a BEFORE UPDATE trigger and does not fire
       *    on INSERT. So the client must adopt the server's RENDERING of its
       *    own value, not assume the string it sent survives.
       *  - A BULK insert is null-filled to the UNION of its objects' keys.
       *    postgrest-js (2.101.1) sends `?columns=` listing every key found in
       *    ANY object of the array, and PostgREST, given `columns`, skips its
       *    "All object keys must match" (PGRST102) check and fills a listed key
       *    that a row omits with NULL. So a key absent from one row but present
       *    on a sibling reaches Postgres as an explicit null -- for
       *    `updated_at`, a 23502 not-null violation, not the default. Only a
       *    key absent from EVERY row takes the column default. That is why
       *    push decides whether to send `updated_at` once per batch instead of
       *    per row: 23502 is not a missing column, so a mixed batch would stall
       *    the parent with nothing reported. `insert(rows, { defaultToNull:
       *    false })` sends `Prefer: missing=default` instead, so an omitted key
       *    takes its default row by row; that is modelled too, though the
       *    client does not use it.
       */
      insert: (
        rowOrRows: any,
        { defaultToNull = true }: { defaultToNull?: boolean } = {}
      ) => {
        let ran: { data: any[]; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (writeFails()) {
            ran = { data: [], error: ERR };
            return ran;
          }
          let incoming: any[] = Array.isArray(rowOrRows)
            ? rowOrRows
            : [rowOrRows];
          if (Array.isArray(rowOrRows) && defaultToNull) {
            // `?columns=` is the union of keys; PostgREST null-fills the gaps.
            const columns = Array.from(
              new Set(incoming.flatMap((r: any) => Object.keys(r)))
            );
            incoming = incoming.map((r: any) => {
              const filled: any = {};
              for (const c of columns) filled[c] = c in r ? r[c] : null;
              return filled;
            });
          }
          const nullTimestamp = incoming.find(
            (r: any) => 'updated_at' in r && r.updated_at == null
          );
          if (nullTimestamp) {
            ran = {
              data: [],
              error: {
                code: '23502',
                message: `null value in column "updated_at" of relation "${table}" violates not-null constraint`,
              },
            };
            return ran;
          }
          store[table] = store[table] ?? [];
          const saved: any[] = [];
          for (const row of incoming) {
            const stored =
              typeof row.updated_at === 'string'
                ? { ...row, updated_at: toPgTimestamp(row.updated_at) }
                : { ...row, updated_at: serverStamp() };
            store[table].push(stored);
            saved.push({ ...stored });
          }
          ran = { data: saved, error: null };
          return ran;
        };
        const ins: any = {
          select: (cols?: string) => ({
            then: (resolve: any, reject: any) =>
              Promise.resolve(run())
                .then((r) =>
                  r.error
                    ? { data: null, error: r.error }
                    : { data: project(r.data, cols), error: null }
                )
                .then(resolve, reject),
          }),
          then: (resolve: any, reject: any) =>
            Promise.resolve(run())
              .then((r) =>
                r.error
                  ? { data: null, error: r.error }
                  : { data: null, error: null }
              )
              .then(resolve, reject),
        };
        return ins;
      },
      delete: () => {
        const dp: ((r: any) => boolean)[] = [];
        let ran: { data: any; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (writeFails()) {
            ran = { data: null, error: ERR };
            return ran;
          }
          store[table] = (store[table] ?? []).filter(
            (r) => !dp.every((p) => p(r))
          );
          ran = { data: null, error: null };
          return ran;
        };
        const del: any = {
          eq: (col: string, val: any) => {
            dp.push((r) => r[col] === val);
            return del;
          },
          in: (col: string, vals: any[]) => {
            const set = new Set(vals);
            dp.push((r) => set.has(r[col]));
            return del;
          },
          is: (col: string, val: any) => {
            dp.push(isPred(col, val));
            return del;
          },
          then: (resolve: any, reject: any) =>
            Promise.resolve(run()).then(resolve, reject),
        };
        return del;
      },
    };
    return builder;
  }
  return { from };
}

// --- row builders -------------------------------------------------------------

export const TXN_COLS =
  'id,user_id,account_id,txn_date,payee,amount,check_number,memo,status,transfer_link_id,receipt_path,created_at,updated_at,_sync_status';

export const ACCOUNT_COLS =
  'id,user_id,name,type,icon,initial_balance,exclude_from_total,sort_order,is_archived,created_at,updated_at,_sync_status';

export const RULE_COLS =
  'id,user_id,account_id,frequency,next_date,end_date,template,created_at,updated_at,_sync_status';

export const SPLIT_COLS =
  'id,transaction_id,amount,memo,updated_at,_sync_status';

/**
 * `deleted_at` is attached only when the caller asks for a tombstone, so a live
 * fixture row omits the key entirely — which is how rows written before the 005
 * migration look, and what keeps `.is('deleted_at', null)`'s missing-key
 * handling under test rather than accidentally satisfied.
 */
function withTombstone(base: any, src: any): any {
  return src.deleted_at == null
    ? base
    : { ...base, deleted_at: src.deleted_at };
}

export function remoteTxn(t: any) {
  return withTombstone(
    {
      id: t.id,
      user_id: t.user_id ?? 'u',
      account_id: t.account_id ?? 'a1',
      txn_date: t.txn_date ?? '2026-01-01',
      payee: t.payee ?? 'Payee',
      amount: t.amount ?? 0,
      check_number: t.check_number ?? null,
      memo: t.memo ?? null,
      status: t.status ?? 'cleared',
      transfer_link_id: t.transfer_link_id ?? null,
      receipt_path: t.receipt_path ?? null,
      created_at: t.created_at ?? '2026-01-01T00:00:00Z',
      updated_at: t.updated_at ?? '2026-01-01T00:00:00Z',
    },
    t
  );
}

/** Server-shaped account row. Booleans stay booleans — Postgres, not SQLite. */
export function remoteAccount(a: any) {
  return withTombstone(
    {
      id: a.id,
      user_id: a.user_id ?? 'u',
      name: a.name ?? 'Checking',
      type: a.type ?? 'checking',
      icon: a.icon ?? null,
      initial_balance: a.initial_balance ?? 0,
      exclude_from_total: a.exclude_from_total ?? false,
      sort_order: a.sort_order ?? 0,
      is_archived: a.is_archived ?? false,
      created_at: a.created_at ?? '2026-01-01T00:00:00Z',
      updated_at: a.updated_at ?? '2026-01-01T00:00:00Z',
    },
    a
  );
}

/** Server-shaped recurring rule. `template` is jsonb server-side, hence object. */
export function remoteRule(r: any) {
  return withTombstone(
    {
      id: r.id,
      user_id: r.user_id ?? 'u',
      account_id: r.account_id ?? 'a1',
      frequency: r.frequency ?? 'monthly',
      next_date: r.next_date ?? '2026-02-01',
      end_date: r.end_date ?? null,
      template: r.template ?? {},
      created_at: r.created_at ?? '2026-01-01T00:00:00Z',
      updated_at: r.updated_at ?? '2026-01-01T00:00:00Z',
    },
    r
  );
}

export async function insertLocalTxn(adapter: any, t: any) {
  await adapter.runAsync(
    `INSERT INTO transactions (${TXN_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      t.id,
      t.user_id ?? 'u',
      t.account_id ?? 'a1',
      t.txn_date ?? '2026-01-01',
      t.payee ?? 'Payee',
      t.amount ?? 0,
      t.check_number ?? null,
      t.memo ?? null,
      t.status ?? 'cleared',
      t.transfer_link_id ?? null,
      t.receipt_path ?? null,
      t.created_at ?? '2026-01-01T00:00:00Z',
      t.updated_at ?? '2026-01-01T00:00:00Z',
      t._sync_status ?? 'synced',
    ]
  );
}

/** Local SQLite has no booleans: the flags are stored as 0/1 integers. */
export async function insertLocalAccount(adapter: any, a: any) {
  await adapter.runAsync(
    `INSERT INTO accounts (${ACCOUNT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      a.id,
      a.user_id ?? 'u',
      a.name ?? 'Checking',
      a.type ?? 'checking',
      a.icon ?? null,
      a.initial_balance ?? 0,
      a.exclude_from_total ? 1 : 0,
      a.sort_order ?? 0,
      a.is_archived ? 1 : 0,
      a.created_at ?? '2026-01-01T00:00:00Z',
      a.updated_at ?? '2026-01-01T00:00:00Z',
      a._sync_status ?? 'synced',
    ]
  );
}

/** `template` is a TEXT column locally, so an object is stringified. */
export async function insertLocalRule(adapter: any, r: any) {
  await adapter.runAsync(
    `INSERT INTO recurring_rules (${RULE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      r.id,
      r.user_id ?? 'u',
      r.account_id ?? 'a1',
      r.frequency ?? 'monthly',
      r.next_date ?? '2026-02-01',
      r.end_date ?? null,
      typeof r.template === 'string'
        ? r.template
        : JSON.stringify(r.template ?? {}),
      r.created_at ?? '2026-01-01T00:00:00Z',
      r.updated_at ?? '2026-01-01T00:00:00Z',
      r._sync_status ?? 'synced',
    ]
  );
}

/**
 * `updated_at` defaults to null rather than a timestamp on purpose: that is a
 * split written before local migration 2, and the push guard's NULL-safe `IS ?`
 * comparison only stays under test if fixtures actually produce the NULL.
 * Tests that care about the value pass one.
 */
export async function insertLocalSplit(adapter: any, s: any) {
  await adapter.runAsync(
    `INSERT INTO transaction_splits (${SPLIT_COLS}) VALUES (?,?,?,?,?,?)`,
    [
      s.id,
      s.transaction_id,
      s.amount ?? 0,
      s.memo ?? null,
      s.updated_at ?? null,
      s._sync_status ?? 'synced',
    ]
  );
}

// --- mock wiring --------------------------------------------------------------

/**
 * The slice of a jest mock function this module touches. Declared structurally
 * so the fixture needs no jest types (see the file header).
 */
interface MockedFn {
  mockImplementation: (impl: (...args: any[]) => any) => unknown;
}

/**
 * One-call setup for a sync suite: a fresh in-memory DB, an empty remote store,
 * an in-memory sync_meta map, and `getDb`/`getSyncMeta`/`setSyncMeta`/`supabase`
 * pointed at them. Requires the caller's file to have declared
 * `jest.mock('../supabase')` and `jest.mock('../db')`.
 *
 * Call from `beforeEach`, and close the DB in `afterEach`:
 *
 *     let f: ReturnType<typeof wireSyncMocks>;
 *     beforeEach(() => { f = wireSyncMocks(); });
 *     afterEach(() => { f.adapter._sqlite.close(); });
 *
 * `installSupabase(opts)` re-installs the fake over the SAME store mid-test,
 * which is the options-carrying swap existing tests write by hand as
 * `(supabase as any).from = makeSupabase(store, opts).from`.
 */
export function wireSyncMocks(opts: SupabaseOpts = {}) {
  const adapter = makeAdapter();
  const store: Store = {
    accounts: [],
    transactions: [],
    transaction_splits: [],
    recurring_rules: [],
  };
  const meta = new Map<string, string>();

  (getDb as unknown as MockedFn).mockImplementation(async () => adapter);
  (getSyncMeta as unknown as MockedFn).mockImplementation(
    async (k: string) => meta.get(k) ?? null
  );
  (setSyncMeta as unknown as MockedFn).mockImplementation(
    async (k: string, v: string) => {
      meta.set(k, v);
    }
  );

  const installSupabase = (next: SupabaseOpts = {}) => {
    const fake = makeSupabase(store, next);
    (supabase as any).from = fake.from;
    return fake;
  };
  installSupabase(opts);

  return { adapter, store, meta, installSupabase };
}

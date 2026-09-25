// Shared test fixture for the sync engine.
//
// The DB layer is backed by a real in-memory SQLite (better-sqlite3) wrapped to
// expose the async expo-sqlite surface `lib/sync.ts` uses, so the actual
// UPSERT/reconcile SQL runs. Supabase is a small in-memory fake supporting the
// query chains the sync code builds, plus `auth.getSession()`.
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
import { serialiseTransactions } from '../transactionQueue';

export const SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, icon TEXT, initial_balance REAL DEFAULT 0, exclude_from_total INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, txn_date TEXT, payee TEXT, amount REAL, check_number TEXT, memo TEXT, status TEXT DEFAULT 'pending', transfer_link_id TEXT, receipt_path TEXT, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transaction_splits (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, amount REAL, memo TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE recurring_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, frequency TEXT, next_date TEXT, end_date TEXT, template TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
`;

// --- expo-sqlite-shaped adapter over better-sqlite3 ---------------------------
/**
 * By default the adapter queues its withTransactionAsync callers with the
 * function lib/db.ts applies to the app's connection (#110), so the sync
 * suites run on the connection the app has. `serialise: false` leaves
 * expo-sqlite's raw behaviour, in which two callers collide: the red proofs
 * of lib/__tests__/syncTransactionQueue.test.ts.
 */
export function makeAdapter(opts: { serialise?: boolean } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA);
  const adapter = {
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
    // BEGIN inside the try, as expo-sqlite 16.0.10 has it: a BEGIN refused
    // because a transaction is already open on the (shared) connection still
    // runs ROLLBACK, which ends THAT transaction early. Outside the try, the
    // fixture hid every such collision from the sync tests (#97). This is the
    // method the queue wraps: callers reach it one at a time unless
    // `serialise` is false, and a raw BEGIN on `_sqlite` (pin F in
    // syncFixture.test.ts) bypasses the queue altogether.
    withTransactionAsync: async (fn: () => Promise<void>) => {
      try {
        sqlite.exec('BEGIN');
        await fn();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return opts.serialise === false ? adapter : serialiseTransactions(adapter);
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
  /**
   * PostgREST's `max_rows`: the server truncates EVERY response to this many
   * rows, whatever `.range()` asked for (1000 on hosted Supabase, unpinned
   * here). Without it no test can drive more than one page, and a read that
   * stops on a short page is indistinguishable from one that read everything —
   * which is the whole of #64. Applied to `.range()` AND to a bare `await`, so
   * an unpaged read is capped too. `.limit()` stays a no-op: the client uses it
   * only for the reset probe, where one row is all it wants.
   */
  maxRows?: number;
  /** Timestamp the server stamps onto UPDATEs, mirroring the Postgres trigger. */
  serverNow?: string;
  /**
   * Simulates the `accounts_tombstone_children` trigger (default on). Switchable
   * so a test can prove the client does not DEPEND on the trigger: it pushes
   * child tombstones itself and must stay correct on a server without it.
   */
  cascadeTombstones?: boolean;
  /**
   * Fires after the server has accepted an upsert, or refused it as purged
   * (`purgedIds`), but before the caller sees the response — i.e. exactly the
   * window in which a concurrent local edit can land during push's network
   * round trip. Lets a test drive that race deterministically instead of
   * hand-waving it. The purged refusal counts because the client acts on it
   * (it drops the row), so the race matters there as much as on success; an
   * ordinary failure leaves the row alone and does not fire it.
   */
  onAfterUpsert?: (table: string) => Promise<void>;
  /**
   * A client with no session whose requests reach the server (#95): what the
   * SERVER answers a request signed with the anon key. supabase-js signs every
   * request that way when it has no session, and RLS (`auth.uid() = user_id`)
   * answers each kind the way PostgREST does, with no error object on anything
   * but an insert:
   *
   *   - a read resolves `{ data: [], error: null }` (after the `offline` /
   *     `errorReadsOn` check, which a request that never arrived still wins);
   *   - an upsert or an insert is refused with 42501;
   *   - an UPDATE or a DELETE matches nothing: no stamp, no cascade, no error.
   *
   * Since #109 the app's client never sends such a request (`anonRejected`
   * below is the client as configured). This model stays because the engine's
   * own session checks are the second line, and these answers are what they
   * defend against. Against the refusal alone, readAllPages' third rule would
   * go untested (a refused page fails its read before the rule is asked, so
   * the outcome is the same without it), and pushChanges' entry check would
   * be tested only for what it reports (a refused tombstone UPDATE leaves its
   * row queued with or without it). Against these answers, removing either
   * one loses data: the push hard-deletes a row whose delete never reached
   * the server, and the pull absence-deletes the rows past an empty page.
   *
   * `auth.getSession()` answers `{ session: null }` with ANON_REFRESH_ERROR.
   * Read on every request, not captured, so a test can flip it between two
   * pages of one read. Install it through `installSupabase`: see there.
   */
  anonScoped?: boolean;
  /**
   * The client as configured since #109: a request signed with the anon key
   * is never sent. lib/supabase.ts's fetch wrapper (`withAnonRestRejection`,
   * lib/fetchWithTimeout.ts) refuses every `/rest/v1/` request whose
   * Authorization is `Bearer <anon key>`, and postgrest-js resolves the throw
   * as `{ data: null, error: ANON_REJECTION }` — a read, an upsert, an insert,
   * an UPDATE and a DELETE alike. Checked before every other option, because
   * the refusal happens inside the client, before the request could meet a
   * network or a server: `offline`, a write failure and the purge guard never
   * see it, and `onAfterUpsert` does not fire.
   *
   * `auth.getSession()` answers as it does under `anonScoped`. Read on every
   * request like `anonScoped`, so a test can flip it mid-push or mid-read.
   * No fixture suite reaches the real wrapper (they all mock ../supabase), so
   * a test written against this flag pins the engine's handling of the
   * refusal; the wrapper's own proof is supabaseAnonRejection.test.ts.
   */
  anonRejected?: boolean;
  /**
   * Whose session the fake is signed in with (#111), default `'u'`: the user
   * every row builder below defaults to. `auth.getSession()` hands out
   * `fakeSession(sessionUserId)`, and RLS (`auth.uid() = user_id`, 001) is
   * modelled by it on every request, reads and writes alike, the way the
   * server answers a request signed as someone else — with no error object on
   * anything but a write that would store a row:
   *
   *   - a read leaves out every row of another user's;
   *   - an UPDATE or a DELETE matches none of them: no stamp, no cascade, no
   *     error;
   *   - an upsert or an insert of one is refused with 42501, the whole
   *     statement with it (after the purged check, which Postgres runs
   *     first).
   *
   * A row is another user's when it carries their `user_id`, or, for a split,
   * which has none, when its parent does: 001's split policy goes through the
   * parent. A split whose parent the store does not hold stays everyone's, as
   * it always has here (neither the policy's `exists` nor the foreign key is
   * modelled for it), so a suite's orphan splits read as they always did.
   *
   * Unlike `anonRejected`, nothing in the client refuses such a request since
   * #109: it is signed, just by the wrong user, so it reaches the server and
   * these are its answers. `anonScoped` and `anonRejected` still win: with
   * either, there is no session at all.
   *
   * Read on every request, not captured, so a test can switch the session
   * between two requests of one sync: that is an account switch mid-sync.
   * Install it through `installSupabase`: see there.
   */
  sessionUserId?: string;
  /**
   * Ids `purge_tombstones()` has recorded in `purged_ids`
   * (008_purged_ids.sql). An upsert whose payload carries one is refused the
   * way `reject_purged_id()` refuses it — `23503` with `hint: 'purged'` — and
   * stores nothing. The check comes before the store is consulted, because
   * the trigger is BEFORE INSERT and sees the proposed row before ON CONFLICT
   * looks for an existing one; one refused row fails the whole statement.
   * It also comes before `anonScoped`'s 42501: RLS WITH CHECK runs after the
   * BEFORE ROW triggers, so an anon-signed upsert of a purged id is refused
   * as purged. One flat set: the server keys a record on (table, id), but
   * fixture ids never repeat across tables. Only upsert is guarded: it is how
   * the client writes all three guarded tables, and the trigger is
   * INSERT-only, so a tombstoning UPDATE of a purged row still just matches
   * nothing.
   */
  purgedIds?: Set<string>;
  /**
   * The error a write refused by `failWrites`/`failWritesOn` reports, in place
   * of the network failure — e.g. the server's hint-less `23503`, which the
   * client must tell apart from the purged refusal. `offline` always reports
   * the network failure.
   */
  writeError?: any;
}

/**
 * The session `auth.getSession()` hands out while the fake is signed in as
 * `userId`: what auth-js returns from storage, with no network I/O, for a
 * token more than 90 s from expiry. The engine reads two fields of it:
 * `access_token`, as supabase-js's own `_getAccessToken` does (is there a
 * session to sign with at all, #95), and `user.id` (is it the syncing user's,
 * #111).
 */
export function fakeSession(userId: string) {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4102444800,
    user: { id: userId },
  };
}

/** The default session: signed in as `'u'`, the suites' own user. */
export const FAKE_SESSION = fakeSession('u');

/**
 * What `auth.getSession()` returns beside `session: null` when the refresh it
 * attempted failed retryably: auth-js keeps the stored session and hands back
 * the fetch failure, here lib/fetchWithTimeout.ts's own timeout (the shape
 * authErrors.test.ts uses for a timed-out sign-in).
 */
export const ANON_REFRESH_ERROR = {
  name: 'AuthRetryableFetchError',
  message: 'Auth token request aborted after 30000ms',
  status: 0,
};

/**
 * What postgrest-js resolves `error` to when the fetch wrapper refuses an
 * anon-signed request (#109; see SupabaseOpts.anonRejected): the thrown
 * error's name folded into `message`, no `name` field of its own, and empty
 * `code` and `hint` (postgrest-js sets a hint only for an abort). The real
 * `details` is the throw's stack.
 */
export const ANON_REJECTION = {
  message: 'NoSessionError: your sign-in could not be verified',
  details: '',
  hint: '',
  code: '',
};

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

/**
 * 008's answer to an upsert of a purged id (see SupabaseOpts.purgedIds), as
 * PostgREST renders `reject_purged_id()`'s RAISE: HINT stays `hint`, and
 * `details` is null because the trigger sets no DETAIL.
 */
function purgedRefusal(table: string, id: string) {
  return {
    code: '23503',
    message: `${table} ${id} was deleted and its tombstone has been purged`,
    details: null,
    hint: 'purged',
  };
}

export function makeSupabase(store: Store, opts: SupabaseOpts = {}) {
  const ERR = { message: 'network unreachable' };
  // Asked per request, never captured: see SupabaseOpts.sessionUserId.
  const sessionUser = () => opts.sessionUserId ?? 'u';
  // RLS by the session's user (#111): a row is visible when it carries the
  // session's user_id, and a split (it has none) when its parent is, or when
  // the store does not hold its parent. See SupabaseOpts.sessionUserId.
  const visible = (r: any): boolean => {
    if ('user_id' in r) {
      return r.user_id === sessionUser();
    }
    if ('transaction_id' in r) {
      const parent = (store.transactions ?? []).find(
        (t) => t.id === r.transaction_id
      );
      return !parent || visible(parent);
    }
    return true;
  };
  function from(table: string) {
    const readFails = () => !!(opts.offline || opts.errorReadsOn?.has(table));
    const writeFails = () =>
      !!(opts.offline || opts.failWrites || opts.failWritesOn?.has(table));
    // Asked per request, never captured: see SupabaseOpts.anonScoped and
    // SupabaseOpts.anonRejected.
    const anon = () => !!opts.anonScoped;
    const rejected = () => !!opts.anonRejected;
    const rlsDenied = () => ({
      code: '42501',
      message: `new row violates row-level security policy for table "${table}"`,
    });
    const writeErr = () => (opts.offline ? ERR : (opts.writeError ?? ERR));
    /**
     * Postgres stamps updated_at from a BEFORE UPDATE trigger that fires on
     * EVERY update, so the fake stamps unconditionally too. `serverNow` lets a
     * test choose a timestamp OLDER than the client's, which is the drift that
     * used to strand a row permanently out of sync.
     */
    const serverStamp = () =>
      opts.serverNow ?? toPgTimestamp(new Date().toISOString());

    const cap = (r: any[]) =>
      opts.maxRows != null ? r.slice(0, opts.maxRows) : r;

    const preds: ((r: any) => boolean)[] = [];
    let orderCol: string | null = null;
    const rows = () => {
      let out = (store[table] ?? []).filter(
        (r) => visible(r) && preds.every((p) => p(r))
      );
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
          rejected()
            ? { data: null, error: ANON_REJECTION }
            : readFails()
              ? { data: null, error: ERR }
              : anon()
                ? { data: [], error: null }
                : { data: cap(rows().slice(a, b + 1)), error: null }
        ),
      then: (resolve: any, reject: any) =>
        Promise.resolve(
          rejected()
            ? { data: null, error: ANON_REJECTION }
            : readFails()
              ? { data: null, error: ERR }
              : anon()
                ? { data: [], error: null }
                : { data: cap(rows()), error: null }
        ).then(resolve, reject),
      // Mirrors Postgres: an UPDATE fires the BEFORE UPDATE trigger that
      // overwrites updated_at with server time, while an INSERT keeps the
      // client's value (the real trigger is UPDATE-only).
      upsert: (rowOrRows: any) => {
        let ran: { data: any; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (rejected()) {
            ran = { data: null, error: ANON_REJECTION };
            return ran;
          }
          if (writeFails()) {
            ran = { data: null, error: writeErr() };
            return ran;
          }
          const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          // 008's guard (see purgedIds): refused before the store is looked
          // at, and the whole statement with it. Before the anon refusal
          // too: Postgres runs BEFORE ROW INSERT triggers ahead of the RLS
          // WITH CHECK (ExecInsert), so an anon-signed upsert of a purged id
          // meets the guard first (checked against 008 in PGlite).
          const purged = incoming.find((row: any) =>
            opts.purgedIds?.has(row.id)
          );
          if (purged) {
            ran = { data: null, error: purgedRefusal(table, purged.id) };
            return ran;
          }
          if (anon()) {
            ran = { data: null, error: rlsDenied() };
            return ran;
          }
          // The same WITH CHECK, signed as someone else (#111): a row that
          // carries another user's user_id fails it like the anon key's.
          if (incoming.some((row: any) => !visible(row))) {
            ran = { data: null, error: rlsDenied() };
            return ran;
          }
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
        // The server answered: it stored the rows, or 008 refused them as
        // purged. Either way the client acts on the row (see onAfterUpsert).
        const answered = (r: { error: any }) =>
          !r.error || r.error.hint === 'purged';
        const thenable: any = {
          select: (cols?: string) => ({
            single: async () => {
              const r = run();
              if (answered(r) && opts.onAfterUpsert) {
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
                  if (answered(r) && opts.onAfterUpsert) {
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
          if (rejected()) {
            ran = { data: [], error: ANON_REJECTION };
            return ran;
          }
          if (writeFails()) {
            ran = { data: [], error: writeErr() };
            return ran;
          }
          if (anon()) {
            // RLS hides every row from the UPDATE, so it matches nothing —
            // which PostgREST reports as success, not as an error.
            ran = { data: [], error: null };
            return ran;
          }
          const stamp = serverStamp();
          // Another user's rows are hidden from the UPDATE as from a read
          // (#111): matching nothing is success, exactly as under anon().
          const matched = (store[table] ?? []).filter(
            (r) => visible(r) && up.every((p) => p(r))
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
          if (rejected()) {
            ran = { data: [], error: ANON_REJECTION };
            return ran;
          }
          if (writeFails()) {
            ran = { data: [], error: writeErr() };
            return ran;
          }
          if (anon()) {
            ran = { data: [], error: rlsDenied() };
            return ran;
          }
          let incoming: any[] = Array.isArray(rowOrRows)
            ? rowOrRows
            : [rowOrRows];
          // WITH CHECK signed as someone else (#111): another user's row, a
          // split under their parent included.
          if (incoming.some((row: any) => !visible(row))) {
            ran = { data: [], error: rlsDenied() };
            return ran;
          }
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
          if (rejected()) {
            ran = { data: null, error: ANON_REJECTION };
            return ran;
          }
          if (writeFails()) {
            ran = { data: null, error: writeErr() };
            return ran;
          }
          if (anon()) {
            // Like the UPDATE: RLS leaves the DELETE nothing to match.
            ran = { data: null, error: null };
            return ran;
          }
          // Another user's rows are hidden from the DELETE too (#111).
          store[table] = (store[table] ?? []).filter(
            (r) => !(visible(r) && dp.every((p) => p(r)))
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
  /**
   * The one auth call the engine makes. With a session, auth-js reads it from
   * storage and resolves it with no network I/O — signed in as
   * `sessionUserId`, asked on every call, so a test can switch users between
   * two calls; with none (`anonScoped` or `anonRejected`), the client above
   * has nothing to sign its requests with.
   */
  const auth = {
    getSession: async () =>
      opts.anonScoped || opts.anonRejected
        ? { data: { session: null }, error: ANON_REFRESH_ERROR }
        : { data: { session: fakeSession(sessionUser()) }, error: null },
  };
  return { from, auth };
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
 * `(supabase as any).from = makeSupabase(store, opts).from`. It installs
 * `auth` as well as `from`, and that hand-written swap does not: a
 * hand-assigned `.from` keeps whatever `auth` the last install set. So
 * `anonScoped` and `anonRejected` must go through `installSupabase`, or the
 * requests answer as nobody's while `auth.getSession()` still hands out a
 * session (#95, #109). So must `sessionUserId` (#111): a hand-assigned
 * `.from` answers as the new user while `auth` still vouches for the old one —
 * and the reverse.
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
    (supabase as any).auth = fake.auth;
    return fake;
  };
  installSupabase(opts);

  return { adapter, store, meta, installSupabase };
}

/**
 * Backs `getSyncMeta`/`setSyncMeta` with the adapter's own `sync_meta` table,
 * running the SQL lib/db.ts runs in the app, instead of wireSyncMocks'
 * in-memory map. Call it after wireSyncMocks; the map is not consulted again.
 *
 * Opt-in, for a test about what `wipeLocalData` leaves behind (#87). The wipe
 * deletes keys from that TABLE and the map never sees it, so under the default
 * wiring a cursor the wipe should have cleared survives into the re-download —
 * which then pulls from it, as no real device would — and a key it should have
 * spared looks spared whatever the wipe did.
 *
 * Returns synchronous accessors over the table for seeding and assertions.
 * `get` answers `undefined` for a missing key, as the map does.
 */
export function wireSqliteSyncMeta(adapter: ReturnType<typeof makeAdapter>) {
  (getSyncMeta as unknown as MockedFn).mockImplementation(async (k: string) => {
    const row = (await adapter.getFirstAsync(
      'SELECT value FROM sync_meta WHERE key = ?',
      [k]
    )) as { value: string } | null;
    return row?.value ?? null;
  });
  (setSyncMeta as unknown as MockedFn).mockImplementation(
    async (k: string, v: string) => {
      await adapter.runAsync(
        'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
        [k, v]
      );
    }
  );
  return {
    get: (k: string): string | undefined =>
      (
        adapter._sqlite
          .prepare('SELECT value FROM sync_meta WHERE key = ?')
          .get(k) as { value: string } | undefined
      )?.value,
    set: (k: string, v: string): void => {
      adapter._sqlite
        .prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)')
        .run(k, v);
    },
  };
}

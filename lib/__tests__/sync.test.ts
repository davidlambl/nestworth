// Sync engine tests. The DB layer is backed by a real in-memory SQLite
// (better-sqlite3) wrapped to expose the async expo-sqlite surface the sync
// code uses, so the actual UPSERT/reconcile SQL runs. Supabase is a small
// in-memory fake supporting the query chains the sync code builds.
//
// Mocks must be declared before importing '../sync' so its top-level
// `import { supabase } from './supabase'` / `import { getDb } from './db'`
// resolve to these stubs (and never pull native expo-sqlite / the real client).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import Database from 'better-sqlite3';
import { supabase } from '../supabase';
import { getDb, getSyncMeta, setSyncMeta } from '../db';
import {
  planTransactionReconcile,
  forceUpsertRemoteTransaction,
  forceUpsertRemoteAccount,
  upsertRemoteTransaction,
  wipeLocalData,
  resetLocalData,
  fullSync,
  pushChanges,
  type ReconcileLocalRow,
} from '../sync';

const SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, icon TEXT, initial_balance REAL DEFAULT 0, exclude_from_total INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, txn_date TEXT, payee TEXT, amount REAL, check_number TEXT, memo TEXT, status TEXT DEFAULT 'pending', transfer_link_id TEXT, receipt_path TEXT, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE transaction_splits (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, amount REAL, memo TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE recurring_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, frequency TEXT, next_date TEXT, end_date TEXT, template TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
`;

// --- expo-sqlite-shaped adapter over better-sqlite3 ---------------------------
function makeAdapter() {
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
type Store = Record<string, any[]>;
/** PostgREST renders timestamptz as '+00:00', never the 'Z' toISOString emits. */
function toPgTimestamp(iso: string): string {
  return iso.endsWith('Z') ? iso.slice(0, -1) + '+00:00' : iso;
}

function makeSupabase(
  store: Store,
  opts: {
    offline?: boolean;
    failWrites?: boolean;
    errorReadsOn?: Set<string>;
    /** Timestamp the server stamps onto UPDATEs, mirroring the Postgres trigger. */
    serverNow?: string;
    /**
     * Fires after the server has accepted an upsert but before the caller sees
     * the response — i.e. exactly the window in which a concurrent local edit
     * can land during push's network round trip. Lets a test drive that race
     * deterministically instead of hand-waving it.
     */
    onAfterUpsert?: (table: string) => Promise<void>;
  } = {}
) {
  const ERR = { message: 'network unreachable' };
  function from(table: string) {
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
      order: (col: string) => {
        orderCol = col;
        return builder;
      },
      limit: (_n: number) => builder,
      range: (a: number, b: number) =>
        Promise.resolve(
          opts.offline || opts.errorReadsOn?.has(table)
            ? { data: null, error: ERR }
            : { data: rows().slice(a, b + 1), error: null }
        ),
      then: (resolve: any, reject: any) =>
        Promise.resolve(
          opts.offline || opts.errorReadsOn?.has(table)
            ? { data: null, error: ERR }
            : { data: rows(), error: null }
        ).then(resolve, reject),
      // Mirrors Postgres: an UPDATE fires the BEFORE UPDATE trigger that
      // overwrites updated_at with server time, while an INSERT keeps the
      // client's value (the real trigger is UPDATE-only). `serverNow` lets a
      // test choose a timestamp OLDER than the client's, which is the drift
      // that used to strand a row permanently out of sync.
      upsert: (rowOrRows: any) => {
        let ran: { data: any; error: any } | null = null;
        const run = () => {
          if (ran) return ran;
          if (opts.offline || opts.failWrites) {
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
        // PostgREST returns only the requested columns. Modelling that matters:
        // with a permissive fake, narrowing .select('id, updated_at') to
        // .select('id') is invisible, and the read-back the fix depends on can
        // regress silently.
        const project = (rows: any[], cols?: string) => {
          if (!cols || cols.trim() === '*') return rows;
          const want = cols.split(',').map((c) => c.trim());
          return rows.map((r) =>
            Object.fromEntries(want.filter((c) => c in r).map((c) => [c, r[c]]))
          );
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
      insert: async (rowOrRows: any) => {
        if (opts.offline || opts.failWrites) return { data: null, error: ERR };
        const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        store[table] = store[table] ?? [];
        for (const row of incoming) store[table].push({ ...row });
        return { data: null, error: null };
      },
      delete: () => {
        const dp: ((r: any) => boolean)[] = [];
        const apply = () => ({
          then: (resolve: any) => {
            if (opts.offline || opts.failWrites) {
              return Promise.resolve({ data: null, error: ERR }).then(resolve);
            }
            store[table] = (store[table] ?? []).filter(
              (r) => !dp.every((p) => p(r))
            );
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        });
        return {
          eq: (col: string, val: any) => {
            dp.push((r) => r[col] === val);
            return apply();
          },
          in: (col: string, vals: any[]) => {
            const set = new Set(vals);
            dp.push((r) => set.has(r[col]));
            return apply();
          },
        };
      },
    };
    return builder;
  }
  return { from };
}

const TXN_COLS =
  'id,user_id,account_id,txn_date,payee,amount,check_number,memo,status,transfer_link_id,receipt_path,created_at,updated_at,_sync_status';

async function insertLocalTxn(adapter: any, t: any) {
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

function remoteTxn(t: any) {
  return {
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
  };
}

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let meta: Map<string, string>;

beforeEach(() => {
  adapter = makeAdapter();
  store = {
    accounts: [],
    transactions: [],
    transaction_splits: [],
    recurring_rules: [],
  };
  meta = new Map();
  (getDb as jest.Mock).mockImplementation(async () => adapter);
  (getSyncMeta as jest.Mock).mockImplementation(
    async (k: string) => meta.get(k) ?? null
  );
  (setSyncMeta as jest.Mock).mockImplementation(
    async (k: string, v: string) => {
      meta.set(k, v);
    }
  );
  (supabase as any).from = makeSupabase(store).from;
});

afterEach(() => {
  adapter._sqlite.close();
});

const local = (
  id: string,
  updated_at: string | null,
  _sync_status = 'synced',
  reconcilable = true
): ReconcileLocalRow => ({ id, updated_at, _sync_status, reconcilable });

describe('planTransactionReconcile', () => {
  it('heals a synced row that drifted to an OLDER server timestamp (the bug)', () => {
    // local cursor was newer than the corrected server row, so the incremental
    // pull never saw it; the planner must still flag it for refresh.
    const plan = planTransactionReconcile(
      [{ id: 'T', updated_at: '2026-04-01T00:00:00Z' }],
      [local('T', '2026-06-01T00:00:00Z')]
    );
    expect(plan.toRefresh).toEqual(['T']);
    expect(plan.toDelete).toEqual([]);
  });

  it('flags a row missing locally for refresh', () => {
    const plan = planTransactionReconcile(
      [{ id: 'T', updated_at: '2026-05-01T00:00:00Z' }],
      []
    );
    expect(plan.toRefresh).toEqual(['T']);
  });

  it('leaves in-sync rows untouched', () => {
    const plan = planTransactionReconcile(
      [{ id: 'T', updated_at: '2026-04-04T00:00:00Z' }],
      [local('T', '2026-04-04T00:00:00Z')]
    );
    expect(plan.toRefresh).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it('deletes a reconcilable synced row absent from the server', () => {
    const plan = planTransactionReconcile(
      [],
      [local('T', '2026-04-04T00:00:00Z')]
    );
    expect(plan.toDelete).toEqual(['T']);
    expect(plan.toRefresh).toEqual([]);
  });

  it('never deletes a row created/pushed mid-pull (not reconcilable)', () => {
    const plan = planTransactionReconcile(
      [],
      [local('T', '2026-06-30T00:00:00Z', 'synced', /* reconcilable */ false)]
    );
    expect(plan.toDelete).toEqual([]);
  });

  it('never refreshes or deletes rows with unsynced local edits', () => {
    const plan = planTransactionReconcile(
      [
        { id: 'P', updated_at: '2026-04-01T00:00:00Z' },
        { id: 'D', updated_at: '2026-04-01T00:00:00Z' },
      ],
      [
        local('P', '2026-06-01T00:00:00Z', 'pending'),
        local('D', '2026-06-01T00:00:00Z', 'deleted', false),
      ]
    );
    expect(plan.toRefresh).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});

describe('forceUpsertRemoteTransaction vs upsertRemoteTransaction', () => {
  it('normal upsert keeps the LWW guard: an OLDER remote does NOT overwrite a synced local row', async () => {
    await insertLocalTxn(adapter, {
      id: 'T',
      amount: 100,
      updated_at: '2026-06-01T00:00:00Z',
    });
    await upsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' })
    );
    const row: any = await adapter.getFirstAsync(
      'SELECT amount FROM transactions WHERE id = ?',
      ['T']
    );
    expect(row.amount).toBe(100); // guard blocked the older write — this is the bug source
  });

  it('force upsert overwrites a synced local row regardless of (older) timestamp', async () => {
    await insertLocalTxn(adapter, {
      id: 'T',
      amount: 100,
      updated_at: '2026-06-01T00:00:00Z',
    });
    await forceUpsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' })
    );
    const row: any = await adapter.getFirstAsync(
      'SELECT amount, updated_at FROM transactions WHERE id = ?',
      ['T']
    );
    expect(row.amount).toBe(50);
    expect(row.updated_at).toBe('2026-04-01T00:00:00Z');
  });

  it('force upsert refuses to clobber a pending local edit', async () => {
    await insertLocalTxn(adapter, {
      id: 'T',
      amount: 7,
      updated_at: '2026-06-01T00:00:00Z',
      _sync_status: 'pending',
    });
    await forceUpsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' })
    );
    const row: any = await adapter.getFirstAsync(
      'SELECT amount, _sync_status FROM transactions WHERE id = ?',
      ['T']
    );
    expect(row.amount).toBe(7);
    expect(row._sync_status).toBe('pending');
  });
});

describe('pullTransactions self-heal (end-to-end via fullSync)', () => {
  it('heals drift, pulls missing, deletes removed — even below the cursor', async () => {
    // Local (stale) state.
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 100,
      updated_at: '2026-06-01T00:00:00Z',
    }); // drifted (server corrected older)
    await insertLocalTxn(adapter, {
      id: 'T2',
      amount: 20,
      updated_at: '2026-04-04T00:00:00Z',
    }); // in sync
    await insertLocalTxn(adapter, {
      id: 'T4',
      amount: 5,
      updated_at: '2026-03-01T00:00:00Z',
    }); // removed on server

    // Server (authoritative) state.
    store.transactions = [
      remoteTxn({ id: 'T1', amount: 50, updated_at: '2026-04-01T00:00:00Z' }),
      remoteTxn({ id: 'T2', amount: 20, updated_at: '2026-04-04T00:00:00Z' }),
      remoteTxn({ id: 'T3', amount: 8, updated_at: '2026-05-01T00:00:00Z' }), // missing locally
    ];

    // Cursor newer than every server row → incremental pull fetches nothing;
    // only the reconcile pass can fix things. This is the exact failure mode.
    meta.set('last_pull_at:u', '2026-06-15T00:00:00Z');
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await fullSync('u');

    const byId: Record<string, any> = {};
    for (const r of await adapter.getAllAsync(
      'SELECT id, amount FROM transactions',
      []
    )) {
      byId[(r as any).id] = (r as any).amount;
    }
    expect(byId['T1']).toBe(50); // healed (older-timestamp correction applied)
    expect(byId['T2']).toBe(20); // untouched
    expect(byId['T3']).toBe(8); // pulled despite being older than the cursor
    expect(byId['T4']).toBeUndefined(); // deleted (gone from server)
  });
});

describe('wipeLocalData', () => {
  it('clears every table and the sync cursor', async () => {
    await insertLocalTxn(adapter, { id: 'T1', amount: 1 });
    await adapter.runAsync(
      'INSERT INTO accounts (id,user_id,name,type) VALUES (?,?,?,?)',
      ['a1', 'u', 'Acct', 'checking']
    );
    await adapter.runAsync(
      'INSERT INTO transaction_splits (id,transaction_id,amount) VALUES (?,?,?)',
      ['s1', 'T1', 1]
    );
    await adapter.runAsync('INSERT INTO sync_meta (key,value) VALUES (?,?)', [
      'last_pull_at:u',
      'x',
    ]);

    await wipeLocalData(adapter);

    for (const t of [
      'accounts',
      'transactions',
      'transaction_splits',
      'recurring_rules',
      'sync_meta',
    ]) {
      const row: any = await adapter.getFirstAsync(
        `SELECT COUNT(*) AS c FROM ${t}`,
        []
      );
      expect(row.c).toBe(0);
    }
  });
});

describe('resetLocalData', () => {
  it('discards local-only drift and re-downloads the cloud truth', async () => {
    // Local: one stale extra txn the server no longer has, plus a stale copy.
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 999,
      updated_at: '2026-06-01T00:00:00Z',
    });
    await insertLocalTxn(adapter, {
      id: 'TX',
      amount: 42,
      updated_at: '2026-06-01T00:00:00Z',
    });

    // Server truth.
    store.accounts = [
      {
        id: 'a1',
        user_id: 'u',
        name: 'PNC',
        type: 'checking',
        icon: null,
        initial_balance: 0,
        exclude_from_total: false,
        sort_order: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    store.transactions = [
      remoteTxn({ id: 'T1', amount: 50, updated_at: '2026-04-01T00:00:00Z' }),
    ];
    meta.set('last_pull_at:u', '2026-06-15T00:00:00Z');
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await resetLocalData('u');

    const txns = await adapter.getAllAsync(
      'SELECT id, amount FROM transactions ORDER BY id',
      []
    );
    expect(txns).toEqual([{ id: 'T1', amount: 50 }]); // TX gone, T1 = cloud value
    const accts = await adapter.getAllAsync('SELECT id FROM accounts', []);
    expect(accts).toEqual([{ id: 'a1' }]);
    expect(meta.get('last_pull_at:u')).toBeTruthy(); // re-bootstrapped
  });
});

describe('pullTableFull self-heal (accounts) — end-to-end via fullSync', () => {
  it('heals an account corrected with an OLDER server timestamp', async () => {
    // Synced locally with a NEWER timestamp than the server's correction, so the
    // guarded upsert would refuse it forever — the same bug class as transactions,
    // and balance-affecting (initial_balance feeds every total).
    await adapter.runAsync(
      `INSERT INTO accounts
         (id,user_id,name,type,icon,initial_balance,exclude_from_total,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'synced')`,
      [
        'a1',
        'u',
        'PNC',
        'checking',
        null,
        0,
        0,
        0,
        0,
        '2026-01-01T00:00:00Z',
        '2026-06-01T00:00:00Z',
      ]
    );
    store.accounts = [
      {
        id: 'a1',
        user_id: 'u',
        name: 'PNC',
        type: 'checking',
        icon: null,
        initial_balance: 500,
        exclude_from_total: false,
        sort_order: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
      },
    ];
    meta.set('last_pull_at:u', '2026-06-15T00:00:00Z');
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await fullSync('u');

    const acct: any = await adapter.getFirstAsync(
      'SELECT initial_balance, updated_at FROM accounts WHERE id = ?',
      ['a1']
    );
    expect(acct.initial_balance).toBe(500); // healed despite the older server timestamp
    expect(acct.updated_at).toBe('2026-04-01T00:00:00Z');
  });
});

describe('forceUpsertRemoteAccount', () => {
  it('overwrites a synced account regardless of (older) timestamp', async () => {
    await adapter.runAsync(
      `INSERT INTO accounts
         (id,user_id,name,type,icon,initial_balance,exclude_from_total,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'synced')`,
      [
        'a1',
        'u',
        'Old',
        'checking',
        null,
        0,
        0,
        0,
        0,
        '2026-01-01T00:00:00Z',
        '2026-06-01T00:00:00Z',
      ]
    );
    await forceUpsertRemoteAccount(adapter, {
      id: 'a1',
      user_id: 'u',
      name: 'New',
      type: 'checking',
      icon: null,
      initial_balance: 500,
      exclude_from_total: false,
      sort_order: 0,
      is_archived: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    });
    const acct: any = await adapter.getFirstAsync(
      'SELECT name, initial_balance FROM accounts WHERE id = ?',
      ['a1']
    );
    expect(acct.name).toBe('New');
    expect(acct.initial_balance).toBe(500);
  });

  it('refuses to clobber a pending local account edit', async () => {
    await adapter.runAsync(
      `INSERT INTO accounts
         (id,user_id,name,type,icon,initial_balance,exclude_from_total,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      [
        'a1',
        'u',
        'My Edit',
        'checking',
        null,
        7,
        0,
        0,
        0,
        '2026-01-01T00:00:00Z',
        '2026-06-01T00:00:00Z',
      ]
    );
    await forceUpsertRemoteAccount(adapter, {
      id: 'a1',
      user_id: 'u',
      name: 'Server',
      type: 'checking',
      icon: null,
      initial_balance: 500,
      exclude_from_total: false,
      sort_order: 0,
      is_archived: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    });
    const acct: any = await adapter.getFirstAsync(
      'SELECT name, initial_balance, _sync_status FROM accounts WHERE id = ?',
      ['a1']
    );
    expect(acct.name).toBe('My Edit'); // unsynced edit preserved
    expect(acct.initial_balance).toBe(7);
    expect(acct._sync_status).toBe('pending');
  });
});

describe('resetLocalData safety', () => {
  it('aborts WITHOUT wiping when the cloud is unreachable', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 42,
      updated_at: '2026-06-01T00:00:00Z',
    });
    // Every Supabase read/write errors (offline / expired session). The pre-wipe
    // probe must catch this and bail before wipeLocalData runs.
    (supabase as any).from = makeSupabase(store, { offline: true }).from;

    await expect(resetLocalData('u')).rejects.toThrow(/reach the cloud/i);

    const txns = await adapter.getAllAsync(
      'SELECT id, amount FROM transactions',
      []
    );
    expect(txns).toEqual([{ id: 'T1', amount: 42 }]); // wipe never ran
  });

  it('refuses to run while a sync already holds the lock (no wipe race)', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 42,
      updated_at: '2026-06-01T00:00:00Z',
    });
    store.transactions = [
      remoteTxn({ id: 'T1', amount: 42, updated_at: '2026-06-01T00:00:00Z' }),
    ];

    // Start a sync but don't await it — fullSync grabs _syncInProgress
    // synchronously, before its first await. A reset that didn't hold the lock
    // end-to-end could wipe + no-op its re-bootstrap under this; it must refuse.
    const inflight = fullSync('u');
    await expect(resetLocalData('u')).rejects.toThrow(/in progress/i);
    await inflight;

    const row: any = await adapter.getFirstAsync(
      'SELECT amount FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(row.amount).toBe(42); // never wiped
  });

  it('refuses to wipe when a pending edit failed to upload', async () => {
    // A pending local edit, plus writes that fail — push silently leaves the
    // row 'pending'. Wiping now would lose an edit that never reached the cloud.
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 99,
      updated_at: '2026-06-01T00:00:00Z',
      _sync_status: 'pending',
    });
    (supabase as any).from = makeSupabase(store, { failWrites: true }).from;

    await expect(resetLocalData('u')).rejects.toThrow(/unsynced|upload/i);

    const row: any = await adapter.getFirstAsync(
      'SELECT amount, _sync_status FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(row.amount).toBe(99); // the unsynced edit survives
    expect(row._sync_status).toBe('pending');
  });

  it('reports failure and leaves the cursor unset when the re-download fails', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 42,
      updated_at: '2026-06-01T00:00:00Z',
    });
    store.accounts = [
      {
        id: 'a1',
        user_id: 'u',
        name: 'A',
        type: 'checking',
        icon: null,
        initial_balance: 0,
        exclude_from_total: false,
        sort_order: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    // Probe (accounts read) and push succeed, but the transactions download
    // errors after the wipe. throwOnError must surface that as a failed reset.
    (supabase as any).from = makeSupabase(store, {
      errorReadsOn: new Set(['transactions']),
    }).from;

    await expect(resetLocalData('u')).rejects.toThrow(/download/i);

    // Cursor stays unset so the next launch re-bootstraps via initialPull,
    // rather than trusting a partially-empty cache.
    expect(meta.get('last_pull_at:u')).toBeFalsy();
    expect(meta.get('last_txn_pull_at:u')).toBeFalsy();
  });
});

describe('push adopts the server timestamp (root cause of reconcile churn)', () => {
  // Postgres overwrites updated_at via a BEFORE UPDATE trigger. Before this
  // fix, push never read the row back, so a row became 'synced' still holding
  // the CLIENT's timestamp while the server held a different one — meaning
  // every edited row disagreed with the server and the reconcile pass
  // re-fetched it on the next sync. These assert the disagreement is gone.
  const SERVER_NOW = '2026-06-01T12:00:00Z';

  async function pushEditedTxn(serverNow: string) {
    store.accounts = [];
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: '2026-05-01T00:00:00Z' }),
    ];
    (supabase as any).from = makeSupabase(store, { serverNow }).from;

    // A local edit: newer client timestamp, marked pending.
    await insertLocalTxn(adapter, {
      id: 'T1',
      payee: 'Edited',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    const localRow: any = await adapter.getFirstAsync(
      'SELECT updated_at, _sync_status FROM transactions WHERE id = ?',
      ['T1']
    );
    const remoteRow = store.transactions.find((r: any) => r.id === 'T1');
    return { localRow, remoteRow };
  }

  it('leaves local and server timestamps equal after pushing an edit', async () => {
    const { localRow, remoteRow } = await pushEditedTxn(SERVER_NOW);

    expect(localRow._sync_status).toBe('synced');
    expect(localRow.updated_at).toBe(SERVER_NOW);
    expect(localRow.updated_at).toBe(remoteRow.updated_at);
  });

  it('agrees even when the server stamp is OLDER than the client edit', async () => {
    // The case that stranded rows permanently: a device clock ahead of the
    // server made the stored timestamp look older, which the incremental pull
    // (updated_at > cursor) could never surface.
    const OLDER = '2026-04-01T00:00:00Z';
    const { localRow, remoteRow } = await pushEditedTxn(OLDER);

    expect(localRow.updated_at).toBe(OLDER);
    expect(localRow.updated_at).toBe(remoteRow.updated_at);
  });

  it('produces nothing for the reconcile pass to refresh', async () => {
    // The observable payoff: with timestamps agreeing, a pushed edit is no
    // longer seen as drifted, so it is not re-fetched on the next sync.
    const { localRow, remoteRow } = await pushEditedTxn(SERVER_NOW);

    const plan = planTransactionReconcile(
      [{ id: 'T1', updated_at: remoteRow.updated_at }],
      [local('T1', localRow.updated_at)]
    );
    expect(plan.toRefresh).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it('does the same for accounts, which go through pushTable', async () => {
    store.accounts = [
      {
        id: 'A1',
        user_id: 'u',
        name: 'Checking',
        type: 'checking',
        icon: null,
        initial_balance: 0,
        exclude_from_total: false,
        sort_order: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ];
    (supabase as any).from = makeSupabase(store, {
      serverNow: SERVER_NOW,
    }).from;

    await adapter.runAsync(
      `INSERT INTO accounts (id,user_id,name,type,initial_balance,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        'A1',
        'u',
        'Renamed',
        'checking',
        0,
        0,
        0,
        '2026-01-01T00:00:00Z',
        '2026-05-02T00:00:00Z',
        'pending',
      ]
    );

    await pushChanges('u');

    const row: any = await adapter.getFirstAsync(
      'SELECT updated_at, _sync_status FROM accounts WHERE id = ?',
      ['A1']
    );
    expect(row._sync_status).toBe('synced');
    expect(row.updated_at).toBe(SERVER_NOW);
    expect(row.updated_at).toBe(
      store.accounts.find((r: any) => r.id === 'A1').updated_at
    );
  });

  it('adopts the server rendering when pushing a brand-new row (INSERT path)', async () => {
    // A row created offline has never been on the server, so the upsert INSERTs
    // and the UPDATE trigger never fires — the server keeps the client's
    // instant but returns it in PostgREST's rendering ('+00:00', not 'Z').
    // The client must adopt that rendering, because the reconcile pass compares
    // timestamps by STRING equality; keeping the local 'Z' form would make
    // every newly created row look drifted forever.
    store.transactions = [];
    (supabase as any).from = makeSupabase(store, {
      serverNow: SERVER_NOW,
    }).from;

    await insertLocalTxn(adapter, {
      id: 'T4',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    const localRow: any = await adapter.getFirstAsync(
      'SELECT updated_at, _sync_status FROM transactions WHERE id = ?',
      ['T4']
    );
    const remoteRow: any = store.transactions.find((r: any) => r.id === 'T4');

    expect(localRow._sync_status).toBe('synced');
    expect(remoteRow.updated_at).toBe('2026-05-02T00:00:00+00:00');
    expect(localRow.updated_at).toBe(remoteRow.updated_at);

    // And therefore nothing for the reconcile pass to do.
    expect(
      planTransactionReconcile(
        [{ id: 'T4', updated_at: remoteRow.updated_at }],
        [local('T4', localRow.updated_at)]
      )
    ).toEqual({ toRefresh: [], toDelete: [] });
  });

  it('still refuses to mark synced when a newer local edit lands mid-push', async () => {
    // The pre-existing clobber guard must survive the change: the mark-synced
    // UPDATE is keyed on the updated_at that push READ, so an edit arriving
    // during the round trip stays pending for the next push instead of being
    // silently marked synced (which would leave it unpushed, then overwritten
    // by a later pull — a lost user edit).
    //
    // The edit is injected from inside the fake, in the window after the server
    // accepts the write and before push runs its guarded UPDATE. Bumping the
    // row before calling pushChanges would not test anything: push would simply
    // read the newer row and legitimately sync it.
    store.transactions = [
      remoteTxn({ id: 'T2', updated_at: '2026-05-01T00:00:00Z' }),
    ];
    (supabase as any).from = makeSupabase(store, {
      serverNow: SERVER_NOW,
      onAfterUpsert: async () => {
        await adapter.runAsync(
          `UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          ['2026-05-03T00:00:00Z', 'T2']
        );
      },
    }).from;

    await insertLocalTxn(adapter, {
      id: 'T2',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    const row: any = await adapter.getFirstAsync(
      'SELECT updated_at, _sync_status FROM transactions WHERE id = ?',
      ['T2']
    );
    expect(row._sync_status).toBe('pending');
    expect(row.updated_at).toBe('2026-05-03T00:00:00Z');
  });

  it('applies the same mid-push guard on the pushTable path (accounts)', async () => {
    store.accounts = [
      {
        id: 'A2',
        user_id: 'u',
        name: 'Checking',
        type: 'checking',
        icon: null,
        initial_balance: 0,
        exclude_from_total: false,
        sort_order: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ];
    (supabase as any).from = makeSupabase(store, {
      serverNow: SERVER_NOW,
      onAfterUpsert: async () => {
        await adapter.runAsync(
          `UPDATE accounts SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          ['2026-05-03T00:00:00Z', 'A2']
        );
      },
    }).from;

    await adapter.runAsync(
      `INSERT INTO accounts (id,user_id,name,type,initial_balance,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        'A2',
        'u',
        'Renamed',
        'checking',
        0,
        0,
        0,
        '2026-01-01T00:00:00Z',
        '2026-05-02T00:00:00Z',
        'pending',
      ]
    );

    await pushChanges('u');

    const row: any = await adapter.getFirstAsync(
      'SELECT updated_at, _sync_status FROM accounts WHERE id = ?',
      ['A2']
    );
    expect(row._sync_status).toBe('pending');
    expect(row.updated_at).toBe('2026-05-03T00:00:00Z');
  });

  it('does not resurrect a row deleted mid-push', async () => {
    // The guard's other half: mark-synced is also keyed on the row still being
    // 'pending'. If the user deletes the row while its edit is in flight, the
    // push must not flip that 'deleted' marker back to 'synced' — doing so
    // would strand the deletion locally and let the row reappear on next pull.
    store.transactions = [
      remoteTxn({ id: 'T3', updated_at: '2026-05-01T00:00:00Z' }),
    ];
    (supabase as any).from = makeSupabase(store, {
      serverNow: SERVER_NOW,
      onAfterUpsert: async (table) => {
        if (table !== 'transactions') return;
        await adapter.runAsync(
          `UPDATE transactions SET _sync_status = 'deleted' WHERE id = ?`,
          ['T3']
        );
      },
    }).from;

    await insertLocalTxn(adapter, {
      id: 'T3',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    const row: any = await adapter.getFirstAsync(
      'SELECT _sync_status FROM transactions WHERE id = ?',
      ['T3']
    );
    // Either the delete was carried out (row gone) or it is still queued as a
    // delete — but never silently downgraded back to 'synced'.
    expect(row === null || row._sync_status === 'deleted').toBe(true);
  });
});

describe('pullTransactions split refresh', () => {
  it('keeps local splits when the remote split fetch fails (no delete-before-confirm)', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 30,
      updated_at: '2026-06-01T00:00:00Z',
    });
    await adapter.runAsync(
      "INSERT INTO transaction_splits (id, transaction_id, amount, memo, _sync_status) VALUES (?,?,?,?, 'synced')",
      ['s1', 'T1', 30, 'groceries']
    );
    store.transactions = [
      remoteTxn({ id: 'T1', amount: 30, updated_at: '2026-06-01T00:00:00Z' }),
    ];
    // The splits endpoint errors; everything else is reachable.
    (supabase as any).from = makeSupabase(store, {
      errorReadsOn: new Set(['transaction_splits']),
    }).from;

    await fullSync('u');

    // Old code deleted local synced splits BEFORE the (failing) fetch, losing
    // them; the fix fetches first, so the split survives.
    const split: any = await adapter.getFirstAsync(
      'SELECT id, amount FROM transaction_splits WHERE id = ?',
      ['s1']
    );
    expect(split).toEqual({ id: 's1', amount: 30 });
  });
});

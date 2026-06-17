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
      return { lastInsertRowId: Number(info.lastInsertRowid), changes: info.changes };
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
function makeSupabase(store: Store, opts: { offline?: boolean } = {}) {
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
          opts.offline
            ? { data: null, error: ERR }
            : { data: rows().slice(a, b + 1), error: null }
        ),
      then: (resolve: any, reject: any) =>
        Promise.resolve(
          opts.offline ? { data: null, error: ERR } : { data: rows(), error: null }
        ).then(resolve, reject),
      upsert: async (rowOrRows: any) => {
        if (opts.offline) return { data: null, error: ERR };
        const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        store[table] = store[table] ?? [];
        for (const row of incoming) {
          const i = store[table].findIndex((r) => r.id === row.id);
          if (i >= 0) store[table][i] = { ...store[table][i], ...row };
          else store[table].push({ ...row });
        }
        return { data: null, error: null };
      },
      insert: async (rowOrRows: any) => {
        if (opts.offline) return { data: null, error: ERR };
        const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        store[table] = store[table] ?? [];
        for (const row of incoming) store[table].push({ ...row });
        return { data: null, error: null };
      },
      delete: () => {
        const dp: ((r: any) => boolean)[] = [];
        const apply = () => ({
          then: (resolve: any) => {
            if (opts.offline) {
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
      t.id, t.user_id ?? 'u', t.account_id ?? 'a1', t.txn_date ?? '2026-01-01',
      t.payee ?? 'Payee', t.amount ?? 0, t.check_number ?? null, t.memo ?? null,
      t.status ?? 'cleared', t.transfer_link_id ?? null, t.receipt_path ?? null,
      t.created_at ?? '2026-01-01T00:00:00Z', t.updated_at ?? '2026-01-01T00:00:00Z',
      t._sync_status ?? 'synced',
    ]
  );
}

function remoteTxn(t: any) {
  return {
    id: t.id, user_id: t.user_id ?? 'u', account_id: t.account_id ?? 'a1',
    txn_date: t.txn_date ?? '2026-01-01', payee: t.payee ?? 'Payee',
    amount: t.amount ?? 0, check_number: t.check_number ?? null, memo: t.memo ?? null,
    status: t.status ?? 'cleared', transfer_link_id: t.transfer_link_id ?? null,
    receipt_path: t.receipt_path ?? null, created_at: t.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: t.updated_at ?? '2026-01-01T00:00:00Z',
  };
}

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let meta: Map<string, string>;

beforeEach(() => {
  adapter = makeAdapter();
  store = { accounts: [], transactions: [], transaction_splits: [], recurring_rules: [] };
  meta = new Map();
  (getDb as jest.Mock).mockImplementation(async () => adapter);
  (getSyncMeta as jest.Mock).mockImplementation(async (k: string) => meta.get(k) ?? null);
  (setSyncMeta as jest.Mock).mockImplementation(async (k: string, v: string) => {
    meta.set(k, v);
  });
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
    const plan = planTransactionReconcile([], [local('T', '2026-04-04T00:00:00Z')]);
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
      [{ id: 'P', updated_at: '2026-04-01T00:00:00Z' }, { id: 'D', updated_at: '2026-04-01T00:00:00Z' }],
      [local('P', '2026-06-01T00:00:00Z', 'pending'), local('D', '2026-06-01T00:00:00Z', 'deleted', false)]
    );
    expect(plan.toRefresh).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});

describe('forceUpsertRemoteTransaction vs upsertRemoteTransaction', () => {
  it('normal upsert keeps the LWW guard: an OLDER remote does NOT overwrite a synced local row', async () => {
    await insertLocalTxn(adapter, { id: 'T', amount: 100, updated_at: '2026-06-01T00:00:00Z' });
    await upsertRemoteTransaction(adapter, remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' }));
    const row: any = await adapter.getFirstAsync('SELECT amount FROM transactions WHERE id = ?', ['T']);
    expect(row.amount).toBe(100); // guard blocked the older write — this is the bug source
  });

  it('force upsert overwrites a synced local row regardless of (older) timestamp', async () => {
    await insertLocalTxn(adapter, { id: 'T', amount: 100, updated_at: '2026-06-01T00:00:00Z' });
    await forceUpsertRemoteTransaction(adapter, remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' }));
    const row: any = await adapter.getFirstAsync('SELECT amount, updated_at FROM transactions WHERE id = ?', ['T']);
    expect(row.amount).toBe(50);
    expect(row.updated_at).toBe('2026-04-01T00:00:00Z');
  });

  it('force upsert refuses to clobber a pending local edit', async () => {
    await insertLocalTxn(adapter, { id: 'T', amount: 7, updated_at: '2026-06-01T00:00:00Z', _sync_status: 'pending' });
    await forceUpsertRemoteTransaction(adapter, remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' }));
    const row: any = await adapter.getFirstAsync('SELECT amount, _sync_status FROM transactions WHERE id = ?', ['T']);
    expect(row.amount).toBe(7);
    expect(row._sync_status).toBe('pending');
  });
});

describe('pullTransactions self-heal (end-to-end via fullSync)', () => {
  it('heals drift, pulls missing, deletes removed — even below the cursor', async () => {
    // Local (stale) state.
    await insertLocalTxn(adapter, { id: 'T1', amount: 100, updated_at: '2026-06-01T00:00:00Z' }); // drifted (server corrected older)
    await insertLocalTxn(adapter, { id: 'T2', amount: 20, updated_at: '2026-04-04T00:00:00Z' });  // in sync
    await insertLocalTxn(adapter, { id: 'T4', amount: 5, updated_at: '2026-03-01T00:00:00Z' });   // removed on server

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
    for (const r of await adapter.getAllAsync('SELECT id, amount FROM transactions', [])) {
      byId[(r as any).id] = (r as any).amount;
    }
    expect(byId['T1']).toBe(50);          // healed (older-timestamp correction applied)
    expect(byId['T2']).toBe(20);          // untouched
    expect(byId['T3']).toBe(8);           // pulled despite being older than the cursor
    expect(byId['T4']).toBeUndefined();   // deleted (gone from server)
  });
});

describe('wipeLocalData', () => {
  it('clears every table and the sync cursor', async () => {
    await insertLocalTxn(adapter, { id: 'T1', amount: 1 });
    await adapter.runAsync(
      'INSERT INTO accounts (id,user_id,name,type) VALUES (?,?,?,?)',
      ['a1', 'u', 'Acct', 'checking']
    );
    await adapter.runAsync('INSERT INTO transaction_splits (id,transaction_id,amount) VALUES (?,?,?)', ['s1', 'T1', 1]);
    await adapter.runAsync('INSERT INTO sync_meta (key,value) VALUES (?,?)', ['last_pull_at:u', 'x']);

    await wipeLocalData(adapter);

    for (const t of ['accounts', 'transactions', 'transaction_splits', 'recurring_rules', 'sync_meta']) {
      const row: any = await adapter.getFirstAsync(`SELECT COUNT(*) AS c FROM ${t}`, []);
      expect(row.c).toBe(0);
    }
  });
});

describe('resetLocalData', () => {
  it('discards local-only drift and re-downloads the cloud truth', async () => {
    // Local: one stale extra txn the server no longer has, plus a stale copy.
    await insertLocalTxn(adapter, { id: 'T1', amount: 999, updated_at: '2026-06-01T00:00:00Z' });
    await insertLocalTxn(adapter, { id: 'TX', amount: 42, updated_at: '2026-06-01T00:00:00Z' });

    // Server truth.
    store.accounts = [
      {
        id: 'a1', user_id: 'u', name: 'PNC', type: 'checking', icon: null,
        initial_balance: 0, exclude_from_total: false, sort_order: 0,
        is_archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    store.transactions = [remoteTxn({ id: 'T1', amount: 50, updated_at: '2026-04-01T00:00:00Z' })];
    meta.set('last_pull_at:u', '2026-06-15T00:00:00Z');
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await resetLocalData('u');

    const txns = await adapter.getAllAsync('SELECT id, amount FROM transactions ORDER BY id', []);
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
      ['a1', 'u', 'PNC', 'checking', null, 0, 0, 0, 0, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']
    );
    store.accounts = [
      {
        id: 'a1', user_id: 'u', name: 'PNC', type: 'checking', icon: null,
        initial_balance: 500, exclude_from_total: false, sort_order: 0,
        is_archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
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
      ['a1', 'u', 'Old', 'checking', null, 0, 0, 0, 0, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']
    );
    await forceUpsertRemoteAccount(adapter, {
      id: 'a1', user_id: 'u', name: 'New', type: 'checking', icon: null,
      initial_balance: 500, exclude_from_total: false, sort_order: 0,
      is_archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    });
    const acct: any = await adapter.getFirstAsync('SELECT name, initial_balance FROM accounts WHERE id = ?', ['a1']);
    expect(acct.name).toBe('New');
    expect(acct.initial_balance).toBe(500);
  });

  it('refuses to clobber a pending local account edit', async () => {
    await adapter.runAsync(
      `INSERT INTO accounts
         (id,user_id,name,type,icon,initial_balance,exclude_from_total,sort_order,is_archived,created_at,updated_at,_sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      ['a1', 'u', 'My Edit', 'checking', null, 7, 0, 0, 0, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']
    );
    await forceUpsertRemoteAccount(adapter, {
      id: 'a1', user_id: 'u', name: 'Server', type: 'checking', icon: null,
      initial_balance: 500, exclude_from_total: false, sort_order: 0,
      is_archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
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
    await insertLocalTxn(adapter, { id: 'T1', amount: 42, updated_at: '2026-06-01T00:00:00Z' });
    // Every Supabase read/write errors (offline / expired session). The pre-wipe
    // probe must catch this and bail before wipeLocalData runs.
    (supabase as any).from = makeSupabase(store, { offline: true }).from;

    await expect(resetLocalData('u')).rejects.toThrow(/reach the cloud/i);

    const txns = await adapter.getAllAsync('SELECT id, amount FROM transactions', []);
    expect(txns).toEqual([{ id: 'T1', amount: 42 }]); // wipe never ran
  });

  it('refuses to run while a sync already holds the lock (no wipe race)', async () => {
    await insertLocalTxn(adapter, { id: 'T1', amount: 42, updated_at: '2026-06-01T00:00:00Z' });
    store.transactions = [remoteTxn({ id: 'T1', amount: 42, updated_at: '2026-06-01T00:00:00Z' })];

    // Start a sync but don't await it — fullSync grabs _syncInProgress
    // synchronously, before its first await. A reset that didn't hold the lock
    // end-to-end could wipe + no-op its re-bootstrap under this; it must refuse.
    const inflight = fullSync('u');
    await expect(resetLocalData('u')).rejects.toThrow(/in progress/i);
    await inflight;

    const row: any = await adapter.getFirstAsync('SELECT amount FROM transactions WHERE id = ?', ['T1']);
    expect(row.amount).toBe(42); // never wiped
  });
});

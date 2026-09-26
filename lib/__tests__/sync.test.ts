// Sync engine tests. The in-memory SQLite adapter and the PostgREST-ish
// Supabase fake both live in `lib/testing/syncFixture.ts` so the other sync
// suites can build on the same shapes; see that file for what each one models.
//
// Mocks must be declared before importing '../sync' (and before the fixture,
// which imports the same two modules) so their top-level
// `import { supabase } from './supabase'` / `import { getDb } from './db'`
// resolve to these stubs (and never pull native expo-sqlite / the real client).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { supabase } from '../supabase';
import {
  planTransactionReconcile,
  forceUpsertRemoteTransaction,
  forceUpsertRemoteAccount,
  upsertRemoteTransaction,
  wipeLocalData,
  resetLocalData,
  fullSync,
  needsInitialPull,
  pushChanges,
  type ReconcileLocalRow,
} from '../sync';
import {
  makeAdapter,
  makeSupabase,
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  wireSqliteSyncMeta,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let meta: Map<string, string>;
let installSupabase: ReturnType<typeof wireSyncMocks>['installSupabase'];

beforeEach(() => {
  ({ adapter, store, meta, installSupabase } = wireSyncMocks());
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
    // The server still has KEEP, so the enumeration is non-empty and IS
    // authority to delete. It cannot be `remote: []` any more: since #19 an
    // empty enumeration never deletes, so that version of this test would now
    // pass vacuously and stop proving absence-based deletion at all.
    const plan = planTransactionReconcile(
      [{ id: 'KEEP', updated_at: '2026-04-04T00:00:00Z' }],
      [
        local('T', '2026-04-04T00:00:00Z'),
        local('KEEP', '2026-04-04T00:00:00Z'),
      ]
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

  // A pin of the contract #136 changed: the force upsert used to write the
  // server's stamp too, which is what let a reconcile stopped before its split
  // writes leave a parent matching the server over the wrong splits.
  it("force upsert overwrites a synced local row's fields regardless of (older) timestamp, and leaves the placeholder stamp on both paths (pin)", async () => {
    await insertLocalTxn(adapter, {
      id: 'T',
      amount: 100,
      updated_at: '2026-06-01T00:00:00Z',
    });
    await forceUpsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T', amount: 50, updated_at: '2026-04-01T00:00:00Z' })
    );
    // The insert path: a row this device does not hold.
    await forceUpsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'N', amount: 8, updated_at: '2026-04-01T00:00:00Z' })
    );
    const row = (id: string) =>
      adapter.getFirstAsync(
        'SELECT amount, updated_at, _sync_status FROM transactions WHERE id = ?',
        [id]
      );
    // '' until the reconcile has replaced the splits and adopts the server's
    // stamp itself (syncReconcileAdoptLast.test.ts).
    expect(await row('T')).toEqual({
      amount: 50,
      updated_at: '',
      _sync_status: 'synced',
    });
    expect(await row('N')).toEqual({
      amount: 8,
      updated_at: '',
      _sync_status: 'synced',
    });
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

// Two accounts signed in on one device (#87). Row ids start with the user id
// ('a-txn', 'b-acct-pending'), and a user's sync_meta keys are `<key>:<user>`:
// the four below are every key the engine keeps (#66 added the attempt).
const META_KEYS = [
  'last_pull_at',
  'last_pull_attempt_at',
  'last_txn_pull_at',
  'last_txn_reconcile_at',
] as const;

/** A synced row in every table, the split riding a synced parent. */
async function seedSyncedRows(u: string) {
  await insertLocalAccount(adapter, { id: `${u}-acct`, user_id: u });
  await insertLocalTxn(adapter, {
    id: `${u}-txn`,
    user_id: u,
    account_id: `${u}-acct`,
  });
  await insertLocalSplit(adapter, {
    id: `${u}-split`,
    transaction_id: `${u}-txn`,
  });
  await insertLocalRule(adapter, {
    id: `${u}-rule`,
    user_id: u,
    account_id: `${u}-acct`,
  });
}

/**
 * An unsynced row in every table, all in the one state, so each of the guard's
 * eight arms (four tables, 'pending' and 'deleted') has a row of its own. The
 * split rides a parent in the same state, as after an offline split edit or an
 * offline delete (useDeleteTransaction marks the splits with their parent).
 */
async function seedUnsyncedRows(u: string, status: 'pending' | 'deleted') {
  await insertLocalAccount(adapter, {
    id: `${u}-acct-${status}`,
    user_id: u,
    _sync_status: status,
  });
  await insertLocalTxn(adapter, {
    id: `${u}-txn-${status}`,
    user_id: u,
    account_id: `${u}-acct`,
    _sync_status: status,
  });
  await insertLocalSplit(adapter, {
    id: `${u}-split-${status}`,
    transaction_id: `${u}-txn-${status}`,
    _sync_status: status,
  });
  await insertLocalRule(adapter, {
    id: `${u}-rule-${status}`,
    user_id: u,
    account_id: `${u}-acct`,
    _sync_status: status,
  });
}

/**
 * Every local row of `u`'s, whole. Splits are found through their parent,
 * which is all that ties a split to a user — so this cannot see a split whose
 * parent is gone; `idsIn` can.
 */
function rowsOf(u: string) {
  const all = (sql: string) => adapter._sqlite.prepare(sql).all(u);
  return {
    accounts: all('SELECT * FROM accounts WHERE user_id = ? ORDER BY id'),
    transactions: all(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY id'
    ),
    transaction_splits: all(
      `SELECT ts.* FROM transaction_splits ts
       INNER JOIN transactions tx ON tx.id = ts.transaction_id
       WHERE tx.user_id = ? ORDER BY ts.id`
    ),
    recurring_rules: all(
      'SELECT * FROM recurring_rules WHERE user_id = ? ORDER BY id'
    ),
  };
}

/** Every id in a table, whoever it belongs to — an orphaned split included. */
function idsIn(table: string): string[] {
  const rows = adapter._sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

describe('wipeLocalData', () => {
  it("clears one user's rows and keys, and nothing of another user's", async () => {
    const metaTable = wireSqliteSyncMeta(adapter);
    await seedSyncedRows('a');
    await seedSyncedRows('b');
    await seedUnsyncedRows('b', 'pending');
    await seedUnsyncedRows('b', 'deleted');
    for (const u of ['a', 'b']) {
      for (const k of META_KEYS) metaTable.set(`${k}:${u}`, `${k} of ${u}`);
    }
    const bBefore = rowsOf('b');

    await wipeLocalData(adapter, 'a');

    // Read by id, not through the parent: a split of a's left behind would be
    // an orphan, and a join would hide it.
    for (const [table, id] of [
      ['accounts', 'b-acct'],
      ['transactions', 'b-txn'],
      ['transaction_splits', 'b-split'],
      ['recurring_rules', 'b-rule'],
    ]) {
      expect(idsIn(table)).toEqual([id, `${id}-deleted`, `${id}-pending`]);
    }
    expect(rowsOf('b')).toEqual(bBefore);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:a`)).toBeUndefined();
      expect(metaTable.get(`${k}:b`)).toBe(`${k} of b`);
    }
  });

  it("refuses over the user's own unsynced rows and leaves rows and keys as they were, but not over another user's (#97)", async () => {
    const metaTable = wireSqliteSyncMeta(adapter);
    await seedSyncedRows('a');
    await seedUnsyncedRows('a', 'pending');
    await seedSyncedRows('b');
    for (const u of ['a', 'b']) {
      for (const k of META_KEYS) metaTable.set(`${k}:${u}`, `${k} of ${u}`);
    }
    const aBefore = rowsOf('a');

    // The reset's guard counted these before the probe's round trip, and a
    // mutation hook can write in between, so the wipe counts again first.
    let err: unknown;
    try {
      await wipeLocalData(adapter, 'a');
    } catch (e) {
      err = e;
    }

    expect(String(err)).toContain("Couldn't upload 4 unsynced change(s)");
    expect(rowsOf('a')).toEqual(aBefore);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:a`)).toBe(`${k} of a`);
    }

    // a's unsynced rows are not b's: they neither block b's wipe nor go with
    // it. Read by id, so a split of b's left behind would show.
    await wipeLocalData(adapter, 'b');
    for (const [table, id] of [
      ['accounts', 'a-acct'],
      ['transactions', 'a-txn'],
      ['transaction_splits', 'a-split'],
      ['recurring_rules', 'a-rule'],
    ]) {
      expect(idsIn(table)).toEqual([id, `${id}-pending`]);
    }
    expect(rowsOf('a')).toEqual(aBefore);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:a`)).toBe(`${k} of a`);
      expect(metaTable.get(`${k}:b`)).toBeUndefined();
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
    // Every Supabase read/write errors (offline). The pre-wipe probe must catch
    // this and bail before wipeLocalData runs. A session that has gone is not
    // this case: it reads `[]` with no error, and the reset's session checks
    // refuse it instead (#95, syncSession.test.ts).
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

describe('resetLocalData with two accounts on one device (#87)', () => {
  let metaTable: ReturnType<typeof wireSqliteSyncMeta>;
  let aBefore: Record<string, string>;

  beforeEach(async () => {
    // Real cursors, not wireSyncMocks' map. The wipe deletes keys from the
    // sync_meta TABLE, which the map never sees: there, a's cursors would
    // outlive even a correct wipe (and the re-download would pull from them),
    // and b's would look spared whatever the wipe did.
    metaTable = wireSqliteSyncMeta(adapter);
    // a is the one signed in, and the session says so (#111): the engine
    // refuses to reset a user the session does not belong to, and the fake
    // answers every request as the session's user.
    installSupabase({ sessionUserId: 'a' });

    // b signed in on this device earlier and left work behind: synced rows, a
    // pending and a deleted row in every table, and all four keys.
    await seedSyncedRows('b');
    await seedUnsyncedRows('b', 'pending');
    await seedUnsyncedRows('b', 'deleted');
    for (const k of META_KEYS) metaTable.set(`${k}:b`, `${k} of b`);
    // b's account was renamed on another device since. b's own next sync
    // brings that down; a's reset must not.
    store.accounts.push(
      remoteAccount({
        id: 'b-acct',
        user_id: 'b',
        name: 'Renamed elsewhere',
        updated_at: '2026-05-01T00:00:00Z',
      })
    );

    // a is signed in now, with a synced cache that has drifted: a-txn's
    // amount is stale and a-drift is a row the server does not have.
    await seedSyncedRows('a');
    await insertLocalTxn(adapter, {
      id: 'a-drift',
      user_id: 'a',
      account_id: 'a-acct',
    });
    // Keys a surviving copy would betray: every server row is OLDER than the
    // transaction cursor, and a reconcile an hour ago is not due again, so a
    // re-download that inherited them would read nothing back. (Not `now`:
    // the re-download banks its own start time, which can be the same ms.)
    aBefore = {
      last_pull_at: '2026-06-15T00:00:00Z',
      last_pull_attempt_at: '2026-06-15T00:00:00Z',
      last_txn_pull_at: '2026-06-15T00:00:00Z',
      last_txn_reconcile_at: new Date(Date.now() - 3_600_000).toISOString(),
    };
    for (const k of META_KEYS) metaTable.set(`${k}:a`, aBefore[k]);

    store.accounts.push(remoteAccount({ id: 'a-acct', user_id: 'a' }));
    store.transactions.push(
      remoteTxn({
        id: 'a-txn',
        user_id: 'a',
        account_id: 'a-acct',
        amount: 50,
        updated_at: '2026-04-01T00:00:00Z',
      })
    );
    store.transaction_splits.push({
      id: 'a-split-server',
      transaction_id: 'a-txn',
      amount: 50,
      memo: null,
      updated_at: '2026-04-01T00:00:00Z',
    });
    store.recurring_rules.push(
      remoteRule({ id: 'a-rule', user_id: 'a', account_id: 'a-acct' })
    );
  });

  it("proceeds over another account's unsynced rows, and leaves its cache and keys as they were", async () => {
    const bBefore = rowsOf('b');

    // Refused before #87 with "Couldn't upload 8 unsynced change(s)" — every
    // one of them b's, which a can neither see nor push.
    await resetLocalData('a');

    expect(rowsOf('b')).toEqual(bBefore);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:b`)).toBe(`${k} of b`);
    }
    // No full re-download for b on its next sign-in, and its unsynced work is
    // still its own to push.
    expect(await needsInitialPull('b')).toBe(false);
    expect(store.accounts.map((r: any) => r.id)).not.toContain(
      'b-acct-pending'
    );

    const a = rowsOf('a');
    expect(a.accounts.map((r: any) => r.id)).toEqual(['a-acct']);
    expect(a.transactions.map((r: any) => [r.id, r.amount])).toEqual([
      ['a-txn', 50],
    ]);
    expect(a.transaction_splits.map((r: any) => r.id)).toEqual([
      'a-split-server',
    ]);
    expect(a.recurring_rules.map((r: any) => r.id)).toEqual(['a-rule']);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:a`)).toBeTruthy();
      expect(metaTable.get(`${k}:a`)).not.toBe(aBefore[k]);
    }
  });

  it("leaves only the resetting account's keys unset when its transactions fail to download", async () => {
    const bBefore = rowsOf('b');
    installSupabase({
      sessionUserId: 'a',
      errorReadsOn: new Set(['transactions']),
    });

    let err: unknown;
    try {
      await resetLocalData('a');
    } catch (e) {
      err = e;
    }

    expect(String(err)).toMatch(/download/i);
    // a's keys went with the wipe and nothing re-stamped them, so the next
    // launch bootstraps a rather than trusting a half-downloaded cache. (This
    // read fails before the reconcile can bank its key; a later one, in the
    // split step, leaves that key set. The two pull keys are what a failed
    // re-download always leaves unset.)
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:a`)).toBeUndefined();
    }
    expect(await needsInitialPull('a')).toBe(true);
    expect(rowsOf('b')).toEqual(bBefore);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:b`)).toBe(`${k} of b`);
    }
  });

  it.each(['pending', 'deleted'] as const)(
    "still refuses over the resetting account's own %s rows, and counts only those",
    async (status) => {
      await seedUnsyncedRows('a', status);
      installSupabase({ sessionUserId: 'a', failWrites: true });
      const before = { a: rowsOf('a'), b: rowsOf('b') };

      let err: unknown;
      try {
        await resetLocalData('a');
      } catch (e) {
        err = e;
      }

      // Four, one per table: b's eight are not a's to upload. Three would mean
      // a table's arm for this state is gone, and the wipe would then discard
      // an unpushed edit, or a queued delete the re-download brings back.
      expect(String(err)).toContain("Couldn't upload 4 unsynced change(s)");
      expect(rowsOf('a')).toEqual(before.a);
      expect(rowsOf('b')).toEqual(before.b);
      for (const k of META_KEYS) {
        expect(metaTable.get(`${k}:a`)).toBe(aBefore[k]);
        expect(metaTable.get(`${k}:b`)).toBe(`${k} of b`);
      }
    }
  );
});

describe("a reset and the user's four sync_meta keys (#66, #87)", () => {
  // A device that has pulled since #66 holds all four. The re-download must
  // start from none of them: last_pull_attempt_at matters most, because
  // needsInitialPull is false while it is set, so a wipe that kept it would
  // leave a reset whose download threw to be synced over, half-filled, on the
  // next launch instead of bootstrapped.
  let metaTable: ReturnType<typeof wireSqliteSyncMeta>;
  let before: Record<string, string>;

  beforeEach(async () => {
    metaTable = wireSqliteSyncMeta(adapter);
    before = {
      last_pull_at: '2026-06-15T00:00:00Z',
      last_pull_attempt_at: '2026-06-15T00:00:00Z',
      last_txn_pull_at: '2026-06-15T00:00:00Z',
      // An hour ago, so the reconcile is not due again: kept, this key would
      // never be re-stamped.
      last_txn_reconcile_at: new Date(Date.now() - 3_600_000).toISOString(),
    };
    for (const k of META_KEYS) metaTable.set(`${k}:u`, before[k]);
    await insertLocalAccount(adapter, { id: 'a1' });
    store.accounts = [remoteAccount({ id: 'a1' })];
    store.transactions = [remoteTxn({ id: 't1' })];
  });

  it('a download that throws leaves none of them, so the next launch bootstraps', async () => {
    (supabase as any).from = makeSupabase(store, {
      errorReadsOn: new Set(['transactions']),
    }).from;

    let err: unknown;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    expect(String(err)).toMatch(/download transactions/);
    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:u`)).toBeUndefined();
    }
    expect(await needsInitialPull('u')).toBe(true);
  });

  it('a download that completes stamps all four afresh', async () => {
    await resetLocalData('u');

    for (const k of META_KEYS) {
      expect(metaTable.get(`${k}:u`)).toBeTruthy();
      expect(metaTable.get(`${k}:u`)).not.toBe(before[k]);
    }
    expect(await needsInitialPull('u')).toBe(false);
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

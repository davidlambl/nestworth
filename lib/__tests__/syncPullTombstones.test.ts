// Pull path under tombstones (#18), plus the "an empty enumeration is never
// authoritative" guard (#19).
//
// Two behaviours are load-bearing here and neither is visible from the local DB
// alone, so the fake's `from()` is wrapped in a spy that records every
// (table, columns) read:
//
//   * the point of #18 is that the O(total history) enumeration STOPS being
//     issued on most syncs — a test that only checked the resulting rows would
//     pass just as happily with the enumeration still running every time;
//   * the point of #19 is that certain deletes must NOT happen, which means
//     asserting on rows that survived.
//
// The fixture imports '../supabase' and '../db' at module scope, so the same
// mocks sync.test.ts declares are required here.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { supabase } from '../supabase';
import {
  initialPull,
  planTransactionReconcile,
  pullChanges,
  RECONCILE_INTERVAL_MS,
  resetLocalData,
  type ReconcileLocalRow,
} from '../sync';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  toPgTimestamp,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

let f: ReturnType<typeof wireSyncMocks>;
let adapter: ReturnType<typeof wireSyncMocks>['adapter'];
let store: Store;
let meta: Map<string, string>;
/** Every remote read this pull issued, as `table:columns`. */
let reads: string[];
/** Every `.is()` filter those reads carried, as `table.is(col,val)`. */
let filters: string[];
let warnSpy: jest.SpyInstance;

/** The enumeration #18 exists to stop issuing on every sync. */
// The enumeration selects deleted_at rather than filtering tombstones away
// server-side, so "every row is deleted" comes back as rows and stays
// distinguishable from "the read returned nothing" (#19).
const ENUMERATION = 'transactions:id, updated_at, deleted_at';

/**
 * Wraps the installed fake so each `.from(t).select(cols).is(col, val)` is
 * recorded. Only the READ builder is wrapped: `update`/`upsert`/`delete` expose
 * their own `.select`/`.is`, and these tests never push.
 *
 * The filters have to be observable because W0's upsert guards already refuse a
 * tombstoned row: drop `.is('deleted_at', null)` from a read and the resulting
 * LOCAL rows are identical, so only the query shape shows that the client asked
 * the server to leave the tombstones out of the response at all.
 */
function spyOnReads() {
  const inner = (supabase as any).from;
  (supabase as any).from = (table: string) => {
    const builder = inner(table);
    const select = builder.select;
    const is = builder.is;
    builder.select = (cols?: string) => {
      reads.push(`${table}:${cols ?? '*'}`);
      return select.call(builder, cols);
    };
    builder.is = (col: string, val: any) => {
      filters.push(`${table}.is(${col},${val})`);
      return is.call(builder, col, val);
    };
    return builder;
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const localRow = (
  id: string,
  updated_at: string | null,
  _sync_status = 'synced',
  reconcilable = true
): ReconcileLocalRow => ({ id, updated_at, _sync_status, reconcilable });

beforeEach(() => {
  f = wireSyncMocks();
  ({ adapter, store, meta } = f);
  reads = [];
  filters = [];
  spyOnReads();
  // Several tests deliberately trip the #19 guards, which warn by design.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  adapter._sqlite.close();
});

const ids = async (table: string) =>
  (await adapter.getAllAsync(`SELECT id FROM ${table} ORDER BY id`, [])).map(
    (r: any) => r.id
  );

describe('initialPull never bootstraps a tombstone', () => {
  it('skips tombstoned accounts, rules, transactions and their splits', async () => {
    // A bootstrap starts from an empty local DB, so a tombstone is an
    // instruction to delete a row this device has never had: pure noise that
    // would only pad the pages the bootstrap walks.
    store.accounts = [
      remoteAccount({ id: 'a1' }),
      remoteAccount({ id: 'a2', deleted_at: '2026-05-01T00:00:00+00:00' }),
    ];
    store.recurring_rules = [
      remoteRule({ id: 'r1' }),
      remoteRule({ id: 'r2', deleted_at: '2026-05-01T00:00:00+00:00' }),
    ];
    store.transactions = [
      remoteTxn({ id: 'T1' }),
      remoteTxn({ id: 'T2', deleted_at: '2026-05-01T00:00:00+00:00' }),
    ];
    // The splits of a tombstoned parent must not arrive either: they are
    // fetched by parent id, so excluding the parent has to exclude them.
    store.transaction_splits = [
      { id: 's1', transaction_id: 'T1', amount: 1, memo: null },
      { id: 's2', transaction_id: 'T2', amount: 2, memo: null },
    ];

    await initialPull('u');

    expect(await ids('accounts')).toEqual(['a1']);
    expect(await ids('recurring_rules')).toEqual(['r1']);
    expect(await ids('transactions')).toEqual(['T1']);
    expect(await ids('transaction_splits')).toEqual(['s1']);
    // Asserted on the query shape as well as the rows: the upsert guards would
    // discard a tombstone that arrived anyway, so without this a read that
    // downloaded the user's entire tombstone backlog on every fresh install
    // would look indistinguishable from one that never asked for it.
    expect(filters).toEqual(
      expect.arrayContaining([
        'accounts.is(deleted_at,null)',
        'recurring_rules.is(deleted_at,null)',
        'transactions.is(deleted_at,null)',
      ])
    );
  });

  it('records the bootstrap as a completed reconcile', async () => {
    store.transactions = [remoteTxn({ id: 'T1' })];

    await initialPull('u');

    // A bootstrap just walked every live remote transaction — which is exactly
    // what the periodic pass does. Without this key the very next pull would
    // repeat that full enumeration for nothing.
    expect(meta.get('last_txn_reconcile_at:u')).toBeTruthy();
    expect(meta.get('last_txn_reconcile_at:u')).toBe(
      meta.get('last_pull_at:u')
    );
  });
});

describe('incremental pull applies transaction tombstones', () => {
  // A fresh reconcile key in every test here, so a pass is provably doing the
  // work incrementally rather than being rescued by the full enumeration.
  beforeEach(() => {
    meta.set('last_txn_reconcile_at:u', ago(60 * 1000));
    meta.set('last_txn_pull_at:u', '2026-06-01T00:00:00Z');
  });

  it('deletes a synced row and its splits without enumerating the server', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-06-01T00:00:00Z',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });
    store.transactions = [
      remoteTxn({
        id: 'T1',
        updated_at: '2026-06-02T00:00:00Z',
        deleted_at: '2026-06-02T00:00:00Z',
      }),
    ];

    await pullChanges('u');

    expect(await ids('transactions')).toEqual([]);
    expect(await ids('transaction_splits')).toEqual([]);
    // The whole of #18: the delete arrived on the ordinary
    // `updated_at > cursor` page, so no full enumeration was needed.
    expect(reads).not.toContain(ENUMERATION);
  });

  it('leaves a pending local edit for push to resolve', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      amount: 99,
      _sync_status: 'pending',
      updated_at: '2026-06-03T00:00:00Z',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });
    store.transactions = [
      remoteTxn({
        id: 'T1',
        updated_at: '2026-06-02T00:00:00Z',
        deleted_at: '2026-06-02T00:00:00Z',
      }),
    ];

    await pullChanges('u');

    // Dropping this row here would discard an edit the user made offline AND
    // the queue entry that would have told the server about it. Push resolves
    // it instead: the upsert lands on the tombstoned server row, so delete
    // still wins — but only once the server has actually seen the edit.
    const row: any = await adapter.getFirstAsync(
      'SELECT amount, _sync_status FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(row).toEqual({ amount: 99, _sync_status: 'pending' });
    expect(await ids('transaction_splits')).toEqual(['s1']);
  });

  it('ignores a tombstone for a row it never had', async () => {
    store.transactions = [
      remoteTxn({
        id: 'TX',
        updated_at: '2026-06-02T00:00:00Z',
        deleted_at: '2026-06-02T00:00:00Z',
      }),
    ];

    await pullChanges('u');

    // The resurrection case: the tombstone must not reach an upsert, whose
    // INSERT branch would happily create the row the user just deleted.
    expect(await ids('transactions')).toEqual([]);
  });
});

describe('the full reconcile is periodic, not per-sync (#18)', () => {
  /** Local row the server no longer has — only the reconcile can remove it. */
  async function serverRemovedRow() {
    await insertLocalTxn(adapter, {
      id: 'T4',
      updated_at: '2026-03-01T00:00:00Z',
    });
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: '2026-04-01T00:00:00Z' }),
    ];
    // Cursor newer than every server row, so the incremental page is empty and
    // the reconcile is the only thing that can act.
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');
  }

  it('is skipped while the key is fresh', async () => {
    await serverRemovedRow();
    const fresh = ago(60 * 1000);
    meta.set('last_txn_reconcile_at:u', fresh);

    await pullChanges('u');

    expect(reads).not.toContain(ENUMERATION);
    // T4 survives for up to RECONCILE_INTERVAL_MS. That is the deliberate
    // trade: a row that vanished with no tombstone (a purge, or an old client
    // hard-deleting) is rare, and catching it is not worth enumerating the
    // user's entire history on every single sync.
    expect(await ids('transactions')).toContain('T4');
    expect(meta.get('last_txn_reconcile_at:u')).toBe(fresh);
  });

  it('runs when the key has never been set', async () => {
    await serverRemovedRow();

    await pullChanges('u');

    expect(reads).toContain(ENUMERATION);
    expect(await ids('transactions')).toEqual(['T1']); // T4 reconciled away
    expect(meta.get('last_txn_reconcile_at:u')).toBeTruthy();
  });

  it('runs again once the key is older than the interval', async () => {
    await serverRemovedRow();
    const before = new Date().toISOString();
    meta.set('last_txn_reconcile_at:u', ago(RECONCILE_INTERVAL_MS + 60 * 1000));

    await pullChanges('u');

    expect(reads).toContain(ENUMERATION);
    expect(await ids('transactions')).toEqual(['T1']);
    // Advanced to the PULL-START snapshot, not "now": anything the server
    // changed during the pull is re-examined next time rather than banked.
    const stamped = meta.get('last_txn_reconcile_at:u')!;
    expect(stamped >= before).toBe(true);
    expect(stamped <= new Date().toISOString()).toBe(true);
  });

  it('still runs when the clock moved backwards under a future key', async () => {
    await serverRemovedRow();
    // A key stamped in the future would make "age" negative forever. Reading
    // that as "reconciled recently" would disable the safety net until the
    // device's clock caught up — potentially years.
    meta.set('last_txn_reconcile_at:u', ago(-10 * RECONCILE_INTERVAL_MS));

    await pullChanges('u');

    expect(reads).toContain(ENUMERATION);
    expect(await ids('transactions')).toEqual(['T1']);
  });

  it('treats tombstoned rows as absent from the enumeration', async () => {
    // The device was offline past the tombstone: its cursor is newer than the
    // deleted_at stamp, so the incremental page never shows it. The periodic
    // pass has to be what converges this device.
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-04-01T00:00:00Z',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });
    store.transactions = [
      remoteTxn({
        id: 'T1',
        updated_at: '2026-04-02T00:00:00Z',
        deleted_at: '2026-04-02T00:00:00Z',
      }),
      remoteTxn({ id: 'T2', updated_at: '2026-04-01T00:00:00Z' }),
    ];
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await pullChanges('u');

    expect(await ids('transactions')).toEqual(['T2']);
    expect(await ids('transaction_splits')).toEqual([]);
  });
});

describe('resetLocalData re-arms the reconcile key', () => {
  it('leaves all three cursors set after a re-download', async () => {
    // wipeLocalData clears this user's keys, so the re-download runs with NO
    // reconcile key — i.e. it does a full pass — and must bank it on the way
    // out. If it did not, every sync after a reset would keep paying for the
    // enumeration that the reset had just done, which is the cost #18 exists
    // to remove.
    store.accounts = [remoteAccount({ id: 'a1' })];
    store.transactions = [remoteTxn({ id: 'T1' })];

    await resetLocalData('u');

    expect(reads).toContain(ENUMERATION);
    expect(meta.get('last_pull_at:u')).toBeTruthy();
    expect(meta.get('last_txn_pull_at:u')).toBeTruthy();
    expect(meta.get('last_txn_reconcile_at:u')).toBeTruthy();
  });
});

describe('an empty enumeration is never authoritative (#19)', () => {
  it('deletes nothing and does not bank the reconcile', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-04-01T00:00:00Z',
    });
    // `{ data: [], error: null }` — what a mis-scoped RLS policy or a session
    // that degraded to anon returns. Indistinguishable from "the user deleted
    // everything", and acting on it wipes the device.
    store.transactions = [];
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');

    await pullChanges('u');

    expect(await ids('transactions')).toEqual(['T1']);
    // Key NOT advanced: a pass that refused to act is not a completed pass, so
    // the next sync retries rather than hiding the misconfiguration for a day.
    expect(meta.get('last_txn_reconcile_at:u')).toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) => /empty enumeration/.test(String(c[0])))
    ).toBe(true);
  });

  it('does not bank the reconcile when the enumeration errors either', async () => {
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-04-01T00:00:00Z',
    });
    meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');
    // Re-install over the SAME store, so the rows inserted above survive.
    f.installSupabase({ errorReadsOn: new Set(['transactions']) });
    spyOnReads();

    await pullChanges('u');

    expect(await ids('transactions')).toEqual(['T1']);
    expect(meta.get('last_txn_reconcile_at:u')).toBeUndefined();
  });
});

describe('planTransactionReconcile (pure)', () => {
  it('returns no deletions for an empty remote', () => {
    // The guard lives in the planner so every caller inherits it, and so the
    // rule is testable without a network fake at all.
    expect(
      planTransactionReconcile([], [localRow('T', '2026-04-04T00:00:00Z')])
    ).toEqual({ toRefresh: [], toDelete: [] });
  });

  it('still spares a row created mid-pull when the remote is NON-empty', () => {
    // sync.test.ts proves this with `remote: []`, which the #19 guard now
    // short-circuits — so re-prove it where the guard cannot be the reason.
    const plan = planTransactionReconcile(
      [{ id: 'KEEP', updated_at: '2026-04-04T00:00:00Z' }],
      [
        localRow('KEEP', '2026-04-04T00:00:00Z'),
        localRow(
          'T',
          '2026-06-30T00:00:00Z',
          'synced',
          /* reconcilable */ false
        ),
      ]
    );
    expect(plan.toDelete).toEqual([]);
  });
});

describe('pullTableFull tombstones (accounts and rules)', () => {
  beforeEach(() => {
    // Keep the transaction enumeration out of these tests entirely.
    meta.set('last_txn_reconcile_at:u', ago(60 * 1000));
  });

  it('removes a synced account but keeps a pending one', async () => {
    await insertLocalAccount(adapter, { id: 'a1' });
    await insertLocalAccount(adapter, {
      id: 'a2',
      name: 'Mine',
      _sync_status: 'pending',
    });
    // Both tombstoned server-side. `data` is non-empty, so this read IS
    // authoritative — a response of nothing but tombstones is the server
    // answering "all deleted", not a read that silently returned nothing.
    store.accounts = [
      remoteAccount({ id: 'a1', deleted_at: '2026-05-01T00:00:00+00:00' }),
      remoteAccount({ id: 'a2', deleted_at: '2026-05-01T00:00:00+00:00' }),
    ];

    await pullChanges('u');

    expect(await ids('accounts')).toEqual(['a2']);
    const row: any = await adapter.getFirstAsync(
      'SELECT name, _sync_status FROM accounts WHERE id = ?',
      ['a2']
    );
    expect(row).toEqual({ name: 'Mine', _sync_status: 'pending' });
  });

  it('does not upsert a tombstoned account alongside a live one', async () => {
    await insertLocalAccount(adapter, { id: 'a1' });
    store.accounts = [
      remoteAccount({ id: 'a1', deleted_at: '2026-05-01T00:00:00+00:00' }),
      remoteAccount({ id: 'a9', name: 'Live' }),
    ];

    await pullChanges('u');

    // a9 arrives, a1 leaves: the tombstone was kept out of BOTH the upsert loop
    // and the remote-id set, which is what lets the absence-based delete fire.
    expect(await ids('accounts')).toEqual(['a9']);
  });

  it('removes a synced rule the same way', async () => {
    await insertLocalRule(adapter, { id: 'r1' });
    await insertLocalRule(adapter, { id: 'r2', _sync_status: 'pending' });
    store.recurring_rules = [
      remoteRule({ id: 'r1', deleted_at: '2026-05-01T00:00:00+00:00' }),
      remoteRule({ id: 'r2', deleted_at: '2026-05-01T00:00:00+00:00' }),
    ];

    await pullChanges('u');

    expect(await ids('recurring_rules')).toEqual(['r2']);
  });

  it('skips the delete loop entirely on an empty read (#19)', async () => {
    await insertLocalAccount(adapter, { id: 'a1' });
    await insertLocalRule(adapter, { id: 'r1' });
    // Clean response, no rows. Before the guard this wiped every synced local
    // row in the table.
    store.accounts = [];
    store.recurring_rules = [];

    await pullChanges('u');

    expect(await ids('accounts')).toEqual(['a1']);
    expect(await ids('recurring_rules')).toEqual(['r1']);
    expect(
      warnSpy.mock.calls.filter((c) => /empty read/.test(String(c[0]))).length
    ).toBe(2);
  });
});

describe('the incremental pull adopts the server rendering of a live row', () => {
  it('upserts live rows on the same page that carries a tombstone', async () => {
    // A single incremental page routinely mixes both. Proving the live row
    // still lands guards against a partition bug that swallows everything.
    meta.set('last_txn_reconcile_at:u', ago(60 * 1000));
    meta.set('last_txn_pull_at:u', '2026-06-01T00:00:00Z');
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-06-01T00:00:00Z',
    });
    store.transactions = [
      remoteTxn({
        id: 'T1',
        updated_at: toPgTimestamp('2026-06-02T00:00:00Z'),
        deleted_at: toPgTimestamp('2026-06-02T00:00:00Z'),
      }),
      remoteTxn({
        id: 'T2',
        amount: 7,
        updated_at: toPgTimestamp('2026-06-02T00:00:00Z'),
      }),
    ];

    await pullChanges('u');

    const rows = await adapter.getAllAsync(
      'SELECT id, amount FROM transactions ORDER BY id',
      []
    );
    expect(rows).toEqual([{ id: 'T2', amount: 7 }]);
    expect(reads).not.toContain(ENUMERATION);
  });
});

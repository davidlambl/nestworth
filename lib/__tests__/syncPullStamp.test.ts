// #66: `last_pull_at:<user>` is the "Last synced" line in Settings, and
// pullChanges used to stamp it as its last statement whatever had happened
// before it. Every failed read was swallowed with a console.warn, so a device
// that could not download a table said "Last synced: Just now" under "All
// changes synced with cloud". Since #83 a stalled network produces exactly
// that: a page read that times out, or a token refresh that times out and
// degrades to the anon key, whose RLS-empty reads trip the #19 guards with no
// error object at all. Both kinds must count.
//
// The fix has two keys, and this file pins both. `last_pull_at` now waits for
// a COMPLETE pull. `last_pull_attempt_at` is stamped by every pullChanges that
// did not throw, and needsInitialPull asks for both to be unset: withholding
// the first alone sent the next launch back to initialPull over a store that
// already held data, which duplicates a pending split set and resurrects a
// deletion made elsewhere (the last describe below).
//
// Own file: `lastError` in lib/syncStatus.ts and `_syncInProgress` in
// lib/sync.ts are module state shared by every test in a file, so each test
// starts from a cleared error, awaits everything it starts, and afterEach
// asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  needsInitialPull,
  pullChanges,
  requestPush,
  resetLocalData,
  startSyncSession,
} from '../sync';
import { supabase } from '../supabase';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

/** The last complete pull. Older than any stamp a test can make. */
const T0 = '2026-06-15T00:00:00Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
  // Every failure path here warns by design.
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

const lastError = () => getSyncSnapshot().lastError;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const localIds = (table: string) =>
  ctx.adapter._sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((r: any) => r.id);

/** Every local table at once, so a test can see what a pull did and did not land. */
const landed = () => ({
  accounts: localIds('accounts'),
  rules: localIds('recurring_rules'),
  transactions: localIds('transactions'),
  splits: localIds('transaction_splits'),
});

/** A parent's local splits as `id:_sync_status`, in id order. */
const localSplits = (txnId: string) =>
  ctx.adapter._sqlite
    .prepare(
      'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
    )
    .all(txnId)
    .map((r: any) => `${r.id}:${r._sync_status}`);

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s) => s.transaction_id === txnId)
    .map((s) => s.id)
    .sort();

/**
 * A pull in which every table has something to read, so a failure injected on
 * any one of them is a read that really ran. The split read only runs for a
 * parent the incremental pass pulled and that is synced locally, hence a
 * transaction edited elsewhere since the cursor, carrying a split (the
 * syncTombstoneRaces.test.ts setup). A fresh reconcile key keeps the
 * enumeration out of it, so the failure a test injects is the only one.
 */
function seedEveryTable() {
  ctx.meta.set('last_pull_at:u', T0);
  ctx.meta.set('last_pull_attempt_at:u', T0);
  ctx.meta.set('last_txn_pull_at:u', T0);
  ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
  ctx.store.accounts = [remoteAccount({ id: 'a1' })];
  ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
  ctx.store.transactions = [
    remoteTxn({ id: 't1', updated_at: '2026-07-01T00:00:00Z' }),
  ];
  ctx.store.transaction_splits = [
    { id: 's1', transaction_id: 't1', amount: -5, memo: null },
  ];
}

/** What a remote read is, as far as telling one read site from another goes. */
interface ReadShape {
  table: string;
  cols?: string;
  inCol?: string;
}

/**
 * Intercepts the remote reads whose SHAPE matches `pred`, on top of whatever
 * fake is installed. `errorReadsOn` fails every read of a table, which cannot
 * isolate the reconcile's three reads: the enumeration and the refresh-parent
 * read are both `transactions`, and the refresh's split read is
 * `transaction_splits` exactly like step 3's.
 *
 *   - `{ fail: true }` answers `{ data: null, error: BOOM }` instead of reading;
 *   - `{ before }` runs `before` and then reads normally — to change the store
 *     between two reads of the same pull. Before the read, not after it: the
 *     fake hands back the store's own row objects, so a change made once a
 *     page has resolved would already show in that page.
 *
 * Both act once per PAGE request, and `hits()` counts page requests, not
 * reads: a read that returns rows makes two (its data page and the trailing
 * empty page that ends it), while a read whose first page fails or comes back
 * empty makes one. Writes pass straight through, so a push still reaches the
 * fake.
 */
const BOOM = { message: 'boom', code: 'X' };
function interceptReads(
  pred: (read: ReadShape) => boolean,
  action: { fail: true } | { before: () => void }
): { hits: () => number } {
  const realFrom = (supabase as any).from;
  let hits = 0;
  (supabase as any).from = (table: string) => {
    const real = realFrom(table);
    const read: ReadShape = { table };
    const answer = (resolve: () => PromiseLike<any>) => {
      if (!pred(read)) {
        return resolve();
      }
      hits++;
      if ('fail' in action) {
        return Promise.resolve({ data: null, error: BOOM });
      }
      action.before();
      return resolve();
    };
    const proxy: any = {};
    for (const m of ['eq', 'gt', 'is', 'order', 'limit']) {
      proxy[m] = (...args: any[]) => {
        real[m](...args);
        return proxy;
      };
    }
    proxy.select = (cols?: string) => {
      read.cols = cols;
      real.select(cols);
      return proxy;
    };
    proxy.in = (col: string, vals: any[]) => {
      read.inCol = col;
      real.in(col, vals);
      return proxy;
    };
    proxy.range = (a: number, b: number) => answer(() => real.range(a, b));
    proxy.then = (res: any, rej: any) =>
      answer(() => new Promise((r) => real.then(r))).then(res, rej);
    for (const m of ['upsert', 'update', 'insert', 'delete']) {
      proxy[m] = (...args: any[]) => real[m](...args);
    }
    return proxy;
  };
  return { hits: () => hits };
}

const isEnumeration = (r: ReadShape) =>
  r.table === 'transactions' && r.cols === 'id, updated_at, deleted_at';
// `cols` as well as `inCol`: an enumeration refactored to `.in('id', …)` must
// not be mistaken for the refresh read and let a test pass vacuously.
const isRefreshParents = (r: ReadShape) =>
  r.table === 'transactions' && r.inCol === 'id' && r.cols === '*';
const isSplitRead = (r: ReadShape) =>
  r.table === 'transaction_splits' && r.inCol === 'transaction_id';

/**
 * A due reconcile that plans exactly one refresh: t1 was corrected on the
 * server to an OLDER timestamp than the local copy, which no incremental read
 * can see (the cursor is later than both), so the reconcile is the only thing
 * that reads anything about it — its enumeration, its refresh-parent read and
 * its refresh-split read, in that order.
 */
async function seedReconcileRefresh() {
  ctx.meta.set('last_pull_at:u', T0);
  ctx.meta.set('last_txn_pull_at:u', T0);
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    updated_at: '2026-03-01T00:00:00Z',
    payee: 'Stale',
  });
  ctx.store.transactions = [
    remoteTxn({ id: 't1', updated_at: '2026-02-01T00:00:00Z', payee: 'Fixed' }),
  ];
  ctx.store.transaction_splits = [
    { id: 's9', transaction_id: 't1', amount: -1, memo: null },
  ];
}

describe('a pull that could not read a table does not stamp last_pull_at', () => {
  it.each([
    {
      table: 'accounts',
      label: 'accounts',
      // No short-circuit: a failed accounts read must not cost the user their
      // rules and transactions.
      after: {
        accounts: [],
        rules: ['r1'],
        transactions: ['t1'],
        splits: ['s1'],
      },
    },
    {
      table: 'recurring_rules',
      label: 'recurring rules',
      after: {
        accounts: ['a1'],
        rules: [],
        transactions: ['t1'],
        splits: ['s1'],
      },
    },
    {
      table: 'transactions',
      label: 'transactions',
      after: { accounts: ['a1'], rules: ['r1'], transactions: [], splits: [] },
    },
    {
      table: 'transaction_splits',
      label: 'transaction splits',
      after: {
        accounts: ['a1'],
        rules: ['r1'],
        transactions: ['t1'],
        splits: [],
      },
    },
  ])('when the $table read fails', async ({ table, label, after }) => {
    seedEveryTable();
    ctx.installSupabase({ errorReadsOn: new Set([table]) });

    const complete = await pullChanges('u');

    // Stamping here is the bug: "Last synced: Just now" over a table this pull
    // never downloaded, and nothing on the error line to say so. The message
    // names the table the way a user reads it, not the PostgREST name. The
    // attempt still counts: it is what keeps the next launch out of
    // initialPull.
    expect({
      complete,
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      attemptAdvanced:
        Date.parse(ctx.meta.get('last_pull_attempt_at:u') as string) >
        Date.parse(T0),
      lastError: lastError(),
      landed: landed(),
    }).toEqual({
      complete: false,
      lastPullAt: T0,
      attemptAdvanced: true,
      lastError: `Couldn't download ${label}: network unreachable`,
      landed: after,
    });
  });

  it('retires the bootstrap after an incomplete pull, without claiming it completed', async () => {
    // No pull key at all: a fresh device whose initialPull gave up, or the
    // queued full sync that stands in for one (see initialPull in lib/sync.ts).
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.installSupabase({ errorReadsOn: new Set(['transactions']) });

    expect(await pullChanges('u')).toBe(false);

    // "Last synced" stays "Never", but the store is no longer empty, so the
    // next launch must run pullChanges again rather than initialPull.
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBeTruthy();
    expect(await needsInitialPull('u')).toBe(false);
  });
});

describe('a pull that refused to trust an empty read does not stamp it either (#19)', () => {
  it('when the accounts read came back empty over synced local accounts', async () => {
    // `{ data: [], error: null }`: what a session that degraded to the anon key
    // reads under RLS. No error object anywhere, and still not a complete pull.
    ctx.meta.set('last_pull_at:u', T0);
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [];

    expect(await pullChanges('u')).toBe(false);

    expect(ctx.meta.get('last_pull_at:u')).toBe(T0);
    expect(lastError()).toBe(
      "The cloud returned no accounts but this device has 1 — kept this device's copy."
    );
    expect(localIds('accounts')).toEqual(['a1']);
  });

  it('when the reconcile enumeration came back empty over synced local transactions', async () => {
    // No reconcile key, so the enumeration is due; it returns nothing while a
    // synced transaction exists locally, and the #19 guard refuses to act.
    ctx.meta.set('last_pull_at:u', T0);
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.transactions = [];

    expect(await pullChanges('u')).toBe(false);

    expect(ctx.meta.get('last_pull_at:u')).toBe(T0);
    expect(lastError()).toBe(
      "The cloud returned no transactions but this device has 1 — kept this device's copy."
    );
    expect(localIds('transactions')).toEqual(['t1']);
  });
});

// errorReadsOn fails a whole table, so it cannot fail the reconcile's reads one
// at a time; interceptReads can. Without these, dropping the failure record at
// any of the three reconcile sites left every sync suite green.
describe('each reconcile read reports its own failure', () => {
  it('when only the enumeration fails', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    const reads = interceptReads(isEnumeration, { fail: true });

    const complete = await pullChanges('u');

    expect(reads.hits()).toBe(1);
    // The incremental pass read cleanly and its row stands.
    expect(localIds('transactions')).toEqual(['t1']);
    expect({
      complete,
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
      reconcileKey: ctx.meta.get('last_txn_reconcile_at:u'),
    }).toEqual({
      complete: false,
      lastPullAt: T0,
      lastError: "Couldn't download transactions: boom",
      reconcileKey: undefined,
    });
  });

  it('when only the refresh batch parent read fails', async () => {
    await seedReconcileRefresh();
    const reads = interceptReads(isRefreshParents, { fail: true });

    const complete = await pullChanges('u');

    expect(reads.hits()).toBe(1);
    expect({
      complete,
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
      reconcileKey: ctx.meta.get('last_txn_reconcile_at:u'),
      payee: (
        ctx.adapter._sqlite
          .prepare('SELECT payee FROM transactions WHERE id = ?')
          .get('t1') as any
      ).payee,
    }).toEqual({
      complete: false,
      lastPullAt: T0,
      lastError: "Couldn't download transactions: boom",
      reconcileKey: undefined,
      payee: 'Stale',
    });
  });

  it('when only the refresh batch split read fails', async () => {
    await seedReconcileRefresh();
    // Nothing was pulled incrementally, so step 3 reads no split batch: the
    // one split read this pull makes is the refresh's own.
    const reads = interceptReads(isSplitRead, { fail: true });

    const complete = await pullChanges('u');

    expect(reads.hits()).toBe(1);
    expect({
      complete,
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
      reconcileKey: ctx.meta.get('last_txn_reconcile_at:u'),
    }).toEqual({
      complete: false,
      lastPullAt: T0,
      lastError: "Couldn't download transaction splits: boom",
      reconcileKey: undefined,
    });
  });

  it('but not when a refresh batch comes back empty because its rows were deleted meanwhile', async () => {
    // The enumeration plans a refresh of t1, and t1 is tombstoned elsewhere
    // before the refresh reads it, so the refresh (which filters deleted rows)
    // returns nothing: a skip, not a failure, exactly like an empty split
    // batch in step 3.
    await seedReconcileRefresh();
    const reads = interceptReads(isRefreshParents, {
      before: () => {
        const t1 = ctx.store.transactions.find((t) => t.id === 't1');
        t1.deleted_at = '2026-06-20T00:00:00Z';
      },
    });

    expect(await pullChanges('u')).toBe(true);

    // Exactly one refresh read ran, so the empty batch was really reached.
    expect(reads.hits()).toBe(1);
    expect(ctx.meta.get('last_pull_at:u')).not.toBe(T0);
    expect(lastError()).toBeNull();
  });

  it('and the first failure is the one reported', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -5, memo: null },
    ];
    ctx.installSupabase({
      errorReadsOn: new Set(['accounts', 'transaction_splits']),
    });

    expect(await pullChanges('u')).toBe(false);

    expect(lastError()).toBe("Couldn't download accounts: network unreachable");
  });
});

describe('a complete pull stamps last_pull_at and reports nothing', () => {
  it('when every table reads cleanly', async () => {
    seedEveryTable();

    expect(await pullChanges('u')).toBe(true);

    expect(
      Date.parse(ctx.meta.get('last_pull_at:u') as string)
    ).toBeGreaterThan(Date.parse(T0));
    // One instant for both keys: a complete pull is also an attempt.
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBe(
      ctx.meta.get('last_pull_at:u')
    );
    expect(lastError()).toBeNull();
    expect(landed()).toEqual({
      accounts: ['a1'],
      rules: ['r1'],
      transactions: ['t1'],
      splits: ['s1'],
    });
  });

  it('when the split batch is empty because every touched parent is pending', async () => {
    // The syncTombstoneRaces.test.ts scenario: our own push bumped the parent's
    // server updated_at, so the incremental pass lists it while the local row
    // is still pending, and step 3's synced-parent filter empties the batch. A
    // skip, not a failure — the transaction cursor advances on it, and so must
    // last_pull_at.
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      updated_at: '2026-06-20T00:00:00Z',
      _sync_status: 'pending',
    });
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    // A split read would fail if one ran, so a stamp proves none did.
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });

    expect(await pullChanges('u')).toBe(true);

    expect(ctx.meta.get('last_pull_at:u')).not.toBe(T0);
    expect(lastError()).toBeNull();
  });

  it('for a new user whose tables are all empty, which the #19 guards must not refuse', async () => {
    // Nothing local, nothing remote: an empty read here is the honest answer,
    // and neither guard has a synced local row to protect.
    expect(await pullChanges('u')).toBe(true);

    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
    expect(lastError()).toBeNull();
  });
});

describe('under throwOnError (the reset re-download)', () => {
  it('a failed read still throws, stamps neither key, and leaves the bootstrap due', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.installSupabase({ errorReadsOn: new Set(['accounts']) });

    let err: unknown;
    try {
      await pullChanges('u', { throwOnError: true });
    } catch (e) {
      err = e;
    }

    // String(err) rather than rejects.toThrow(): these suites share a worker
    // with better-sqlite3's per-realm error class.
    expect(String(err)).toMatch(/download accounts/);
    // The mirror of the incomplete pull above: a download that threw left
    // nothing a later pull could build on, so the next launch bootstraps.
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBeUndefined();
    expect(await needsInitialPull('u')).toBe(true);
  });

  it('a reconcile that could not complete withholds the stamp without throwing', async () => {
    // A reconcile failure never threw, even for a reset, and must not start
    // to: the reset still succeeds, last_pull_at stays unset (the wipe cleared
    // it), and the status line says why. The attempt is recorded, so the next
    // launch syncs rather than bootstrapping over the re-downloaded store.
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.transactions = [];

    let err: unknown = null;
    let complete: boolean | undefined;
    try {
      complete = await pullChanges('u', { throwOnError: true });
    } catch (e) {
      err = e;
    }

    expect(String(err)).toBe('null');
    expect(complete).toBe(false);
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
    expect(await needsInitialPull('u')).toBe(false);
    expect(lastError()).toMatch(/The cloud returned no transactions/);
  });
});

/**
 * Session 1 on a fresh device: every pull of the session is incomplete because
 * ONE table (recurring rules) cannot be read, but t1 and its splits land.
 */
async function session1PartialPull() {
  ctx.store.accounts = [remoteAccount({ id: 'a1' })];
  ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
  ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
  ctx.store.transaction_splits = [
    { id: 's1', transaction_id: 't1', amount: -5, memo: null },
    { id: 's2', transaction_id: 't1', amount: -5, memo: null },
  ];
  ctx.installSupabase({ errorReadsOn: new Set(['recurring_rules']) });
  await startSyncSession('u');
  expect(localIds('transactions')).toEqual(['t1']);
  expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
}

// initialPull is written for an empty store: its split loop neither filters by
// the parent's local status nor deletes stale synced splits, and it reads live
// rows only, then banks both transaction keys. Withholding last_pull_at alone
// sent every launch after an incomplete pull back to it, over a store an
// earlier pull had already filled. last_pull_attempt_at is what keeps those
// launches on pullChanges.
describe('an incomplete pull does not send the next launch back to initialPull', () => {
  it('a split edit not yet pushed at relaunch is uploaded alone, not beside the old splits', async () => {
    await session1PartialPull();

    // The user re-splits t1 (lib/transactionUpdate.ts: new ids, parent and
    // splits pending) and the app closes before the push lands.
    const now = new Date().toISOString();
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(now);
    ctx.adapter._sqlite
      .prepare("DELETE FROM transaction_splits WHERE transaction_id = 't1'")
      .run();
    for (const [id, amount] of [
      ['s3', -3],
      ['s4', -7],
    ] as const) {
      await insertLocalSplit(ctx.adapter, {
        id,
        transaction_id: 't1',
        amount,
        updated_at: now,
        _sync_status: 'pending',
      });
    }

    // Session 2, healthy. Re-running initialPull here inserted the server's
    // s1 and s2 beside the pending s3 and s4, and the push uploaded all four.
    ctx.installSupabase();
    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('a split edit made on another device between launches replaces the old splits here', async () => {
    await session1PartialPull();

    // Another device re-splits t1 between the two launches.
    await sleep(5);
    const t1 = ctx.store.transactions.find((t) => t.id === 't1');
    t1.updated_at = new Date().toISOString();
    ctx.store.transaction_splits = [
      { id: 's3', transaction_id: 't1', amount: -3, memo: null },
      { id: 's4', transaction_id: 't1', amount: -7, memo: null },
    ];
    await sleep(5);

    ctx.installSupabase();
    await startSyncSession('u');
    const afterLaunch = localSplits('t1');

    // Then the user edits t1's payee here, which pushes every local split.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET payee = 'Edited', updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(new Date().toISOString());
    await requestPush('u');

    expect(afterLaunch).toEqual(['s3:synced', 's4:synced']);
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
  });

  it('a transaction deleted on another device between launches is deleted here', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
    ctx.store.transactions = [
      remoteTxn({ id: 't1', amount: -10 }),
      remoteTxn({ id: 't2', amount: -99 }),
    ];
    ctx.installSupabase({ errorReadsOn: new Set(['recurring_rules']) });
    await startSyncSession('u');
    expect(localIds('transactions')).toEqual(['t1', 't2']);

    // Another device deletes t2: a tombstone, i.e. an UPDATE stamping
    // deleted_at. initialPull reads live rows only and would bank both
    // transaction keys past it, leaving t2 here until the daily reconcile.
    await sleep(5);
    const t2 = ctx.store.transactions.find((t) => t.id === 't2');
    t2.deleted_at = new Date().toISOString();
    t2.updated_at = new Date().toISOString();
    await sleep(5);

    ctx.installSupabase();
    await startSyncSession('u');

    expect(localIds('transactions')).toEqual(['t1']);
  });

  it('a reset whose reconcile failed does not bootstrap over its own re-download', async () => {
    // sync_meta is a SQLite table in production, so the wipe clears it; the
    // fixture keeps it in a Map, which this makes the wipe clear too.
    const realExec = ctx.adapter.execAsync;
    ctx.adapter.execAsync = async (sql: string) => {
      await realExec(sql);
      if (/DELETE FROM sync_meta/.test(sql)) ctx.meta.clear();
    };
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.meta.set('last_pull_at:u', T0);
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -5, memo: null },
      { id: 's2', transaction_id: 't1', amount: -5, memo: null },
    ];
    interceptReads(isEnumeration, { fail: true });

    await resetLocalData('u');

    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    // Read now, asserted after the outcome below, so that a regression goes
    // red on what the user would see rather than only on its cause.
    const lastPullAtAfterReset = ctx.meta.get('last_pull_at:u');
    const bootstrapDueAfterReset = await needsInitialPull('u');

    // Another device re-splits t1 before this one relaunches.
    await sleep(5);
    const t1 = ctx.store.transactions.find((t) => t.id === 't1');
    t1.updated_at = new Date().toISOString();
    ctx.store.transaction_splits = [
      { id: 's3', transaction_id: 't1', amount: -3, memo: null },
      { id: 's4', transaction_id: 't1', amount: -7, memo: null },
    ];
    await sleep(5);

    ctx.installSupabase();
    await startSyncSession('u');

    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect({ lastPullAtAfterReset, bootstrapDueAfterReset }).toEqual({
      lastPullAtAfterReset: undefined,
      bootstrapDueAfterReset: false,
    });
  });
});

// Every install from before #66 arrives with last_pull_at and no attempt key.
// That half of needsInitialPull is what keeps it syncing: without it, the first
// launch after the update runs initialPull over the device's whole store, and
// an unpushed split edit goes up beside the old splits, as above.
describe('a device upgraded from 1.1.4 keeps syncing instead of bootstrapping', () => {
  it('with only last_pull_at, an unpushed split edit reaches the server alone', async () => {
    // The three keys 1.1.4 knew, and no attempt key.
    for (const key of [
      'last_pull_at',
      'last_txn_pull_at',
      'last_txn_reconcile_at',
    ]) {
      ctx.meta.set(`${key}:u`, new Date().toISOString());
    }
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -5, memo: null },
      { id: 's2', transaction_id: 't1', amount: -5, memo: null },
    ];
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    // The user re-split t1 on 1.1.4 and the push had not landed yet.
    const now = new Date().toISOString();
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      amount: -10,
      updated_at: now,
      _sync_status: 'pending',
    });
    for (const [id, amount] of [
      ['s3', -3],
      ['s4', -7],
    ] as const) {
      await insertLocalSplit(ctx.adapter, {
        id,
        transaction_id: 't1',
        amount,
        updated_at: now,
        _sync_status: 'pending',
      });
    }
    const bootstrapDue = await needsInitialPull('u');

    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect({
      attemptKey: ctx.meta.get('last_pull_attempt_at:u'),
      bootstrapDue,
    }).toEqual({ attemptKey: expect.any(String), bootstrapDue: false });
  });
});

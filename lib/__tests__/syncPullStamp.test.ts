// #66: `last_pull_at:<user>` is the "Last synced" line in Settings and all that
// needsInitialPull reads, and pullChanges used to stamp it as its last
// statement whatever had happened before it. Every failed read was swallowed
// with a console.warn, so a device that could not download a table said "Last
// synced: Just now" under "All changes synced with cloud", and a fresh device
// whose first download lost a table counted as bootstrapped. Since #83 a
// stalled network produces exactly that: a page read that times out, or a token
// refresh that times out and degrades to the anon key, whose RLS-empty reads
// trip the #19 guards with no error object at all. Both kinds must count.
//
// Own file: `lastError` in lib/syncStatus.ts is module state shared by every
// test in a file, so each test here starts from a cleared one.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { needsInitialPull, pullChanges } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
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
  quiet = (['log', 'warn'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
});

const lastError = () => getSyncSnapshot().lastError;

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
    // names the table the way a user reads it, not the PostgREST name.
    expect({
      complete,
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
      landed: landed(),
    }).toEqual({
      complete: false,
      lastPullAt: T0,
      lastError: `Couldn't download ${label}: network unreachable`,
      landed: after,
    });
  });

  it('leaves a device that never completed a pull asking for a bootstrap', async () => {
    // No last_pull_at at all: a fresh device whose initialPull gave up, or the
    // queued full sync that stands in for one (see initialPull in lib/sync.ts).
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.installSupabase({ errorReadsOn: new Set(['transactions']) });

    expect(await pullChanges('u')).toBe(false);

    // Never unset, never stamped: the key still says "never pulled", so the
    // next launch bootstraps for real instead of trusting a partial download.
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
    expect(await needsInitialPull('u')).toBe(true);
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
      "The cloud returned no accounts while this device has 1 — kept this device's copy. If the cloud is right, use Reset & re-download."
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
      "The cloud returned no transactions while this device has 1 — kept this device's copy. If the cloud is right, use Reset & re-download."
    );
    expect(localIds('transactions')).toEqual(['t1']);
  });
});

describe('a complete pull stamps last_pull_at and reports nothing', () => {
  it('when every table reads cleanly', async () => {
    seedEveryTable();

    expect(await pullChanges('u')).toBe(true);

    expect(
      Date.parse(ctx.meta.get('last_pull_at:u') as string)
    ).toBeGreaterThan(Date.parse(T0));
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
  it('a failed read still throws, and stamps nothing', async () => {
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
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
  });

  it('a reconcile that could not complete withholds the stamp without throwing', async () => {
    // A reconcile failure never threw, even for a reset, and must not start
    // to: the reset still succeeds, last_pull_at stays unset (the wipe cleared
    // it, so the next launch re-bootstraps), and the status line says why.
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
    expect(lastError()).toMatch(/The cloud returned no transactions/);
  });
});

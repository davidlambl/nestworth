// Regression tests for #55: work requested while a sync holds the lock must be
// carried out by the holder before it releases the lock, whoever the holder is
// and however the request arrived. On the old engine, initialPull left the
// drain to the fullSync that useSyncEngine ran next, and that fullSync was
// skipped whenever the effect had been torn down and re-run mid-bootstrap —
// which auth-js's per-event User objects made happen on nearly every launch.
//
// Own file, deliberately: `_syncInProgress` and the queue flags in lib/sync.ts
// are module state shared by every test in a file, so a suite that leaves a
// sync in flight makes the tests after it pass vacuously. Every test here
// awaits everything it started, and afterEach asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { fullSync, initialPull, requestPush, startSyncSession } from '../sync';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import {
  ACCOUNT_COLS,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

const NOW = '2026-01-01T00:00:00Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(async () => {
  ctx = wireSyncMocks();
  // The status store is module state too; start every test from a fresh count.
  await refreshSyncState('u');
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

/** What useCreateAccount does: a pending row, written straight to SQLite. */
function insertPendingAccountSync(id: string) {
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO accounts (${ACCOUNT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      'u',
      `Account ${id}`,
      'checking',
      null,
      0,
      0,
      0,
      0,
      NOW,
      NOW,
      'pending'
    );
}

/** Runs `fn` right after the first write whose SQL matches `match` lands. */
function onFirstStatement(match: RegExp, fn: () => void): () => boolean {
  const real = ctx.adapter.runAsync.bind(ctx.adapter);
  let fired = false;
  ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
    const out = await real(sql, params);
    if (!fired && match.test(sql)) {
      fired = true;
      fn();
    }
    return out;
  };
  return () => fired;
}

/** Runs `fn` right after the first read whose SQL matches `match` resolves. */
function onFirstRead(match: RegExp, fn: () => void): () => boolean {
  const real = ctx.adapter.getAllAsync.bind(ctx.adapter);
  let fired = false;
  ctx.adapter.getAllAsync = async (sql: string, params: any[] = []) => {
    const rows = await real(sql, params);
    if (!fired && match.test(sql)) {
      fired = true;
      fn();
    }
    return rows;
  };
  return () => fired;
}

const serverHasAccount = (id: string) =>
  ctx.store.accounts.some((a: any) => a.id === id);

async function localStatus(table: string, id: string) {
  const row: any = await ctx.adapter.getFirstAsync(
    `SELECT _sync_status FROM ${table} WHERE id = ?`,
    [id]
  );
  return row?._sync_status ?? null;
}

const PENDING_ACCOUNTS_READ = /FROM accounts WHERE _sync_status = 'pending'/;
const BOOTSTRAP_TXN_INSERT = /INSERT INTO transactions/;

describe('requests that arrive while a sync holds the lock', () => {
  it('uploads a push requested during the bootstrap before initialPull resolves', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a-remote' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' }), remoteTxn({ id: 't2' })];
    const fired = onFirstStatement(BOOTSTRAP_TXN_INSERT, () => {
      insertPendingAccountSync('a-new');
      void requestPush('u');
    });

    await initialPull('u');

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-new')).toBe(true);
    expect(await localStatus('accounts', 'a-new')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
  });

  it('a startup run that finds the lock held still ends with everything pushed and pulled', async () => {
    // The effect re-ran mid-bootstrap: run N holds the lock, run N+1 calls
    // initialPull and then fullSync while it does. Before: both returned
    // silently and the push queued during the bootstrap was never sent.
    ctx.store.accounts = [remoteAccount({ id: 'a-remote' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    const fired = onFirstStatement(BOOTSTRAP_TXN_INSERT, () => {
      insertPendingAccountSync('a-new');
      void requestPush('u');
      // Committed by another device during our bootstrap, stamped after the
      // bootstrap's cursor so an incremental pull is what has to find it.
      ctx.store.transactions.push(
        remoteTxn({
          id: 't-late',
          updated_at: new Date(Date.now() + 60_000).toISOString(),
        })
      );
    });

    const runN = initialPull('u');
    await initialPull('u');
    await fullSync('u');
    await runN;

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-new')).toBe(true);
    expect(await localStatus('transactions', 't-late')).toBe('synced');
  });

  it('startSyncSession: a run cancelled mid-bootstrap and its replacement together push what was created', async () => {
    // The faithful shape of the hook: run N is torn down (cancelled) while its
    // bootstrap is in flight, and run N+1 starts at that moment.
    ctx.store.accounts = [remoteAccount({ id: 'a-remote' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    let cancelled = false;
    let runN1: Promise<void> | null = null;
    const fired = onFirstStatement(BOOTSTRAP_TXN_INSERT, () => {
      insertPendingAccountSync('a-new');
      void requestPush('u');
      cancelled = true;
      runN1 = startSyncSession('u');
    });

    await startSyncSession('u', { isCancelled: () => cancelled });
    await runN1!;

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-new')).toBe(true);
    expect(await localStatus('accounts', 'a-new')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
  });

  it('a fullSync requested while a push is in flight still pushes and pulls', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a-remote' })];
    const fired = onFirstRead(PENDING_ACCOUNTS_READ, () => {
      // Too late for the push in flight: it has already read its pending list.
      insertPendingAccountSync('a-late');
      ctx.store.transactions.push(remoteTxn({ id: 't-late' }));
      void fullSync('u');
    });

    await requestPush('u');

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-late')).toBe(true);
    expect(await localStatus('transactions', 't-late')).toBe('synced');
  });

  it('a requestPush during a push is uploaded before the holder resolves', async () => {
    const fired = onFirstRead(PENDING_ACCOUNTS_READ, () => {
      insertPendingAccountSync('a-late');
      void requestPush('u');
    });

    await requestPush('u');

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-late')).toBe(true);
  });
});

// A first download that loses a split read must still end with every split. On
// a device with no cursor both paths below end in a pullChanges that does not
// throw on the failure — initialPull itself gives up and leaves the cursors
// unset — so what protects them is last_txn_pull_at being held back over a
// failed split batch. Since #66 that pull also reports the failure and leaves
// last_pull_at unset rather than calling the device bootstrapped. They live
// here because they drive the lock-managing entry points.
describe('a first download whose split read fails still converges', () => {
  function seedOneSplitTransaction() {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -5, memo: null },
      { id: 's2', transaction_id: 't1', amount: -7, memo: null },
    ];
  }

  async function localSplitIds() {
    const rows = await ctx.adapter.getAllAsync(
      'SELECT id FROM transaction_splits ORDER BY id'
    );
    return rows.map((r: any) => r.id);
  }

  it('when the bootstrap found the lock held and ran as a queued full sync', async () => {
    seedOneSplitTransaction();
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });

    // requestPush takes the lock before its first await, so initialPull finds
    // it held and queues a full sync instead of bootstrapping.
    const holder = requestPush('u');
    expect(getSyncSnapshot().isSyncing).toBe(true);
    await initialPull('u');
    await holder;

    // t1 was upserted by that pull and already matches the server. Banked
    // here, the cursor would put it beyond every later incremental read, and
    // the reconcile would never refresh it either.
    expect(ctx.meta.get('last_txn_pull_at:u')).toBeUndefined();
    // Reported, and not stamped (#66): this device has still never completed a
    // pull, so "Last synced" stays "Never", needsInitialPull stays true, and
    // the status line says which table it could not download.
    expect(getSyncSnapshot().lastError).toMatch(/download transaction splits/);
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();

    ctx.installSupabase();
    await fullSync('u');

    expect(await localSplitIds()).toEqual(['s1', 's2']);
    // Every lock holder clears lastError on entry, so the report lasts only
    // until the next sync starts: the #54 helpers, which wait for the label to
    // read exactly `Synced`, still get there after the next push. And a pull
    // that completes stamps.
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
  });

  it('when the split read fails for the whole startup sequence', async () => {
    seedOneSplitTransaction();
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });

    // No collision. initialPull gives up with the cursors unset, as designed,
    // and startSyncSession's own fullSync then runs the same swallowing pull
    // the queued path does: fixing the queue alone leaves this one broken.
    await startSyncSession('u');

    expect(ctx.meta.get('last_txn_pull_at:u')).toBeUndefined();
    // The fullSync's own report, not initialPull's: that one said "initialPull
    // splits batch failed", and the fullSync cleared it on entry (#66).
    expect(getSyncSnapshot().lastError).toMatch(/download transaction splits/);
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();

    ctx.installSupabase();
    await fullSync('u');

    expect(await localSplitIds()).toEqual(['s1', 's2']);
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
  });
});

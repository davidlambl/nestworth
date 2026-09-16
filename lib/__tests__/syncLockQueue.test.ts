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
import {
  getSyncSnapshot,
  refreshSyncState,
  subscribeSyncStatus,
  type SyncStatusSnapshot,
} from '../syncStatus';
import {
  ACCOUNT_COLS,
  insertLocalTxn,
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

  it('never publishes isSyncing=false with a stale pending count', async () => {
    // The #54 contract: the sidebar reads `Synced` from isSyncing=false and a
    // zero count, so the count must be refreshed before the flag is cleared.
    await insertLocalTxn(ctx.adapter, { id: 'T1', _sync_status: 'pending' });
    ctx.installSupabase({ failWrites: true });
    const snapshots: SyncStatusSnapshot[] = [];
    const stop = subscribeSyncStatus(() => {
      snapshots.push(getSyncSnapshot());
    });

    await fullSync('u');
    stop();

    const firstIdle = snapshots.find((s) => !s.isSyncing);
    expect(firstIdle).toBeDefined();
    expect(firstIdle!.pendingCount).toBe(1);
  });
});

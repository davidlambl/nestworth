// Regression tests for #63: the sync lock's queue flags belong to the HOLDER's
// user. `_pushQueued`/`_fullSyncQueued` carry no user id, and finishSync drains
// them as the holder, while every push read and pull filter is
// `user_id = ?`-scoped — so a request queued by user B used to run as A and
// touch nothing of B's. It is reachable on any account switch: useSyncEngine is
// keyed on the user id and its cleanup only flips `cancelled`, so A's session
// keeps the lock while startSyncSession(B) starts and hits the queue branches.
//
// The fix keeps the flags holder-only and makes a request for another user WAIT
// for the release and take the lock itself.
//
// Own file, deliberately: `_syncInProgress`, `_holderUserId` and the queue
// flags in lib/sync.ts are module state shared by every test in a file, so a
// suite that leaves a sync in flight makes the tests after it pass vacuously.
// Every test here awaits everything it started, and afterEach asserts the lock
// is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { fullSync, initialPull, requestPush, resetLocalData } from '../sync';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import {
  insertLocalAccount,
  remoteAccount,
  wireSyncMocks,
} from '../testing/syncFixture';

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(async () => {
  ctx = wireSyncMocks();
  // The status store is module state too; start every test from a fresh count.
  await refreshSyncState('a');
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

const serverHasAccount = (id: string) =>
  ctx.store.accounts.some((a: any) => a.id === id);

async function localStatus(table: string, id: string) {
  const row: any = await ctx.adapter.getFirstAsync(
    `SELECT _sync_status FROM ${table} WHERE id = ?`,
    [id]
  );
  return row?._sync_status ?? null;
}

/**
 * Takes the lock as user 'a' and proves it is held before the test makes its
 * request for 'b'. requestPush acquires synchronously, before its first await —
 * the same idiom syncLockQueue.test.ts:238-241 relies on.
 */
function holdLockAsA(): Promise<void> {
  const holder = requestPush('a');
  expect(getSyncSnapshot().isSyncing).toBe(true);
  return holder;
}

describe("a sync requested for a user other than the lock holder's", () => {
  it("pushes the requesting user's rows, not the holder's", async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'b1',
      user_id: 'b',
      _sync_status: 'pending',
    });

    const holder = holdLockAsA();
    const b = requestPush('b');
    await holder;
    await b;

    expect(serverHasAccount('b1')).toBe(true);
    expect(await localStatus('accounts', 'b1')).toBe('synced');
  });

  it("runs a full sync for the requesting user, and never stamps the holder's cursor", async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'b1',
      user_id: 'b',
      _sync_status: 'pending',
    });
    ctx.store.accounts = [remoteAccount({ id: 'b-remote', user_id: 'b' })];

    const holder = holdLockAsA();
    const b = fullSync('b');
    await holder;
    await b;

    expect(serverHasAccount('b1')).toBe(true);
    expect(await localStatus('accounts', 'b-remote')).toBe('synced');
    // last_pull_at:a proves whose sync ran: a queued drain would stamp the
    // holder's key, since the holder is the one that drains.
    expect(ctx.meta.get('last_pull_at:b')).toBeTruthy();
    expect(ctx.meta.get('last_pull_at:a')).toBeUndefined();
  });

  it('bootstraps the requesting user for real rather than degrading to a full sync', async () => {
    // No remote transactions for 'b' at all. That is what discriminates a real
    // bootstrap from the degraded substitute: initialPull stamps
    // last_txn_reconcile_at unconditionally, while pullChanges banks it only
    // when the enumeration actually returned rows (an empty read is never
    // authoritative), so it can never bank the key for this user.
    ctx.store.accounts = [remoteAccount({ id: 'b-remote', user_id: 'b' })];

    const holder = holdLockAsA();
    const b = initialPull('b');
    await holder;
    await b;

    expect(await localStatus('accounts', 'b-remote')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:b')).toBeTruthy();
    expect(ctx.meta.get('last_txn_reconcile_at:b')).toBeTruthy();
    expect(ctx.meta.get('last_pull_at:a')).toBeUndefined();
  });

  it('waits for a reset that holds the lock, then syncs its own user', async () => {
    // resetLocalData keeps its refusal — it never checks who holds the lock —
    // but it must SET the holder, or a request for another user arriving during
    // the reset is mis-queued into the reset's own drain and runs as 'a'.
    ctx.store.accounts = [remoteAccount({ id: 'b-remote', user_id: 'b' })];

    const holder = resetLocalData('a');
    expect(getSyncSnapshot().isSyncing).toBe(true);
    const b = fullSync('b');
    await holder;
    await b;

    expect(await localStatus('accounts', 'b-remote')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:b')).toBeTruthy();
  });
});

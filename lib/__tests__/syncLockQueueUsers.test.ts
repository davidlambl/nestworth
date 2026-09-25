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
// By then the session is B's, and since #111 the engine refuses A's remaining
// work under it — push, pull, bootstrap and reset each compare the session's
// user with the one they sync — rather than run it under B's token. The
// fixture answers every request as the session's user, so each test names the
// session the device holds: B's, the incoming account's, when A holds the lock
// and B asks (A's holder push, which has nothing of A's to send, is then
// refused with a warning), and A's where A is the only user.
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
  type SupabaseOpts,
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
 * the same idiom syncLockQueue.test.ts:238-241 relies on — so the lock is held
 * even when a's push is then refused under b's session (#111): it is released
 * only from the holder's finally.
 */
function holdLockAsA(): Promise<void> {
  const holder = requestPush('a');
  expect(getSyncSnapshot().isSyncing).toBe(true);
  return holder;
}

const PENDING_ACCOUNTS_READ = /FROM accounts WHERE _sync_status = 'pending'/;
/** pullTableFull's local drift read — it runs AFTER wipeLocalData in a reset. */
const PULL_LOCAL_ACCOUNTS_READ =
  /FROM accounts\s+WHERE user_id = \?\s+AND _sync_status = 'synced'/;

/**
 * Suspends the first read matching `match` on `block`, so a test can park a
 * lock holder at a chosen point. `'before'` blocks in place of the read,
 * `'after'` once it has resolved. Returns a promise that settles when the gate
 * is reached — the engine advances on microtasks here, so a test that needs the
 * holder to be AT the gate must await this rather than count `Promise.resolve`s.
 */
function gateFirstRead(
  match: RegExp,
  when: 'before' | 'after',
  block: () => Promise<void>
): Promise<void> {
  const real = ctx.adapter.getAllAsync.bind(ctx.adapter);
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let fired = false;
  ctx.adapter.getAllAsync = async (sql: string, params: any[] = []) => {
    if (!fired && match.test(sql)) {
      fired = true;
      if (when === 'before') {
        arrive();
        await block();
        return real(sql, params);
      }
      const rows = await real(sql, params);
      arrive();
      await block();
      return rows;
    }
    return real(sql, params);
  };
  return arrived;
}

describe("a sync requested for a user other than the lock holder's", () => {
  it("pushes the requesting user's rows, not the holder's", async () => {
    ctx.installSupabase({ sessionUserId: 'b' });
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
    ctx.installSupabase({ sessionUserId: 'b' });
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
    // last_pull_at:b proves whose sync ran: a queued drain runs as the holder,
    // so it would pull as a (refused under b's session since #111) and stamp
    // nothing of b's. Before #111 it also stamped last_pull_at:a, over a read
    // b's session answered `[]`.
    expect(ctx.meta.get('last_pull_at:b')).toBeTruthy();
    expect(ctx.meta.get('last_pull_at:a')).toBeUndefined();
  });

  it('bootstraps the requesting user for real rather than degrading to a full sync', async () => {
    // No remote transactions for 'b' at all. That is what discriminates a real
    // bootstrap from the degraded substitute: initialPull stamps
    // last_txn_reconcile_at unconditionally, while pullChanges banks it only
    // when the enumeration actually returned rows (an empty read is never
    // authoritative), so it can never bank the key for this user.
    ctx.installSupabase({ sessionUserId: 'b' });
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
    // and a request for another user arriving during it must not be queued into
    // the reset's own drain, which would run as 'a'. (What pins the reset
    // RECORDING itself as the holder is the same-user test below: with
    // _holderUserId left null, this cross-user branch is taken either way.)
    //
    // b's session throughout (#111). a's reset is refused at its first session
    // check, but it takes the lock before that check's await and releases it
    // only from its finally, so b's full sync still arrives while it is held
    // and has to wait. One session cannot serve a reset that runs to the end
    // as a and a sync that then runs as b: b's first session check runs in the
    // microtask the reset's release queues, before anything awaiting the
    // reset can switch it.
    ctx.installSupabase({ sessionUserId: 'b' });
    ctx.store.accounts = [remoteAccount({ id: 'b-remote', user_id: 'b' })];

    const holder = resetLocalData('a');
    expect(getSyncSnapshot().isSyncing).toBe(true);
    const b = fullSync('b');
    let err: unknown = null;
    try {
      await holder;
    } catch (e) {
      err = e;
    }
    await b;

    // String(err), not rejects.toThrow(): the sync suites are realm-sensitive.
    expect(String(err)).toMatch(/different account/);
    // Queued into the reset's drain, b's sync would have run as a — refused
    // under b's session — and b-remote would never have landed.
    expect(await localStatus('accounts', 'b-remote')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:b')).toBeTruthy();
  });

  // THE REGRESSION MODE OF THIS TEST IS A HUNG JEST WORKER, NOT A RED
  // ASSERTION. `await _inFlight` only yields if _inFlight is an unsettled
  // deferred. Reduce acquireLock to setting the flags alone and it becomes
  // `await null`: the wait loop resolves at once, re-checks a flag that is still
  // set, and spins in MICROTASKS — which starves the macrotask queue, so the
  // holder's timer below never fires. Nothing recovers from that inside jest;
  // even `testTimeout` is a timer and cannot fire either, so the worker hangs
  // until something outside kills it. The generous timeout below is
  // documentation, not a guard. Every other test in this file stays green under
  // that same mutation, because the fixture is otherwise pure microtasks.
  it('yields to the event loop, so a holder that needs a macrotask can finish', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'b1',
      user_id: 'b',
      _sync_status: 'pending',
    });
    // a's session until its push reaches the gate, and b's from there on: b
    // signs in while a's sync is parked mid-push (#111). The holder has to be
    // doing real work when b starts waiting, and b's push has to be signed as
    // b. Under b's session from the start, a's push is refused before it reads
    // anything and finishes on microtasks alone, and the regression below
    // could no longer hang anything.
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);
    // Real SQLite and a real fetch resolve on macrotasks; the fixture's adapter
    // resolves on microtasks alone, so the block has to be an actual timer for
    // the difference to be observable at all.
    gateFirstRead(PENDING_ACCOUNTS_READ, 'before', () => {
      remote.sessionUserId = 'b';
      return new Promise<void>((resolve) => setTimeout(resolve, 10));
    });

    const holder = holdLockAsA();
    const b = requestPush('b');
    await holder;
    await b;

    expect(serverHasAccount('b1')).toBe(true);
    expect(await localStatus('accounts', 'b1')).toBe('synced');
  }, 20_000);
});

describe('a reset records itself as the lock holder', () => {
  it('queues a same-user push rather than making it wait, and drains it inside the reset', async () => {
    // The discriminator for acquireLock inside resetLocalData. With the holder
    // left unrecorded the reset still takes the lock, so the cross-user test
    // above passes anyway — but a SAME-user request then reads _holderUserId as
    // null, takes the other-user branch, and waits for the release instead of
    // queuing. Here it must return at once with the lock still held, and its
    // row must reach the server from the reset's own drain.
    //
    // a is the only user here, and the one signed in (#111).
    ctx.installSupabase({ sessionUserId: 'a' });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Suspend the reset inside pullChanges — i.e. after wipeLocalData, so the
    // row inserted below survives, and after the pending-count check, which
    // would otherwise refuse to wipe over it.
    const parked = gateFirstRead(PULL_LOCAL_ACCOUNTS_READ, 'after', () => gate);

    const reset = resetLocalData('a');
    expect(getSyncSnapshot().isSyncing).toBe(true);
    await parked;
    expect(getSyncSnapshot().isSyncing).toBe(true);

    let queuedResolved = false;
    const queued = requestPush('a').then(() => {
      queuedResolved = true;
    });
    // The same-user branch sets a flag and returns without awaiting anything,
    // so one microtask is enough; three is slack. A waiter, by contrast, cannot
    // resolve until open() below.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(queuedResolved).toBe(true);
    expect(getSyncSnapshot().isSyncing).toBe(true);

    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      user_id: 'a',
      _sync_status: 'pending',
    });
    open();
    await reset;
    await queued;

    expect(serverHasAccount('a1')).toBe(true);
    expect(await localStatus('accounts', 'a1')).toBe('synced');
  });
});

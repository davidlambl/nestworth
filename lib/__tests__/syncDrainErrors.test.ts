// Regression tests for #65: finishSync's drain cleared lastError before EVERY
// queued follow-up, so a push that a mutation queued while the holder was
// failing wiped the holder's report off the status line — a failed reset's
// message (#65), and since #66 the report of a pull that could not read every
// table while the device was still stale. A queued push redoes only the push
// and can undo neither. Only a queued FULL sync, which redoes the pull as well,
// clears the line before it runs.
//
// Each regression test also pins what ends the message: the next sync to take
// the lock clears it on entry — a push, a bootstrap, a retried reset. That is
// what bounds (G)'s cost to "until the next sync starts", and nothing else in
// the suite notices if one of those clears goes: without requestPush's, a
// write after any failed sync would leave `Sync error` until the next full
// sync, which is option (E) by accident. fullSync's is pinned in
// syncLockQueue.test.ts.
//
// Own file, deliberately: `_syncInProgress`, the queue flags and `lastError`
// are module state shared by every test in a file, so a suite that leaves a
// sync in flight or an error set makes the tests after it pass vacuously. Every
// test awaits everything it started, and afterEach asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { getDb } from '../db';
import {
  fullSync,
  initialPull,
  needsInitialPull,
  requestPush,
  resetLocalData,
} from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import { statusLabel } from '../syncStatusHelpers';
import {
  ACCOUNT_COLS,
  insertLocalAccount,
  remoteAccount,
  remoteRule,
  wireSyncMocks,
  type SupabaseOpts,
} from '../testing/syncFixture';

const NOW = '2026-01-01T00:00:00Z';
const T0 = '2026-06-15T00:00:00Z';

// The reset's pre-wipe guard: what its own push left unsynced.
const RESET_GUARD = /_sync_status IN \('pending','deleted'\)/;
// upsertRemoteAccount. In the reset, the first one is the download's, past the
// wipe.
const ACCOUNT_UPSERT = /INSERT INTO accounts/;
// The first read of every push.
const PENDING_ACCOUNTS_READ = /FROM accounts WHERE _sync_status = 'pending'/;

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

/**
 * What a mutation hook does while a sync holds the lock: a pending row written
 * straight to SQLite. Synchronous, and past the adapter, so it cannot re-enter
 * the hook that calls it.
 */
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

/**
 * Runs `fn` right after the first call of `method` whose SQL matches `match`
 * resolves: a known point inside the holder, with the lock held.
 */
function afterFirst(
  method: 'getAllAsync' | 'getFirstAsync' | 'runAsync',
  match: RegExp,
  fn: () => void
): () => boolean {
  const real = ctx.adapter[method].bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  let fired = false;
  (ctx.adapter as any)[method] = async (sql: string, params: any[] = []) => {
    const out = await real(sql, params);
    if (!fired && match.test(sql)) {
      fired = true;
      fn();
    }
    return out;
  };
  return () => fired;
}

/** The header label, as the #54 Playwright helpers read it. */
const label = () => statusLabel(getSyncSnapshot());

const serverHasAccount = (id: string) =>
  ctx.store.accounts.some((a: any) => a.id === id);

async function localStatus(id: string) {
  const row: any = await ctx.adapter.getFirstAsync(
    'SELECT _sync_status FROM accounts WHERE id = ?',
    [id]
  );
  return row?._sync_status ?? null;
}

/**
 * Runs a reset that must fail, and returns its rejection as a string.
 * resetLocalData drains the queue in its finally, so everything queued during
 * it has run by the time this returns.
 */
async function failedReset(): Promise<string> {
  let err: unknown = null;
  try {
    await resetLocalData('u');
  } catch (e) {
    err = e;
  }
  // String(err), never rejects.toThrow(): better-sqlite3 binds its error class
  // per realm, and these suites share a worker.
  return String(err);
}

/**
 * A reset refused by its own guard: an edit whose upload failed is still
 * pending, and the reset will not wipe it. At the guard — the reset's push has
 * failed, the lock is still held — `during` runs and the network comes back,
 * so whatever the drain runs afterwards reaches the server.
 */
async function refusedResetWith(during: () => void): Promise<string> {
  await insertLocalAccount(ctx.adapter, {
    id: 'a-stuck',
    _sync_status: 'pending',
  });
  const remote: SupabaseOpts = { failWrites: true };
  ctx.installSupabase(remote);
  const fired = afterFirst('getFirstAsync', RESET_GUARD, () => {
    remote.failWrites = false;
    during();
  });

  const err = await failedReset();

  expect(fired()).toBe(true);
  expect(err).toMatch(/Couldn't upload 1 unsynced change\(s\)/);
  expect(err).toMatch(/reset cancelled/);
  return err;
}

/** The status line holds exactly the message the reset rejected with. */
function expectResetMessageKept(err: string) {
  expect(getSyncSnapshot().lastError).toBe(err.replace(/^Error: /, ''));
}

describe("a queued push does not clear the holder's failure (#65)", () => {
  it("a push queued during a reset that was refused leaves the reset's message until the reset is retried", async () => {
    const err = await refusedResetWith(() => {
      insertPendingAccountSync('a-typed');
      void requestPush('u');
    });

    // The queued push ran after the reset, and it succeeded: both edits are
    // on the server. It still did not reset anything.
    expect(serverHasAccount('a-stuck')).toBe(true);
    expect(serverHasAccount('a-typed')).toBe(true);
    expect(await localStatus('a-typed')).toBe('synced');
    expectResetMessageKept(err);
    expect(label()).toBe('Sync error');

    // The retry clears the line on entry, and with nothing left pending it
    // completes.
    await resetLocalData('u');
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(label()).toBe('Synced');
  });

  it("a push queued during a reset whose download failed leaves the reset's message until the next launch bootstraps", async () => {
    // Past the wipe, the download fetches accounts and then fails on rules:
    // the device now holds part of its data. A push cannot re-read the rules.
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
    ctx.installSupabase({ errorReadsOn: new Set(['recurring_rules']) });
    const fired = afterFirst('runAsync', ACCOUNT_UPSERT, () => {
      insertPendingAccountSync('a-typed');
      void requestPush('u');
    });

    const err = await failedReset();

    expect(fired()).toBe(true);
    expect(err).toContain('Failed to download recurring_rules');
    expect(serverHasAccount('a-typed')).toBe(true);
    expect(await localStatus('a-typed')).toBe('synced');
    expectResetMessageKept(err);
    expect(label()).toBe('Sync error');

    // Only a push ran after the failed download, so both pull keys are still
    // unset and the next launch bootstraps. That clears the line on entry.
    expect(await needsInitialPull('u')).toBe(true);
    ctx.installSupabase();
    await initialPull('u');
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(label()).toBe('Synced');
  });

  it("a push queued during a sync whose pull was incomplete leaves the pull's report until the next push takes the lock", async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.meta.set('last_pull_at:u', T0);
    ctx.installSupabase({ errorReadsOn: new Set(['accounts']) });
    const fired = afterFirst('getAllAsync', PENDING_ACCOUNTS_READ, () => {
      // Too late for the holder's own push, which has read its list already.
      insertPendingAccountSync('a-typed');
      void requestPush('u');
    });

    await fullSync('u');

    expect(fired()).toBe(true);
    expect(serverHasAccount('a-typed')).toBe(true);
    expect(await localStatus('a-typed')).toBe('synced');
    // No complete pull since T0, so the device is still stale (#66), and the
    // line keeps saying why.
    expect(ctx.meta.get('last_pull_at:u')).toBe(T0);
    expect(getSyncSnapshot().lastError).toMatch(
      /^Couldn't download accounts: /
    );
    expect(label()).toBe('Sync error');

    // The next push that takes the lock clears the line on entry, although it
    // pulls nothing and the device is still stale: "Last synced" stays T0.
    // That is (G). Were this push to leave the report too, the #54 helpers
    // would wait out `Sync error` after every write that follows a failed pull.
    await requestPush('u');
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(label()).toBe('Synced');
    expect(ctx.meta.get('last_pull_at:u')).toBe(T0);
  });
});

describe('what the drain still does with lastError', () => {
  it('a FULL sync queued during the refused reset clears the message, because it pushes and pulls', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    // What the reconnection trigger or Sync now does while the reset runs.
    let queued: Promise<void> = Promise.resolve();
    await refusedResetWith(() => {
      insertPendingAccountSync('a-typed');
      queued = fullSync('u');
    });
    await queued;

    // It ran after the reset: both edits pushed, and a complete pull stamped.
    expect(serverHasAccount('a-stuck')).toBe(true);
    expect(serverHasAccount('a-typed')).toBe(true);
    expect(await localStatus('a1')).toBe('synced');
    expect(ctx.meta.get('last_pull_at:u')).toBeTruthy();
    // It re-established everything the line describes and found nothing
    // wrong. Had its pull been incomplete, pullChanges would have said so.
    expect(getSyncSnapshot().lastError).toBeNull();
  });

  it('a queued push that throws reports its own error: the latest failure wins', async () => {
    await refusedResetWith(() => {
      void requestPush('u');
      // The drained push fails before it reads a single row.
      (getDb as unknown as jest.Mock).mockImplementation(async () => {
        throw new Error('database is closed');
      });
    });

    expect(getSyncSnapshot().lastError).toContain('database is closed');
  });
});

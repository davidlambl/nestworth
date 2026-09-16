// The sidebar label reads `Synced` when isSyncing is false AND the pending
// count is zero (lib/syncStatusHelpers.ts). The Playwright helpers wait on that
// exact word to prove a spec's deletes were pushed before the browser context
// closes (issue #54), so the engine must never publish isSyncing=false while
// the count it last published is stale. These tests pin the order of the two
// writes, now made in `finishSync`, which every lock holder ends in (#55).
//
// Own file, deliberately: `_syncInProgress` in lib/sync.ts is module state
// shared by every test in a file, so a suite that leaves a sync in flight makes
// the tests after it pass vacuously.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { fullSync, requestPush } from '../sync';
import {
  getSyncSnapshot,
  refreshSyncState,
  subscribeSyncStatus,
  type SyncStatusSnapshot,
} from '../syncStatus';
import { statusLabel } from '../syncStatusHelpers';
import {
  ACCOUNT_COLS,
  insertLocalTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

let ctx: ReturnType<typeof wireSyncMocks>;
let warn: jest.SpyInstance;

beforeEach(async () => {
  ctx = wireSyncMocks();
  // The status store is module state too. Re-read it against the fresh, empty
  // DB so the count starts at 0 — otherwise a count left behind by the
  // previous test can make "the first idle snapshot says 1 pending" pass for
  // the wrong reason.
  await refreshSyncState('u');
  expect(getSyncSnapshot().pendingCount).toBe(0);
  // The empty fake store trips the "empty remote read" guard's warning on
  // every pull; it is not what these tests are about.
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  ctx.adapter._sqlite.close();
});

/** Every snapshot the store emits, in order, until `stop()`. */
function recordEmits() {
  const snapshots: SyncStatusSnapshot[] = [];
  const stop = subscribeSyncStatus(() => {
    snapshots.push(getSyncSnapshot());
  });
  return { snapshots, stop };
}

describe('sync status ordering', () => {
  it('never publishes isSyncing=false with a stale pending count', async () => {
    // A pending row the server refuses stays pending after the sync, so the
    // count the finally block publishes must already say so.
    await insertLocalTxn(ctx.adapter, { id: 'T1', _sync_status: 'pending' });
    ctx.installSupabase({ failWrites: true });

    const rec = recordEmits();
    await fullSync('u');
    rec.stop();

    const firstIdle = rec.snapshots.find((s) => !s.isSyncing);
    expect(firstIdle).toBeDefined();
    expect(firstIdle!.pendingCount).toBe(1);
    expect(statusLabel(firstIdle!)).toBe('1 pending');
    expect(getSyncSnapshot().isSyncing).toBe(false);
  });

  it('never publishes `Synced` while a push queued mid-sync is still local', async () => {
    // The #54 shape: a create (a delete behaves identically) lands while a
    // sync holds the lock, so its requestPush is queued. A spec polling for
    // the exact word `Synced` must not see it until that row has reached the
    // server.
    //
    // This test was written against the old engine, where the holder released
    // the lock at `1 pending` and the queued push ran afterwards as its own
    // fire-and-forget cycle — so it asserted two idle publications. Since #55
    // the holder drains the queue *inside* the lock, and there is exactly one
    // idle publication, already `Synced`. The property being pinned is the
    // same and is now stated directly: no idle snapshot may claim `Synced`
    // while the queued row is still only local.
    const serverHasLate = () =>
      ctx.store.accounts.some((a: any) => a.id === 'a-late');

    const realGetAll = ctx.adapter.getAllAsync.bind(ctx.adapter);
    let fired = false;
    ctx.adapter.getAllAsync = async (sql: string, params: any[] = []) => {
      const rows = await realGetAll(sql, params);
      if (!fired && /FROM accounts[\s\S]*_sync_status = 'pending'/.test(sql)) {
        fired = true;
        ctx.adapter._sqlite
          .prepare(
            `INSERT INTO accounts (${ACCOUNT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'a-late',
            'u',
            'Created mid-sync',
            'checking',
            null,
            0,
            0,
            0,
            0,
            '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:00Z',
            'pending'
          );
        void requestPush('u');
      }
      return rows;
    };

    // The property is a relation between the snapshot and the server, so
    // record both at every emit.
    const seen: { snap: SyncStatusSnapshot; onServer: boolean }[] = [];
    const stop = subscribeSyncStatus(() => {
      seen.push({ snap: getSyncSnapshot(), onServer: serverHasLate() });
    });
    await fullSync('u');
    stop();

    expect(fired).toBe(true);
    // Drained inside the lock, so the row is up by the time the holder's
    // promise resolves — there is no fire-and-forget window to wait out.
    expect(serverHasLate()).toBe(true);

    const idle = seen.filter((s) => !s.snap.isSyncing);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    for (const s of idle) {
      expect(s.onServer).toBe(true);
      expect(s.snap.pendingCount).toBe(0);
      expect(statusLabel(s.snap)).toBe('Synced');
    }
    expect(getSyncSnapshot().isSyncing).toBe(false);
  });
});

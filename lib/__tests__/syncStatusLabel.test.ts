// The sidebar label reads `Synced` when isSyncing is false AND the pending
// count is zero (lib/syncStatusHelpers.ts). The Playwright helpers wait on that
// exact word to prove a spec's deletes were pushed before the browser context
// closes (issue #54), so the engine must never publish isSyncing=false while
// the count it last published is stale. These tests pin the order of the two
// writes in the sync engine's finally blocks.
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

/** Yield until `cond()` holds — the drained push is fire-and-forget. */
async function waitUntil(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(cond()).toBe(true);
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

  it('shows `Synced` only after a push queued mid-sync has drained', async () => {
    // The #54 shape: a delete (here, a create) lands while a sync holds the
    // lock, so its requestPush is queued. Between the holder finishing and the
    // queued push starting, the label must read "1 pending", never "Synced" —
    // a spec polling for `Synced` at that instant would close the browser
    // with the row still local.
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

    const rec = recordEmits();
    await fullSync('u');
    expect(fired).toBe(true);
    // fullSync's finally drains the queued push without awaiting it.
    await waitUntil(
      () =>
        !getSyncSnapshot().isSyncing &&
        ctx.store.accounts.some((a: any) => a.id === 'a-late')
    );
    rec.stop();

    const idle = rec.snapshots.filter((s) => !s.isSyncing);
    expect(idle.length).toBeGreaterThanOrEqual(2);
    // The first idle publication is the holder's: the queued row is still
    // local, and the count must say so.
    expect(idle[0].pendingCount).toBe(1);
    expect(statusLabel(idle[0])).toBe('1 pending');
    // The last one is the drained push's: the row is on the server.
    expect(idle[idle.length - 1].pendingCount).toBe(0);
    expect(statusLabel(idle[idle.length - 1])).toBe('Synced');
  });
});

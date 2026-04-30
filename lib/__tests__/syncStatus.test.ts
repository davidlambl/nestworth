// Mock the DB layer so refreshSyncState can run without a real SQLite instance.
// Each test installs its own per-call return values via the mock fns.
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
}));

import { getDb, getSyncMeta } from '../db';
import {
  setSyncing,
  setLastError,
  setOnline,
  subscribeSyncStatus,
  refreshPendingCount,
  refreshLastSynced,
  refreshSyncState,
  getSyncSnapshot,
} from '../syncStatus';

const mockedGetDb = getDb as jest.MockedFunction<typeof getDb>;
const mockedGetSyncMeta = getSyncMeta as jest.MockedFunction<typeof getSyncMeta>;

function fakeDb(counts: { accounts: number; txns: number; splits: number; rules: number }) {
  // Four sequential getFirstAsync calls in readPendingCounts:
  //   accounts → transactions → splits → rules
  const responses = [counts.accounts, counts.txns, counts.splits, counts.rules];
  let i = 0;
  return {
    getFirstAsync: jest.fn(async () => ({ c: responses[i++] ?? 0 })),
  };
}

beforeEach(() => {
  // Reset state to a known baseline. The store is module-level so leakage
  // between tests would otherwise make the dedup assertions order-dependent.
  setSyncing(false);
  setLastError(null);
  setOnline(true);
  mockedGetDb.mockReset();
  mockedGetSyncMeta.mockReset();
});

describe('setSyncing', () => {
  it('emits when the value changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);
    setSyncing(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('skips emit when the value is unchanged', () => {
    setSyncing(true);
    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);
    setSyncing(true);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('setLastError', () => {
  it('skips emit when the error message is the same', () => {
    setLastError('boom');
    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);
    setLastError('boom');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('setOnline', () => {
  it('skips emit when the online state is unchanged', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);
    setOnline(true); // already true from beforeEach
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('refreshSyncState', () => {
  it('emits exactly once per call (the coalesced version)', async () => {
    mockedGetDb.mockResolvedValue(fakeDb({ accounts: 2, txns: 5, splits: 0, rules: 1 }) as any);
    mockedGetSyncMeta.mockResolvedValue('2026-04-29T11:00:00.000Z');

    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);

    await refreshSyncState('user-1');

    // Coalesced: one merged state assignment, one emit. The pre-fix code
    // path called refreshPendingCount + refreshLastSynced separately and
    // emitted twice — driving extra header re-renders that contributed to
    // the iOS reorder chop.
    expect(listener).toHaveBeenCalledTimes(1);

    const snap = getSyncSnapshot();
    expect(snap.pendingCount).toBe(8);
    expect(snap.pendingAccounts).toBe(2);
    expect(snap.pendingTransactions).toBe(5);
    expect(snap.pendingRules).toBe(1);
    expect(snap.lastSyncedAt).toBe('2026-04-29T11:00:00.000Z');

    unsubscribe();
  });
});

describe('refreshPendingCount + refreshLastSynced (granular setters)', () => {
  it('still emit independently — preserved for callers that only need one', async () => {
    mockedGetDb.mockResolvedValue(fakeDb({ accounts: 1, txns: 0, splits: 0, rules: 0 }) as any);
    mockedGetSyncMeta.mockResolvedValue(null);

    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);

    await refreshPendingCount('user-1');
    await refreshLastSynced('user-1');

    // Two calls → two emits, by design. Coalescing belongs in
    // refreshSyncState; these are still useful when only one piece of
    // state needs to change (e.g. after a single mutation).
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

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
  refreshSyncState,
  getSyncSnapshot,
} from '../syncStatus';

const mockedGetDb = getDb as jest.MockedFunction<typeof getDb>;
const mockedGetSyncMeta = getSyncMeta as jest.MockedFunction<
  typeof getSyncMeta
>;

function fakeDb(counts: {
  accounts: number;
  txns: number;
  splits: number;
  rules: number;
}) {
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
    mockedGetDb.mockResolvedValue(
      fakeDb({ accounts: 2, txns: 5, splits: 0, rules: 1 }) as any
    );
    mockedGetSyncMeta.mockResolvedValue('2026-04-29T11:00:00.000Z');

    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);

    await refreshSyncState('user-1');

    // Coalesced: one merged state assignment, one emit. The pre-fix code
    // path refreshed the counts and the time separately and emitted twice —
    // driving extra header re-renders that contributed to the iOS reorder
    // chop.
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

describe('whose numbers the snapshot holds (#193)', () => {
  const T1 = '2026-10-20T08:00:00.000Z';
  const T2 = '2026-10-22T09:30:00.000Z';
  const pulledAt = async (k: string) =>
    k === 'last_pull_at:user-1' ? T1 : k === 'last_pull_at:user-2' ? T2 : null;
  const whose = () => {
    const s = getSyncSnapshot();
    return {
      user: s.snapshotUserId,
      pending: s.pendingCount,
      lastSyncedAt: s.lastSyncedAt,
    };
  };

  it('stamps the counts and the time with the user they were read for, in the one emit', async () => {
    mockedGetDb
      .mockResolvedValueOnce(
        fakeDb({ accounts: 1, txns: 0, splits: 0, rules: 0 }) as any
      )
      .mockResolvedValueOnce(
        fakeDb({ accounts: 0, txns: 3, splits: 1, rules: 0 }) as any
      );
    mockedGetSyncMeta.mockImplementation(pulledAt);
    const listener = jest.fn();
    const unsubscribe = subscribeSyncStatus(listener);

    await refreshSyncState('user-1');
    const one = whose();
    await refreshSyncState('user-2');
    const two = whose();
    unsubscribe();

    expect({ one, two, emits: listener.mock.calls.length }).toEqual({
      one: { user: 'user-1', pending: 1, lastSyncedAt: T1 },
      two: { user: 'user-2', pending: 4, lastSyncedAt: T2 },
      emits: 2,
    });
  });

  it('is never half one user and half another when two refreshes cross', async () => {
    // user-1's refresh reads its counts, then waits on its time while
    // user-2's whole refresh lands; user-1's lands last and wins whole.
    let releaseOne!: () => void;
    const one = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    mockedGetDb
      .mockResolvedValueOnce(
        fakeDb({ accounts: 1, txns: 0, splits: 0, rules: 0 }) as any
      )
      .mockResolvedValueOnce(
        fakeDb({ accounts: 0, txns: 3, splits: 1, rules: 0 }) as any
      );
    mockedGetSyncMeta.mockImplementation(async (k: string) => {
      if (k === 'last_pull_at:user-1') {
        await one;
      }
      return pulledAt(k);
    });

    const first = refreshSyncState('user-1');
    // Let user-1 reach its time read before user-2 starts.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    await refreshSyncState('user-2');
    const between = whose();
    releaseOne();
    await first;

    expect({ between, after: whose() }).toEqual({
      between: { user: 'user-2', pending: 4, lastSyncedAt: T2 },
      after: { user: 'user-1', pending: 1, lastSyncedAt: T1 },
    });
  });
});

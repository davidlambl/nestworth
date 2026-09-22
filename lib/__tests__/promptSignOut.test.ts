// "Sync & Sign Out" used to await `fullSync` with no upper bound (#67): the
// per-request timeout added in lib/supabase.ts does not bound it, because a
// caller that finds the lock held waits on ANOTHER holder's request plus its
// queued follow-ups (lib/sync.ts:135-143). The dialog then never returned — no
// progress, no cancel, no second dialog — and the user was left staring at it.
//
// These tests drive that wait with fake timers. react-native is mocked down to
// the two things this module uses, so the suite neither pulls in the real
// Platform (whose OS would be fixed at 'ios' under jest-expo) nor the real
// Alert; `Platform` stays a plain object so the native case can flip `OS`.
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  Alert: { alert: jest.fn() },
}));
// Factories, not automocks: loading the real ../sync would build the real
// Supabase client at module scope (lib/supabase.ts), which needs env vars jest
// does not set.
jest.mock('../sync', () => ({ fullSync: jest.fn() }));
jest.mock('../syncStatus', () => ({
  getSyncSnapshot: jest.fn(),
  refreshSyncState: jest.fn(async () => {}),
}));

import { Alert, Platform } from 'react-native';
import { fullSync } from '../sync';
import { getSyncSnapshot } from '../syncStatus';
import { promptSignOut, SIGN_OUT_SYNC_DEADLINE_MS } from '../promptSignOut';
import type { SyncStatusSnapshot } from '../syncStatus';

const mockedFullSync = fullSync as jest.MockedFunction<typeof fullSync>;
const mockedGetSyncSnapshot = getSyncSnapshot as jest.MockedFunction<
  typeof getSyncSnapshot
>;
const mockedAlert = Alert.alert as jest.MockedFunction<typeof Alert.alert>;

type AlertButton = { text?: string; onPress?: () => void };

function snapshot(pendingCount: number): SyncStatusSnapshot {
  return {
    isSyncing: false,
    pendingCount,
    pendingAccounts: pendingCount,
    pendingTransactions: 0,
    pendingSplits: 0,
    pendingRules: 0,
    lastSyncedAt: null,
    lastError: null,
    isOnline: true,
  };
}

/** A sync that never settles: the stalled-socket / stuck-lock case. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

/** Lets every already-resolved await in promptSignOut run to its next step. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

let confirmMessages: string[];
let signOut: jest.Mock<Promise<void>, []>;
let onNavigateToSignIn: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (Platform as unknown as { OS: string }).OS = 'web';
  confirmMessages = [];
  signOut = jest.fn(async () => {});
  onNavigateToSignIn = jest.fn();
  // jest-expo runs on a node environment with a `window` alias but no dialogs.
  (window as unknown as { confirm: (m?: string) => boolean }).confirm = (m) => {
    confirmMessages.push(m ?? '');
    return true;
  };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('promptSignOut bounds the sync it waits for (#67)', () => {
  it('stops waiting after the deadline and offers sign-out anyway (web)', async () => {
    mockedFullSync.mockReturnValue(neverSettles());
    mockedGetSyncSnapshot.mockReturnValue(snapshot(2));

    // Deliberately not awaited: without a deadline this promise never settles,
    // which is the bug. The test drives the clock instead.
    void promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();
    expect(confirmMessages[0]).toContain('2 unsynced change(s)');

    await jest.advanceTimersByTimeAsync(SIGN_OUT_SYNC_DEADLINE_MS);
    await flush();

    expect(confirmMessages[1]).toContain(
      'Sync did not clear all pending changes'
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onNavigateToSignIn).toHaveBeenCalledTimes(1);
  });

  it('clears the deadline timer when the sync wins the race (web)', async () => {
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(snapshot(1)) // before the sync: warn + offer
      .mockReturnValue(snapshot(0)); // after it: nothing left to lose

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(signOut).toHaveBeenCalledTimes(1);
    // A 30 s timer left armed after the sync won would keep the JS context
    // awake and, in a test, leak into whatever runs next.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports "Sync incomplete" when the deadline passes (native)', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    mockedFullSync.mockReturnValue(neverSettles());
    mockedGetSyncSnapshot.mockReturnValue(snapshot(2));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    const buttons = mockedAlert.mock.calls[0][2] as AlertButton[];
    const syncAndSignOut = buttons.find((b) => b.text === 'Sync & Sign Out');
    expect(syncAndSignOut).toBeDefined();
    syncAndSignOut?.onPress?.();
    await flush();

    await jest.advanceTimersByTimeAsync(SIGN_OUT_SYNC_DEADLINE_MS);
    await flush();

    expect(mockedAlert.mock.calls[1]?.[0]).toBe('Sync incomplete');
    const followUp = mockedAlert.mock.calls[1]?.[2] as AlertButton[];
    followUp.find((b) => b.text === 'Sign Out Anyway')?.onPress?.();
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

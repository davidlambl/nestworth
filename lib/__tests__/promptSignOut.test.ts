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
import type { RefusedRow } from '../syncRefusals';

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
    refusedCount: 0,
    refusedTransactions: 0,
    refusedRules: 0,
    refusedSplits: 0,
    refusedRows: [],
    refusedUserId: null,
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

// Pins: with nothing waiting to sync, the plain confirmation each platform
// showed before #37 moved it onto lib/confirm.ts -- the same words and
// buttons, and a sign-out only when the person says yes.
describe('promptSignOut with nothing waiting (#37)', () => {
  beforeEach(() => {
    mockedGetSyncSnapshot.mockReturnValue(snapshot(0));
  });

  it('asks once on web, and signs out on OK', async () => {
    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages).toStrictEqual([
      'Are you sure you want to sign out?',
    ]);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onNavigateToSignIn).toHaveBeenCalledTimes(1);
  });

  it('does nothing on web when the person cancels', async () => {
    (window as unknown as { confirm: (m?: string) => boolean }).confirm = (
      m
    ) => {
      confirmMessages.push(m ?? '');
      return false;
    };

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages).toStrictEqual([
      'Are you sure you want to sign out?',
    ]);
    expect(signOut).not.toHaveBeenCalled();
    expect(mockedAlert).not.toHaveBeenCalled();
  });

  it('shows Cancel and a red Sign Out natively, and signs out from it', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';

    void promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(mockedAlert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = mockedAlert.mock.calls[0];
    const shown = buttons as (AlertButton & { style?: string })[];
    expect([title, message, shown.map((b) => [b.text, b.style])]).toStrictEqual(
      [
        'Sign Out',
        'Are you sure you want to sign out?',
        [
          ['Cancel', 'cancel'],
          ['Sign Out', 'destructive'],
        ],
      ]
    );
    expect(signOut).not.toHaveBeenCalled();
    shown.find((b) => b.text === 'Sign Out')?.onPress?.();
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(confirmMessages).toStrictEqual([]);
  });
});

/** A transaction the push was refused for good (#115), as the store lists it. */
function refusedTransaction(id: string, unsyncedSplits: number): RefusedRow {
  return {
    table: 'transactions',
    id,
    kind: 'rejected',
    code: '22003',
    since: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T09:00:00.000Z',
    accountId: 'a1',
    accountName: 'Checking',
    accountLive: true,
    txnDate: '2026-10-22',
    payee: 'Grocer',
    amount: -12.34,
    transferLinkId: null,
    partnerAccountId: null,
    partnerAccountName: null,
    unsyncedSplits,
  };
}

/**
 * `waiting` changes a sync can upload, and `refused` the push was refused for
 * good (#115) with `splits` unsynced split lines under them -- all of them
 * counted in pendingCount, as the store counts them -- read for `owner`. The
 * refused rows are transactions named after their owner, numbered from
 * `first` (u1, u2, ...), the split lines under the first.
 */
function withRefused(
  waiting: number,
  refused: number,
  splits: number,
  owner = 'u',
  first = 1
): SyncStatusSnapshot {
  return {
    ...snapshot(waiting + refused + splits),
    refusedCount: refused,
    refusedTransactions: refused,
    refusedSplits: splits,
    refusedRows: Array.from({ length: refused }, (_, i) =>
      refusedTransaction(`${owner}${first + i}`, i === 0 ? splits : 0)
    ),
    refusedUserId: owner,
  };
}

const CANT_UPLOAD =
  "can't be uploaded as they are: they stay on this device until you move, edit or discard them in Settings.";

// A row the push was refused for good never uploads, however often a sync
// runs, and a sign-out leaves it on this device (it wipes no local rows), so
// the warning counts it apart from the changes a sync can still upload.
describe("promptSignOut and the changes that can't be uploaded (#194)", () => {
  it('names them apart from the changes a sync uploads (web)', async () => {
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot.mockReturnValue(withRefused(3, 1, 1));
    (window as unknown as { confirm: (m?: string) => boolean }).confirm = (
      m
    ) => {
      confirmMessages.push(m ?? '');
      return false;
    };

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages[0]).toBe(
      `You have 3 unsynced change(s) that may not be saved to the cloud if you sign out before they sync. 1 more change(s) ${CANT_UPLOAD}\n\nOK: sync then sign out\nCancel: choose whether to sign out without syncing`
    );
  });

  it('signs out after the sync without asking again about the ones it named (web)', async () => {
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(3, 1, 1))
      .mockReturnValue(withRefused(0, 1, 1));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages.slice(1)).toStrictEqual([]);
    expect(mockedFullSync).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('asks again, naming them, when the sync was refused more (web)', async () => {
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(2, 1, 0))
      .mockReturnValue(withRefused(0, 2, 0));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages.slice(1)).toStrictEqual([
      `2 change(s) ${CANT_UPLOAD} Sign out anyway?`,
    ]);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('asks again when the sync was refused a change in place of one it named (web)', async () => {
    // The row the warning named (u1) stops being refused during the sync --
    // it uploads, or another window moves, edits or discards it -- while the
    // waiting one (u2) is refused: as many rows can't be uploaded as before,
    // but the person was never told about this one.
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(1, 1, 0))
      .mockReturnValue(withRefused(0, 1, 0, 'u', 2));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages.slice(1)).toStrictEqual([
      `1 change(s) ${CANT_UPLOAD} Sign out anyway?`,
    ]);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('PIN: still asks again when a change a sync can upload is left (web)', async () => {
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(2, 1, 0))
      .mockReturnValue(withRefused(1, 1, 0));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages.slice(1)).toStrictEqual([
      'Sync did not clear all pending changes. Sign out anyway? Unsynced data may be lost on this device.',
    ]);
  });

  it('with only those, asks once and runs no sync, which could not upload them (web)', async () => {
    mockedGetSyncSnapshot.mockReturnValue(withRefused(0, 2, 1));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages).toStrictEqual([
      `2 change(s) ${CANT_UPLOAD} Are you sure you want to sign out?`,
    ]);
    expect(mockedFullSync).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('with only those, shows Cancel and a red Sign Out natively', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    mockedGetSyncSnapshot.mockReturnValue(withRefused(0, 2, 1));

    void promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(mockedAlert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = mockedAlert.mock.calls[0];
    const shown = buttons as (AlertButton & { style?: string })[];
    expect([title, message, shown.map((b) => [b.text, b.style])]).toStrictEqual(
      [
        'Sign Out',
        `2 change(s) ${CANT_UPLOAD} Are you sure you want to sign out?`,
        [
          ['Cancel', 'cancel'],
          ['Sign Out', 'destructive'],
        ],
      ]
    );
    shown.find((b) => b.text === 'Sign Out')?.onPress?.();
    await flush();
    expect(mockedFullSync).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('names them apart natively, and signs out after the sync without asking again', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(3, 1, 1))
      .mockReturnValue(withRefused(0, 1, 1));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    const [title, message, buttons] = mockedAlert.mock.calls[0];
    expect([title, message]).toStrictEqual([
      'Sign Out',
      `You have 3 unsynced change(s) that may not be saved to the cloud if you sign out before they sync. 1 more change(s) ${CANT_UPLOAD}`,
    ]);
    (buttons as AlertButton[])
      .find((b) => b.text === 'Sync & Sign Out')
      ?.onPress?.();
    await flush();
    expect(mockedAlert).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('asks again natively, naming them, when the sync was refused more', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(2, 1, 0))
      .mockReturnValue(withRefused(0, 2, 0));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();
    (mockedAlert.mock.calls[0][2] as AlertButton[])
      .find((b) => b.text === 'Sync & Sign Out')
      ?.onPress?.();
    await flush();

    const [title, message, buttons] = mockedAlert.mock.calls[1] ?? [];
    expect([
      title,
      message,
      ((buttons ?? []) as (AlertButton & { style?: string })[]).map((b) => [
        b.text,
        b.style,
      ]),
    ]).toStrictEqual([
      'Sync incomplete',
      `2 change(s) ${CANT_UPLOAD} Sign out anyway?`,
      [
        ['Cancel', 'cancel'],
        ['Sign Out Anyway', 'destructive'],
      ],
    ]);
  });

  it("PIN: never counts another account's refused rows in the shared store", async () => {
    // The store says 4 unsynced, 1 refused with a split line under it, read
    // for another account: neither is this user's, so all 4 count as before.
    mockedGetSyncSnapshot.mockReturnValue(withRefused(2, 1, 1, 'b'));
    (window as unknown as { confirm: (m?: string) => boolean }).confirm = (
      m
    ) => {
      confirmMessages.push(m ?? '');
      return false;
    };

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages[0]).toBe(
      'You have 4 unsynced change(s) that may not be saved to the cloud if you sign out before they sync.\n\nOK: sync then sign out\nCancel: choose whether to sign out without syncing'
    );
  });

  it("PIN: never names another account's refused rows after the sync either", async () => {
    // Another account's refresh lands between this user's after the sync and
    // the read: its refused rows are not this user's to be told about.
    mockedFullSync.mockResolvedValue(undefined);
    mockedGetSyncSnapshot
      .mockReturnValueOnce(withRefused(2, 1, 0))
      .mockReturnValue(withRefused(0, 2, 1, 'b'));

    await promptSignOut('u', { signOut, onNavigateToSignIn });
    await flush();

    expect(confirmMessages.slice(1)).toStrictEqual([
      'Sync did not clear all pending changes. Sign out anyway? Unsynced data may be lost on this device.',
    ]);
  });
});

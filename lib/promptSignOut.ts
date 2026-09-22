import { Alert, Platform } from 'react-native';
import { fullSync } from './sync';
import { getSyncSnapshot, refreshSyncState } from './syncStatus';

type SignOutCallbacks = {
  signOut: () => Promise<void>;
  onNavigateToSignIn: () => void;
};

/**
 * How long "Sync & Sign Out" waits for the sync before it stops waiting (#67).
 *
 * The per-request timeout in lib/supabase.ts does not bound this wait. A sync is
 * many requests, and worse, `fullSync` called while the lock is held waits on
 * ANOTHER holder's request plus up to MAX_QUEUED_DRAINS drained follow-ups
 * (lib/sync.ts) — so the wait is bounded by the whole queue, not by one request.
 * Before this deadline the dialog simply never came back: no progress, no
 * cancel, no second dialog.
 */
export const SIGN_OUT_SYNC_DEADLINE_MS = 30_000;

/**
 * Runs the sync, but stops *waiting* for it after SIGN_OUT_SYNC_DEADLINE_MS.
 *
 * The sync is not cancelled — it keeps running in the background, which is
 * exactly the state "Sign Out Anyway" already produces — so what the caller does
 * next is unchanged: re-read the pending count and let the existing dialogs
 * decide. With rows still pending the user is asked again; with none pending
 * there is nothing local left to lose, so sign-out proceeds.
 *
 * The timer is cleared when the sync wins the race: a 30 s timer left armed
 * keeps the JS context awake for no reason (and would leak between tests).
 */
async function syncWithDeadline(
  userId: string
): Promise<{ timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // fullSync never rejects — every holder catches its own failure and reports
    // it through the sync status (lib/sync.ts) — so the only outcomes are
    // "finished" and "still running".
    return await Promise.race<{ timedOut: boolean }>([
      fullSync(userId).then(() => ({ timedOut: false })),
      new Promise<{ timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[sign-out] sync still running after ${SIGN_OUT_SYNC_DEADLINE_MS}ms; continuing with the pending count as it stands`
          );
          resolve({ timedOut: true });
        }, SIGN_OUT_SYNC_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Confirms sign-out; warns when local DB has unsynced rows and offers sync-first.
 */
export async function promptSignOut(
  userId: string,
  { signOut, onNavigateToSignIn }: SignOutCallbacks
) {
  await refreshSyncState(userId);
  let snapshot = getSyncSnapshot();

  const performSignOut = async () => {
    await signOut();
    onNavigateToSignIn();
  };

  const showSimpleConfirm = () => {
    if (Platform.OS === 'web') {
      if (
        typeof window !== 'undefined' &&
        window.confirm('Are you sure you want to sign out?')
      ) {
        void performSignOut();
      }
      return;
    }
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => void performSignOut(),
      },
    ]);
  };

  if (snapshot.pendingCount === 0) {
    showSimpleConfirm();
    return;
  }

  const warnBody = `You have ${snapshot.pendingCount} unsynced change(s) that may not be saved to the cloud if you sign out before they sync.`;

  if (Platform.OS === 'web') {
    const syncFirst =
      typeof window !== 'undefined' &&
      window.confirm(
        `${warnBody}\n\nOK: sync then sign out\nCancel: choose whether to sign out without syncing`
      );
    if (syncFirst) {
      await syncWithDeadline(userId);
      await refreshSyncState(userId);
      snapshot = getSyncSnapshot();
      if (snapshot.pendingCount > 0) {
        if (
          typeof window !== 'undefined' &&
          window.confirm(
            'Sync did not clear all pending changes. Sign out anyway? Unsynced data may be lost on this device.'
          )
        ) {
          void performSignOut();
        }
        return;
      }
      void performSignOut();
      return;
    }
    if (
      typeof window !== 'undefined' &&
      window.confirm('Sign out without syncing? Unsynced changes may be lost.')
    ) {
      void performSignOut();
    }
    return;
  }

  Alert.alert('Sign Out', warnBody, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Sync & Sign Out',
      onPress: async () => {
        await syncWithDeadline(userId);
        await refreshSyncState(userId);
        const after = getSyncSnapshot();
        if (after.pendingCount > 0) {
          Alert.alert(
            'Sync incomplete',
            'Some changes could not sync. Try Sync Now in Settings, or sign out anyway.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign Out Anyway',
                style: 'destructive',
                onPress: () => void performSignOut(),
              },
            ]
          );
          return;
        }
        await performSignOut();
      },
    },
    {
      text: 'Sign Out Anyway',
      style: 'destructive',
      onPress: () => void performSignOut(),
    },
  ]);
}

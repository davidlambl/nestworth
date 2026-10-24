import { Alert, Platform } from 'react-native';
import { confirm } from './confirm';
import { fullSync } from './sync';
import { waitingTotal } from './syncRefusals';
import {
  getSyncSnapshot,
  refreshSyncState,
  type SyncStatusSnapshot,
} from './syncStatus';

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
 * decide. With rows a sync can still upload, or a row the push was refused for
 * good that the warning did not name, the user is asked again; otherwise
 * sign-out proceeds, since nothing a sync could upload is left to lose and the
 * refused rows the warning named stay on this device (#194).
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
 * The user's unsynced rows as the sign-out counts them (#194): those a sync
 * can upload (`waiting`, Settings' rule), and those the push was refused for
 * good (#115), which no sync uploads and a sign-out leaves on this device,
 * since it wipes no local rows: how many, and which (`table:id`). The refused
 * rows are the user's only when the store read them for this user: it is
 * shared by every account signed in on this device (#193's snapshotUserId).
 */
function unsyncedRows(
  snapshot: SyncStatusSnapshot,
  userId: string
): { waiting: number; refused: number; refusedKeys: Set<string> } {
  const mine = snapshot.snapshotUserId === userId;
  const refused = mine ? snapshot.refusedCount : 0;
  return {
    waiting: waitingTotal({
      pendingCount: snapshot.pendingCount,
      refusedCount: refused,
      refusedSplits: mine ? snapshot.refusedSplits : 0,
    }),
    refused,
    refusedKeys: new Set(
      mine ? snapshot.refusedRows.map((r) => `${r.table}:${r.id}`) : []
    ),
  };
}

/** The rows no sync uploads, and where they stay (#194). */
function cantUpload(count: number, more = false): string {
  return `${count}${more ? ' more' : ''} change(s) can't be uploaded as they are: they stay on this device until you move, edit or discard them in Settings.`;
}

/**
 * Confirms sign-out; warns when local DB has unsynced rows, and offers
 * sync-first when a sync can upload any of them (#194).
 */
export async function promptSignOut(
  userId: string,
  { signOut, onNavigateToSignIn }: SignOutCallbacks
) {
  await refreshSyncState(userId);
  const snapshot = getSyncSnapshot();

  const performSignOut = async () => {
    await signOut();
    onNavigateToSignIn();
  };

  if (snapshot.pendingCount === 0) {
    const ok = await confirm({
      title: 'Sign Out',
      message: 'Are you sure you want to sign out?',
      confirmText: 'Sign Out',
      destructive: true,
    });
    if (ok) {
      void performSignOut();
    }
    return;
  }

  const before = unsyncedRows(snapshot, userId);

  // Only rows the push was refused for good (#194): a sync would be refused
  // them again, so none is offered, and the question says where they stay.
  if (before.waiting === 0) {
    const ok = await confirm({
      title: 'Sign Out',
      message: `${cantUpload(before.refused)} Are you sure you want to sign out?`,
      confirmText: 'Sign Out',
      destructive: true,
    });
    if (ok) {
      void performSignOut();
    }
    return;
  }

  const warnBody =
    `You have ${before.waiting} unsynced change(s) that may not be saved to the cloud if you sign out before they sync.` +
    (before.refused > 0 ? ` ${cantUpload(before.refused, true)}` : '');

  // After the sync, the question about what it left that the person was not
  // told about (#194): a change a sync can still upload (in each platform's
  // words), or a row the push was refused for good that the warning did not
  // name. Rows, not counts: a named row can stop being refused during the
  // sync (it uploads, or another window moves, edits or discards it) while
  // another is refused. The refused rows the warning named stay on this
  // device whatever they choose, and are not asked about again. Null: nothing
  // new is left, and the sign-out goes on.
  const askAfterSync = (stillWaiting: string): string | null => {
    const after = unsyncedRows(getSyncSnapshot(), userId);
    if (after.waiting > 0) {
      return stillWaiting;
    }
    const unnamed = [...after.refusedKeys].some(
      (key) => !before.refusedKeys.has(key)
    );
    return unnamed ? `${cantUpload(after.refused)} Sign out anyway?` : null;
  };

  // Not `confirm` (#37): with changes waiting, web asks in up to three steps
  // (OK syncs first; Cancel asks whether to sign out without syncing), while
  // a native alert offers the three choices at once, and the follow-ups word
  // the incomplete sync differently on each.
  if (Platform.OS === 'web') {
    const syncFirst =
      typeof window !== 'undefined' &&
      window.confirm(
        `${warnBody}\n\nOK: sync then sign out\nCancel: choose whether to sign out without syncing`
      );
    if (syncFirst) {
      await syncWithDeadline(userId);
      await refreshSyncState(userId);
      const question = askAfterSync(
        'Sync did not clear all pending changes. Sign out anyway? Unsynced data may be lost on this device.'
      );
      if (question) {
        if (typeof window !== 'undefined' && window.confirm(question)) {
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
        const question = askAfterSync(
          'Some changes could not sync. Try Sync Now in Settings, or sign out anyway.'
        );
        if (question) {
          Alert.alert('Sync incomplete', question, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Sign Out Anyway',
              style: 'destructive',
              onPress: () => void performSignOut(),
            },
          ]);
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

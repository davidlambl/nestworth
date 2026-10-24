import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fullSync } from '@/lib/sync';
import {
  getSyncSnapshot,
  NO_USER_NUMBERS,
  refreshSyncState,
  subscribeSyncStatus,
} from '@/lib/syncStatus';
import { useAuth } from '@/lib/auth';

export function useSyncStatus() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();

  const snapshot = useSyncExternalStore(
    subscribeSyncStatus,
    getSyncSnapshot,
    getSyncSnapshot
  );

  useEffect(() => {
    if (!userId) {
      return;
    }
    void refreshSyncState(userId);
  }, [userId]);

  const syncNow = useCallback(async () => {
    if (!userId) {
      return;
    }
    await fullSync(userId);
    await refreshSyncState(userId);
    queryClient.invalidateQueries();
  }, [userId, queryClient]);

  // The counts, the rows the push was refused for good (#115) and "Last
  // synced" are the signed-in user's only when the last refresh read them for
  // that user. The store is shared by every account signed in on this device,
  // and a refresh for another one lands in it (#193): the outgoing account's
  // sync keeps the lock after a switch and ends with a refresh for that
  // account (#111), and so does a stale requestPush for it.
  const readFor = snapshot.snapshotUserId;
  const mine = userId != null && readFor === userId;

  // When another account's numbers land, read this user's back at once rather
  // than show nothing until this user's own sync ends. No loop: this read
  // publishes this user's numbers, and only a sync or a refresh for the other
  // account publishes that one's. Not before the first read (null), which the
  // effect above makes.
  useEffect(() => {
    if (!userId || readFor == null || readFor === userId) {
      return;
    }
    void refreshSyncState(userId);
  }, [userId, readFor]);

  return {
    ...snapshot,
    // False until a refresh has read this user's numbers (a fresh load, a
    // switch, another account's refresh): until then the counts, the list and
    // the time have nothing to say, not "nothing pending" or "nothing refused".
    refusedKnown: mine,
    ...(mine ? null : NO_USER_NUMBERS),
    userId,
    syncNow,
    refresh: userId ? () => refreshSyncState(userId) : async () => {},
  };
}

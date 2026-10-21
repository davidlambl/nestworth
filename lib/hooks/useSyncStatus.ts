import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fullSync } from '@/lib/sync';
import {
  getSyncSnapshot,
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

  // The rows the push was refused for good (#115) are the signed-in user's
  // only when the last refresh read them for that user: the store is shared
  // by every account signed in on this device, and a refresh for another one
  // (a stale requestPush after a switch, #111) must not show its rows here.
  const mine = userId != null && snapshot.refusedUserId === userId;

  return {
    ...snapshot,
    // False until a refresh has read this user's refusals (a fresh load, a
    // switch): until then the list has nothing to say, not "nothing refused".
    refusedKnown: mine,
    refusedCount: mine ? snapshot.refusedCount : 0,
    refusedTransactions: mine ? snapshot.refusedTransactions : 0,
    refusedRules: mine ? snapshot.refusedRules : 0,
    refusedSplits: mine ? snapshot.refusedSplits : 0,
    refusedRows: mine ? snapshot.refusedRows : [],
    userId,
    syncNow,
    refresh: userId ? () => refreshSyncState(userId) : async () => {},
  };
}

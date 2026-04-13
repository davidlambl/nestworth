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

  const snapshot = useSyncExternalStore(subscribeSyncStatus, getSyncSnapshot, getSyncSnapshot);

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

  return {
    ...snapshot,
    userId,
    syncNow,
    refresh: userId ? () => refreshSyncState(userId) : async () => {},
  };
}

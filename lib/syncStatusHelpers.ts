export const PENDING_TINT = '#f97316';

export interface SyncSnapshot {
  isSyncing: boolean;
  pendingCount: number;
  lastError: string | null;
  isOnline: boolean;
}

export interface StatusColors {
  destructive: string;
  textSecondary: string;
  income: string;
}

// Offline outranks a recorded error, here and in the Settings status line
// (#66). A foreground sync runs whatever the connectivity (lib/query.tsx) and
// every read it makes fails, so while NetInfo says offline the recorded error is
// almost always the offline itself, and "Offline" is the honest state. The error
// stays recorded: the reconnection trigger's fullSync clears lastError on entry
// before its next attempt, so a real error surfaces again once online.
export function statusDotColor(
  snapshot: SyncSnapshot,
  colors: StatusColors
): string {
  if (!snapshot.isOnline) return colors.textSecondary;
  if (snapshot.lastError) return colors.destructive;
  if (snapshot.pendingCount > 0) return PENDING_TINT;
  return colors.income;
}

export function statusLabel(snapshot: SyncSnapshot): string {
  if (snapshot.isSyncing) return 'Syncing\u2026';
  if (!snapshot.isOnline) return 'Offline';
  if (snapshot.lastError) return 'Sync error';
  if (snapshot.pendingCount > 0) return `${snapshot.pendingCount} pending`;
  return 'Synced';
}

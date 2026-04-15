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

export function statusDotColor(
  snapshot: SyncSnapshot,
  colors: StatusColors,
): string {
  if (snapshot.lastError) return colors.destructive;
  if (!snapshot.isOnline) return colors.textSecondary;
  if (snapshot.pendingCount > 0) return PENDING_TINT;
  return colors.income;
}

export function statusLabel(snapshot: SyncSnapshot): string {
  if (snapshot.isSyncing) return 'Syncing\u2026';
  if (snapshot.lastError) return 'Sync error';
  if (!snapshot.isOnline) return 'Offline';
  if (snapshot.pendingCount > 0) return `${snapshot.pendingCount} pending`;
  return 'Synced';
}

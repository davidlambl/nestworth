import { waitingTotal } from './syncRefusals';

export const PENDING_TINT = '#f97316';

export interface SyncSnapshot {
  isSyncing: boolean;
  /** Every unsynced row, those that can't be uploaded included. */
  pendingCount: number;
  lastError: string | null;
  isOnline: boolean;
  /**
   * The rows among them the push was refused for good (#115), and the split
   * lines waiting under those, which go up only with them: the signed-in
   * user's, as useSyncStatus gives them. None when absent.
   */
  refusedCount?: number;
  refusedSplits?: number;
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
  // Orange for the rows that can't be uploaded too: they wait on the person,
  // not on an error (#194). Asked apart from the pending count, so that the
  // dot never shows synced beside a label that names a row.
  if (snapshot.pendingCount > 0 || (snapshot.refusedCount ?? 0) > 0) {
    return PENDING_TINT;
  }
  return colors.income;
}

export function statusLabel(snapshot: SyncSnapshot): string {
  if (snapshot.isSyncing) return 'Syncing\u2026';
  if (!snapshot.isOnline) return 'Offline';
  if (snapshot.lastError) return 'Sync error';
  // The rows the push was refused for good never upload on their own, however
  // often a sync runs, so they are counted apart (#194): the rows a sync can
  // upload first, as Settings counts them (waitingTotal), then those. Each
  // count is held to its words by no-break spaces, so that the sidebar row,
  // too narrow for both on one line, wraps after the comma.
  const refused = snapshot.refusedCount ?? 0;
  if (refused > 0) {
    const waiting = waitingTotal({
      pendingCount: snapshot.pendingCount,
      refusedCount: refused,
      refusedSplits: snapshot.refusedSplits ?? 0,
    });
    const cantUpload = `${refused}\u00a0can't\u00a0upload`;
    return waiting > 0 ? `${waiting}\u00a0pending, ${cantUpload}` : cantUpload;
  }
  if (snapshot.pendingCount > 0) return `${snapshot.pendingCount} pending`;
  return 'Synced';
}

/**
 * The accessibility label of the sync controls, the header dot and the
 * sidebar's sync row (#38): the status the dot's colour shows, then what
 * pressing it does. On a narrow screen and in a collapsed sidebar the control
 * is the dot alone; the wide sidebar row shows the status as text, which the
 * label starts with. While a sync runs both controls are disabled, so the
 * label is the status alone. Beside rows that can't be uploaded it still
 * offers a sync, which uploads every other row and pulls (#194).
 */
export function syncButtonLabel(snapshot: SyncSnapshot): string {
  const status = statusLabel(snapshot);
  return snapshot.isSyncing ? status : `${status}, sync now`;
}

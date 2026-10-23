import { getDb, getSyncMeta } from './db';
import {
  NO_REFUSALS,
  readRefusedRows,
  refusalsKey,
  type RefusedRow,
} from './syncRefusals';

export type SyncStatusSnapshot = {
  isSyncing: boolean;
  /** Every unsynced row, those that can't be uploaded included. */
  pendingCount: number;
  pendingAccounts: number;
  pendingTransactions: number;
  pendingSplits: number;
  pendingRules: number;
  /**
   * The rows among them the last push was refused for good, still standing
   * (#115; lib/syncRefusals.ts): transactions and rules, the split lines
   * waiting under those transactions, and the rows themselves for Settings.
   */
  refusedCount: number;
  refusedTransactions: number;
  refusedRules: number;
  refusedSplits: number;
  refusedRows: RefusedRow[];
  /**
   * Whose the counts above and lastSyncedAt below are: the user the last
   * refresh read them for, null before the first (#115, #193). The snapshot
   * is shared by every account signed in on this device, and a refresh for
   * another one lands in it (the outgoing account's sync ends with one after
   * a switch, #111), so useSyncStatus shows them to that user only.
   * isSyncing, lastError and isOnline are the device's.
   */
  snapshotUserId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  isOnline: boolean;
};

/** The device's fields; every other one is the user's that snapshotUserId names. */
type DeviceField = 'isSyncing' | 'lastError' | 'isOnline' | 'snapshotUserId';
export type UserNumbers = Omit<SyncStatusSnapshot, DeviceField>;
/**
 * A user's numbers before they are read: nothing. Typed by the snapshot, so a
 * per-user field added to it fails tsc here until it has its "nothing" value,
 * and useSyncStatus masks it with the rest (#193).
 */
export const NO_USER_NUMBERS: Readonly<UserNumbers> = Object.freeze({
  pendingCount: 0,
  pendingAccounts: 0,
  pendingTransactions: 0,
  pendingSplits: 0,
  pendingRules: 0,
  refusedCount: 0,
  refusedTransactions: 0,
  refusedRules: 0,
  refusedSplits: 0,
  refusedRows: [],
  lastSyncedAt: null,
});

let _state: SyncStatusSnapshot = {
  isSyncing: false,
  ...NO_USER_NUMBERS,
  snapshotUserId: null,
  lastError: null,
  isOnline: true,
};

const _listeners = new Set<() => void>();

function _emit() {
  _listeners.forEach((listener) => listener());
}

export function getSyncSnapshot(): SyncStatusSnapshot {
  return _state;
}

export function subscribeSyncStatus(onStoreChange: () => void): () => void {
  _listeners.add(onStoreChange);
  return () => {
    _listeners.delete(onStoreChange);
  };
}

export function setSyncing(value: boolean) {
  if (_state.isSyncing === value) {
    return;
  }
  _state = { ..._state, isSyncing: value };
  _emit();
}

export function setLastError(message: string | null) {
  if (_state.lastError === message) {
    return;
  }
  _state = { ..._state, lastError: message };
  _emit();
}

export function setOnline(value: boolean) {
  if (_state.isOnline === value) {
    return;
  }
  if (!value) {
    // TanStack Query pauses every mutation while offline (lib/query.tsx wires
    // its onlineManager to the same NetInfo state), so a save that "did
    // nothing" may simply be waiting here.
    console.warn('[status] offline');
  }
  _state = { ..._state, isOnline: value };
  _emit();
}

async function readPendingCounts(userId: string): Promise<{
  pendingAccounts: number;
  pendingTransactions: number;
  pendingSplits: number;
  pendingRules: number;
  pendingCount: number;
  refusedCount: number;
  refusedTransactions: number;
  refusedRules: number;
  refusedSplits: number;
  refusedRows: RefusedRow[];
}> {
  const db = await getDb();
  const pendingSql = "(_sync_status = 'pending' OR _sync_status = 'deleted')";

  const accountsRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM accounts WHERE user_id = ? AND ${pendingSql}`,
    [userId]
  );
  const txnsRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND ${pendingSql}`,
    [userId]
  );
  const splitsRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM transaction_splits ts
     INNER JOIN transactions tx ON tx.id = ts.transaction_id
     WHERE tx.user_id = ? AND (ts._sync_status = 'pending' OR ts._sync_status = 'deleted')`,
    [userId]
  );
  const rulesRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) as c FROM recurring_rules WHERE user_id = ? AND ${pendingSql}`,
    [userId]
  );

  const pendingAccounts = accountsRow?.c ?? 0;
  const pendingTransactions = txnsRow?.c ?? 0;
  const pendingSplits = splitsRow?.c ?? 0;
  const pendingRules = rulesRow?.c ?? 0;
  // Read after the counts. The reads are not one snapshot: a write landing
  // between them (a move, a discard, a push's own record) can put a row in
  // one and not the other until the next refresh, which every sync ends with;
  // Settings never shows a count below zero.
  const raw = await getSyncMeta(refusalsKey(userId));
  const refused = raw ? await readRefusedRows(db, userId, raw) : NO_REFUSALS;
  return {
    pendingAccounts,
    pendingTransactions,
    pendingSplits,
    pendingRules,
    pendingCount:
      pendingAccounts + pendingTransactions + pendingSplits + pendingRules,
    refusedCount: refused.transactions + refused.rules,
    refusedTransactions: refused.transactions,
    refusedRules: refused.rules,
    refusedSplits: refused.splits,
    refusedRows: refused.rows,
  };
}

/**
 * Reads `userId`'s counts, refused rows and "Last synced" and publishes them
 * stamped with that user. The only writer of those fields (#193): written
 * together, they are always one user's, as `snapshotUserId` says.
 */
export async function refreshSyncState(userId: string): Promise<void> {
  // Read both before mutating state so we emit once, not twice. Each emit
  // wakes every useSyncStatus subscriber — and on iOS the sync indicator
  // in the navigation header re-renders on each, contributing to the
  // post-mutation chop the user sees.
  const counts = await readPendingCounts(userId);
  const lastSyncedAt = await getSyncMeta(`last_pull_at:${userId}`);
  _state = { ..._state, ...counts, snapshotUserId: userId, lastSyncedAt };
  _emit();
}

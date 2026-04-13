import { getDb, getSyncMeta } from './db';

export type SyncStatusSnapshot = {
  isSyncing: boolean;
  pendingCount: number;
  pendingAccounts: number;
  pendingTransactions: number;
  pendingSplits: number;
  pendingRules: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  isOnline: boolean;
};

let _state: SyncStatusSnapshot = {
  isSyncing: false,
  pendingCount: 0,
  pendingAccounts: 0,
  pendingTransactions: 0,
  pendingSplits: 0,
  pendingRules: 0,
  lastSyncedAt: null,
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
  _state = { ..._state, isOnline: value };
  _emit();
}

export async function refreshPendingCount(userId: string): Promise<void> {
  const db = await getDb();
  const pendingSql =
    "(_sync_status = 'pending' OR _sync_status = 'deleted')";

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
  const pendingCount =
    pendingAccounts + pendingTransactions + pendingSplits + pendingRules;

  _state = {
    ..._state,
    pendingCount,
    pendingAccounts,
    pendingTransactions,
    pendingSplits,
    pendingRules,
  };
  _emit();
}

export async function refreshLastSynced(userId: string): Promise<void> {
  const value = await getSyncMeta(`last_pull_at:${userId}`);
  _state = { ..._state, lastSyncedAt: value };
  _emit();
}

export async function refreshSyncState(userId: string): Promise<void> {
  await refreshPendingCount(userId);
  await refreshLastSynced(userId);
}

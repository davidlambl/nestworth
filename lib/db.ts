import * as SQLite from 'expo-sqlite';

const DB_NAME = 'nestworth.db';

let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_dbPromise) {
    _dbPromise = initDb();
  }
  return _dbPromise;
}

async function initDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(SCHEMA);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT,
  initial_balance REAL DEFAULT 0,
  exclude_from_total INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  _sync_status TEXT DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  txn_date TEXT,
  payee TEXT,
  amount REAL,
  check_number TEXT,
  memo TEXT,
  status TEXT DEFAULT 'pending',
  transfer_link_id TEXT,
  receipt_path TEXT,
  created_at TEXT,
  updated_at TEXT,
  _sync_status TEXT DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  amount REAL,
  memo TEXT,
  _sync_status TEXT DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  frequency TEXT,
  next_date TEXT,
  end_date TEXT,
  template TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT,
  _sync_status TEXT DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_splits_txn ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_rules_user ON recurring_rules(user_id);
`;

export async function getSyncMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_meta WHERE key = ?',
    [key]
  );
  return row?.value ?? null;
}

export async function setSyncMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
    [key, value]
  );
}

export async function cleanupOrphanedTransfers(userId: string): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();

  const orphans = await db.getAllAsync<{ id: string }>(
    `SELECT t.id FROM transactions t
     WHERE t.user_id = ?
       AND t.transfer_link_id IS NOT NULL
       AND t._sync_status != 'deleted'
       AND NOT EXISTS (
         SELECT 1 FROM transactions t2
         WHERE t2.transfer_link_id = t.transfer_link_id
           AND t2.id != t.id
           AND t2._sync_status != 'deleted'
       )`,
    [userId]
  );

  for (const { id } of orphans) {
    await db.runAsync(
      "UPDATE transaction_splits SET _sync_status = 'deleted' WHERE transaction_id = ?",
      [id]
    );
    await db.runAsync(
      "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = ?",
      [now, id]
    );
  }

  if (orphans.length > 0) {
    console.log(`[db] cleaned up ${orphans.length} orphaned transfer transaction(s)`);
  }

  return orphans.length;
}

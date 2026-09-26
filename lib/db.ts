import * as SQLite from 'expo-sqlite';
import { runMigrations } from './migrations';
import { sweepOrphanSyncedSplits } from './tombstones';
import { serialiseTransactions } from './transactionQueue';

const DB_NAME = 'nestworth.db';

let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_dbPromise) {
    const p = initDb();
    // Cache the promise so callers share one connection, but drop it again if
    // it rejects. Caching a REJECTED promise would poison every later getDb()
    // for the life of the process — the app would keep failing after a
    // transient open/migration error that a retry would clear. Guarded on
    // identity so a newer attempt already in flight isn't discarded.
    _dbPromise = p;
    p.catch(() => {
      if (_dbPromise === p) {
        _dbPromise = null;
      }
    });
  }
  return _dbPromise;
}

async function initDb(): Promise<SQLite.SQLiteDatabase> {
  // Every caller shares this one connection, so its withTransactionAsync
  // callers take turns (#110; lib/transactionQueue.ts explains why, and the
  // one rule that comes with it: never open a transaction inside another).
  // Installed first, so the migration ladder's transactions queue too.
  const db = serialiseTransactions(await SQLite.openDatabaseAsync(DB_NAME));
  await db.execAsync('PRAGMA journal_mode = WAL;');
  // Schema lives in lib/migrations.ts as a versioned ladder — see that file
  // before changing anything about the tables.
  await runMigrations(db);
  // Splits whose transaction row is gone are garbage nothing else removes
  // (sweepOrphanSyncedSplits says where they come from, #137). Swept at every
  // launch, before any caller has the connection, rather than once as a
  // ladder step, which would stop every older build from opening this
  // database. Best effort: a failure only warns, and the next launch retries.
  try {
    const swept = await sweepOrphanSyncedSplits(db);
    if (swept > 0) {
      console.log(`[db] removed ${swept} orphan synced split(s) at launch`);
    }
  } catch (e) {
    console.warn('[db] the orphan split sweep failed; next launch retries:', e);
  }
  return db;
}

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

import * as SQLite from 'expo-sqlite';
import { runMigrations } from './migrations';

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
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  // Schema lives in lib/migrations.ts as a versioned ladder — see that file
  // before changing anything about the tables.
  await runMigrations(db);
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

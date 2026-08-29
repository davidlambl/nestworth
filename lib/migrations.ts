/**
 * Local SQLite schema migrations.
 *
 * The local store previously initialised itself with a single block of
 * `CREATE TABLE IF NOT EXISTS` statements. That is fine for a fresh install and
 * silently useless for an existing one: adding a column to the block never
 * reaches a device whose tables already exist, so no schema change could ever
 * ship. This module replaces that with a versioned ladder tracked in SQLite's
 * own `PRAGMA user_version`.
 *
 * Adding a migration:
 *   1. Append an entry with the next `version` — never edit or renumber a
 *      released one, since devices in the field record how far they have run.
 *   2. Write it to be safe on a database that already contains real rows.
 *
 * Version 1 is the baseline. It is deliberately idempotent (`IF NOT EXISTS`)
 * because it has to be a no-op on the installs that predate this system: those
 * databases already hold the full schema but still report `user_version = 0`,
 * so they run migration 1 over their existing tables and land on version 1 with
 * their data untouched.
 */

/** The slice of the expo-sqlite surface migrations need. */
export interface MigratableDb {
  execAsync(sql: string): Promise<void>;
  // No params: the only read here is `PRAGMA user_version`, and keeping the
  // signature argument-free stays compatible with expo-sqlite's overloads.
  getFirstAsync<T>(sql: string): Promise<T | null>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

export interface Migration {
  version: number;
  name: string;
  /** SQL to apply, or a function for migrations needing real logic. */
  up: string | ((db: MigratableDb) => Promise<void>);
}

const BASELINE = `
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

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: BASELINE },
];

/** Highest version this build of the app knows how to produce. */
export function latestVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/**
 * Guards against authoring mistakes that would corrupt the ladder: versions
 * must start at 1, increase by exactly one, and never repeat. Cheap to check
 * and much easier to diagnose here than as a half-migrated device.
 */
function assertWellFormed(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    if (!Number.isInteger(m.version)) {
      throw new Error(`Migration "${m.name}" has a non-integer version.`);
    }
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be numbered 1..n with no gaps: expected version ${
          i + 1
        } at index ${i}, found ${m.version} ("${m.name}").`
      );
    }
  });
}

async function readUserVersion(db: MigratableDb): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version'
  );
  return row?.user_version ?? 0;
}

/**
 * Brings the database up to the latest known version, applying each pending
 * migration inside its own transaction so a failure part-way leaves the
 * database on the last version that fully succeeded rather than half-migrated.
 *
 * Returns the version the database ends on.
 */
export async function runMigrations(
  db: MigratableDb,
  migrations: Migration[] = MIGRATIONS
): Promise<number> {
  assertWellFormed(migrations);

  const current = await readUserVersion(db);
  const target = latestVersion(migrations);

  if (current > target) {
    // The database was written by a newer build of the app. Continuing would
    // let this build write rows against a schema it does not understand, so
    // refuse rather than risk corrupting data the newer build owns.
    throw new Error(
      `Database schema is version ${current}, but this build only supports ${target}. ` +
        `Update the app rather than downgrading it.`
    );
  }

  for (const m of migrations) {
    if (m.version <= current) continue;
    await db.withTransactionAsync(async () => {
      // Re-read the version INSIDE the transaction rather than trusting the
      // snapshot taken before the loop, so a runner whose step another runner
      // already committed skips instead of replaying the DDL.
      //
      // Belt-and-braces: in practice SQLite's write lock usually rejects the
      // losing racer first ('database is locked' — see the two-connection
      // tests), so this is not covered by a test that fails without it. Kept
      // because it is one pragma read and it closes the window where a loser
      // acquires the lock after the winner commits.
      const now = await readUserVersion(db);
      if (now !== m.version - 1) return;

      if (typeof m.up === 'string') {
        await db.execAsync(m.up);
      } else {
        await m.up(db);
      }
      // Safe to interpolate: assertWellFormed proved this is an integer, and
      // PRAGMA does not accept bound parameters.
      await db.execAsync(`PRAGMA user_version = ${m.version}`);
    });
  }

  return target;
}

// Migration-runner tests. Backed by a real in-memory SQLite (better-sqlite3)
// wrapped in the expo-sqlite surface the runner uses, so the actual DDL and the
// real `PRAGMA user_version` bookkeeping execute.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runMigrations,
  latestVersion,
  MIGRATIONS,
  type Migration,
  type MigratableDb,
} from '../migrations';

type Adapter = MigratableDb & { _sqlite: Database.Database };

function makeAdapter(): Adapter {
  const sqlite = new Database(':memory:');
  return {
    _sqlite: sqlite,
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    getFirstAsync: async <T>(sql: string) =>
      (sqlite.prepare(sql).get() ?? null) as T | null,
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await fn();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const userVersion = (a: Adapter): number =>
  (a._sqlite.pragma('user_version', { simple: true }) as number) ?? 0;

const tableNames = (a: Adapter): string[] =>
  (
    a._sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();

/**
 * Asserts a promise rejects, matching on the stringified error.
 *
 * NOT interchangeable with `rejects.toThrow()` here. better-sqlite3 binds its
 * SqliteError class to the process-wide native addon exactly once
 * (better-sqlite3/lib/database.js), while jest gives every test file its own vm
 * realm. So when another better-sqlite3 suite (sync.test.ts,
 * applyTransactionUpdate.test.ts) has already run in the same worker, this
 * file's SqliteError fails `instanceof Error`, and toThrow's fromPromise path
 * then treats a genuine rejection as "did not throw". That made these tests
 * pass or fail purely on worker count and suite ordering — green on a many-core
 * dev machine, red under `jest --maxWorkers=1`.
 */
async function expectRejection(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  let err: unknown = null;
  await promise.catch((e) => {
    err = e ?? new Error('rejected with a falsy value');
  });
  expect(err).not.toBeNull();
  expect(String(err)).toMatch(match);
}

let adapter: Adapter;
beforeEach(() => {
  adapter = makeAdapter();
});
afterEach(() => {
  adapter._sqlite.close();
});

describe('runMigrations — fresh install', () => {
  it('creates the full schema and stamps the latest version', async () => {
    const ended = await runMigrations(adapter);

    expect(ended).toBe(latestVersion());
    expect(userVersion(adapter)).toBe(latestVersion());
    expect(tableNames(adapter)).toEqual([
      'accounts',
      'recurring_rules',
      'sync_meta',
      'transaction_splits',
      'transactions',
    ]);
  });

  it('is idempotent — a second run is a no-op', async () => {
    await runMigrations(adapter);
    adapter._sqlite
      .prepare(
        `INSERT INTO accounts (id, user_id, name, type) VALUES ('a1','u1','Checking','checking')`
      )
      .run();

    await runMigrations(adapter);

    expect(userVersion(adapter)).toBe(latestVersion());
    expect(
      adapter._sqlite.prepare('SELECT COUNT(*) c FROM accounts').get()
    ).toEqual({ c: 1 });
  });
});

describe('runMigrations — upgrading an install that predates versioning', () => {
  // The install base this ships to: databases created by the old
  // `CREATE TABLE IF NOT EXISTS` block. They already hold the full schema and
  // real data, but still report user_version = 0. This is the path that can
  // destroy someone's financial history, so it is asserted directly.
  const LEGACY_SCHEMA = `
    CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, icon TEXT, initial_balance REAL DEFAULT 0, exclude_from_total INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
    CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, txn_date TEXT, payee TEXT, amount REAL, check_number TEXT, memo TEXT, status TEXT DEFAULT 'pending', transfer_link_id TEXT, receipt_path TEXT, created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
    CREATE TABLE transaction_splits (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, amount REAL, memo TEXT, _sync_status TEXT DEFAULT 'synced');
    CREATE TABLE recurring_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, frequency TEXT, next_date TEXT, end_date TEXT, template TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, _sync_status TEXT DEFAULT 'synced');
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
  `;

  beforeEach(() => {
    adapter._sqlite.exec(LEGACY_SCHEMA);
    adapter._sqlite
      .prepare(
        `INSERT INTO accounts (id, user_id, name, type, initial_balance) VALUES ('a1','u1','Checking','checking', 250.25)`
      )
      .run();
    adapter._sqlite
      .prepare(
        `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, _sync_status)
         VALUES ('t1','u1','a1','2026-01-05','Grocer',-42.10,'pending')`
      )
      .run();
    adapter._sqlite
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES ('last_pull_at:u1','2026-01-05T00:00:00Z')`
      )
      .run();
  });

  it('starts at version 0', () => {
    expect(userVersion(adapter)).toBe(0);
  });

  it('upgrades without touching existing rows', async () => {
    await runMigrations(adapter);

    expect(userVersion(adapter)).toBe(latestVersion());
    expect(
      adapter._sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get('a1')
    ).toMatchObject({ name: 'Checking', initial_balance: 250.25 });
    expect(
      adapter._sqlite
        .prepare('SELECT * FROM transactions WHERE id = ?')
        .get('t1')
    ).toMatchObject({
      payee: 'Grocer',
      amount: -42.1,
      _sync_status: 'pending',
    });
    // The sync cursor must survive: losing it would force a full re-pull.
    expect(
      adapter._sqlite
        .prepare('SELECT value FROM sync_meta WHERE key = ?')
        .get('last_pull_at:u1')
    ).toEqual({ value: '2026-01-05T00:00:00Z' });
  });
});

describe('runMigrations — applying pending steps', () => {
  const ladder: Migration[] = [
    {
      version: 1,
      name: 'baseline',
      up: `CREATE TABLE t (id TEXT PRIMARY KEY)`,
    },
    { version: 2, name: 'add col', up: `ALTER TABLE t ADD COLUMN note TEXT` },
    {
      version: 3,
      name: 'functional',
      up: async (db) => {
        await db.execAsync(`INSERT INTO t (id, note) VALUES ('seed','hi')`);
      },
    },
  ];

  it('applies every step in order from scratch', async () => {
    const ended = await runMigrations(adapter, ladder);

    expect(ended).toBe(3);
    expect(userVersion(adapter)).toBe(3);
    expect(adapter._sqlite.prepare('SELECT * FROM t').all()).toEqual([
      { id: 'seed', note: 'hi' },
    ]);
  });

  it('applies only the steps a partially-migrated database is missing', async () => {
    await runMigrations(adapter, ladder.slice(0, 1));
    expect(userVersion(adapter)).toBe(1);
    adapter._sqlite.prepare(`INSERT INTO t (id) VALUES ('existing')`).run();

    await runMigrations(adapter, ladder);

    expect(userVersion(adapter)).toBe(3);
    // The pre-existing row is still there, and gained the new column.
    expect(
      adapter._sqlite.prepare('SELECT * FROM t ORDER BY id').all()
    ).toEqual([
      { id: 'existing', note: null },
      { id: 'seed', note: 'hi' },
    ]);
  });

  it('rolls a failed step back rather than leaving it half-applied', async () => {
    const broken: Migration[] = [
      ladder[0],
      {
        version: 2,
        name: 'broken',
        up: `ALTER TABLE t ADD COLUMN ok TEXT; THIS IS NOT SQL;`,
      },
    ];

    await expectRejection(
      runMigrations(adapter, broken),
      /THIS IS NOT SQL|syntax error/i
    );

    // Still on the last version that fully succeeded, and the partial DDL from
    // the failed step was rolled back.
    expect(userVersion(adapter)).toBe(1);
    const cols = adapter._sqlite.prepare(`PRAGMA table_info(t)`).all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id']);
  });

  it('resumes after a failure once the step is fixed', async () => {
    const broken: Migration[] = [
      ladder[0],
      { version: 2, name: 'broken', up: `NOT SQL` },
    ];
    await expectRejection(
      runMigrations(adapter, broken),
      /NOT SQL|syntax error/i
    );

    await runMigrations(adapter, ladder);

    expect(userVersion(adapter)).toBe(3);
  });
});

describe('runMigrations — guardrails', () => {
  it('refuses a database written by a newer build', async () => {
    adapter._sqlite.pragma('user_version = 99');

    await expect(runMigrations(adapter)).rejects.toThrow(
      /version 99, but this build only supports/
    );
  });

  it('rejects a ladder with a gap', async () => {
    await expect(
      runMigrations(adapter, [
        { version: 1, name: 'a', up: `CREATE TABLE x (id TEXT)` },
        { version: 3, name: 'c', up: `CREATE TABLE y (id TEXT)` },
      ])
    ).rejects.toThrow(/no gaps/);
  });

  it('rejects a ladder that does not start at 1', async () => {
    await expect(
      runMigrations(adapter, [
        { version: 0, name: 'zero', up: `CREATE TABLE x (id TEXT)` },
      ])
    ).rejects.toThrow(/expected version 1/);
  });

  it('rejects a duplicated version', async () => {
    await expect(
      runMigrations(adapter, [
        { version: 1, name: 'a', up: `CREATE TABLE x (id TEXT)` },
        { version: 1, name: 'dup', up: `CREATE TABLE y (id TEXT)` },
      ])
    ).rejects.toThrow(/expected version 2/);
  });
});

describe('runMigrations — two connections over one database file', () => {
  // The real concurrency case is two web tabs holding separate connections to
  // the same OPFS file, so it needs a file-backed database: ':memory:' is
  // private per connection, and a single shared connection cannot model it
  // (nested BEGIN throws, which is an artifact of the harness, not the code).
  let dir: string;
  let file: string;
  const conns: Database.Database[] = [];

  const connect = (): Adapter => {
    const sqlite = new Database(file);
    conns.push(sqlite);
    return {
      _sqlite: sqlite,
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      getFirstAsync: async <T>(sql: string) =>
        (sqlite.prepare(sql).get() ?? null) as T | null,
      withTransactionAsync: async (fn: () => Promise<void>) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          await fn();
          sqlite.exec('COMMIT');
        } catch (e) {
          sqlite.exec('ROLLBACK');
          throw e;
        }
      },
    };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestworth-mig-'));
    file = path.join(dir, 'test.db');
  });

  afterEach(() => {
    for (const c of conns.splice(0)) {
      try {
        c.close();
      } catch {
        // already closed
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ladder: Migration[] = [
    { version: 1, name: 'one', up: `CREATE TABLE a (id TEXT)` },
    { version: 2, name: 'two', up: `CREATE TABLE b (id TEXT)` },
  ];

  it('never leaves a version stamped over a schema that is missing', async () => {
    const a = connect();
    const b = connect();

    const results = await Promise.allSettled([
      runMigrations(a, ladder),
      runMigrations(b, ladder),
    ]);

    // A loser may lose the write lock — that is SQLite doing its job, and it is
    // recoverable (see the retry test below). What must never happen is a
    // failure that indicates replayed DDL or a half-applied schema.
    const failures = results
      .filter((r) => r.status === 'rejected')
      .map((r: any) => String(r.reason));
    for (const f of failures) {
      expect(f).toMatch(/database is locked|database table is locked|busy/i);
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    // Whatever happened, the database is internally consistent.
    const verifier = connect();
    expect(userVersion(verifier)).toBe(2);
    expect(tableNames(verifier)).toEqual(['a', 'b']);
  });

  it('a runner that lost the write lock succeeds on retry', async () => {
    // Why lib/db.ts must not cache a rejected init promise: this is the second
    // browser tab. Its first attempt can fail on the lock; the retry has to
    // work, otherwise that tab is broken until the user force-reloads.
    const a = connect();
    const b = connect();
    const results = await Promise.allSettled([
      runMigrations(a, ladder),
      runMigrations(b, ladder),
    ]);
    const loser = results.findIndex((r) => r.status === 'rejected');
    if (loser === -1) return; // no contention this run; nothing to retry

    await expect(runMigrations(loser === 0 ? a : b, ladder)).resolves.toBe(2);
    const verifier = connect();
    expect(userVersion(verifier)).toBe(2);
    expect(tableNames(verifier)).toEqual(['a', 'b']);
  });

  it('a second runner arriving afterwards is a clean no-op', async () => {
    await runMigrations(connect(), ladder);

    await expect(runMigrations(connect(), ladder)).resolves.toBe(2);

    const verifier = connect();
    expect(userVersion(verifier)).toBe(2);
    expect(tableNames(verifier)).toEqual(['a', 'b']);
  });
});

describe('shipped ladder', () => {
  it('is well formed', async () => {
    await expect(runMigrations(makeAdapter(), MIGRATIONS)).resolves.toBe(
      latestVersion()
    );
  });

  it('has no duplicate names', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

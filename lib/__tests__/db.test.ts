// lib/db.ts installs the transaction queue on the connection it opens (#110),
// and sweeps orphan synced splits once the migration ladder is done (#137).
//
// Every other suite mocks '../db' with a factory of its own, so initDb never
// runs in jest, and nothing else would notice if it stopped doing either.
// Here expo-sqlite is mocked instead, and the REAL getDb() opens a connection
// shaped like expo-sqlite 16's SQLiteDatabase.
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import * as SQLite from 'expo-sqlite';
import { getDb } from '../db';
import { latestVersion } from '../migrations';
import { isSerialised } from '../transactionQueue';

/**
 * expo-sqlite 16's SQLiteDatabase as far as initDb and the migration ladder
 * use it: prototype methods that reach the connection through `this`, and a
 * withTransactionAsync with BEGIN inside its try (build/SQLiteDatabase.js).
 * It keeps `PRAGMA user_version`, and counts the transactions that reached it
 * without going through the queue.
 */
class FakeSQLiteDatabase {
  statements: string[] = [];
  userVersion = 0;
  unqueued = 0;
  /** What a plain statement answers; initDb's only one is the sweep's DELETE. */
  runResult: { changes: number } | Error = { changes: 0 };

  async execAsync(source: string): Promise<void> {
    this.statements.push(source);
    const set = /^PRAGMA user_version = (\d+)$/.exec(source);
    if (set) this.userVersion = Number(set[1]);
  }

  async getFirstAsync<T>(source: string): Promise<T | null> {
    return source === 'PRAGMA user_version'
      ? ({ user_version: this.userVersion } as T)
      : null;
  }

  async runAsync(
    source: string
  ): Promise<{ lastInsertRowId: number; changes: number }> {
    // Recorded once it has run, a macrotask later, as a real statement would
    // finish: one initDb did not wait for shows up only after getDb() resolved.
    await new Promise((r) => setTimeout(r, 0));
    this.statements.push(source);
    if (this.runResult instanceof Error) throw this.runResult;
    return { lastInsertRowId: 0, changes: this.runResult.changes };
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    // A call the queue makes finds the queue already on the instance.
    if (!isSerialised(this)) this.unqueued++;
    try {
      await this.execAsync('BEGIN');
      await task();
      await this.execAsync('COMMIT');
    } catch (e) {
      await this.execAsync('ROLLBACK');
      throw e;
    }
  }
}

const connection = new FakeSQLiteDatabase();

beforeAll(() => {
  (SQLite.openDatabaseAsync as unknown as jest.Mock).mockResolvedValue(
    connection
  );
});

it("opens the connection with its transactions queued, the migration ladder's included", async () => {
  const db = await getDb();

  expect(db).toBe(connection);
  expect(isSerialised(db)).toBe(true);
  // Every step ran, each in a transaction of its own, and each of those went
  // through the queue: it is installed before runMigrations.
  expect(connection.userVersion).toBe(latestVersion());
  expect(connection.statements.filter((s) => s === 'BEGIN')).toHaveLength(
    latestVersion()
  );
  expect(connection.unqueued).toBe(0);
});

it('runs two transactions on that connection one after the other', async () => {
  const db = await getDb();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const first = db.withTransactionAsync(async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  const second = db.withTransactionAsync(async () => {
    order.push('second:start');
  });
  await new Promise((r) => setTimeout(r, 0));

  expect(order).toEqual(['first:start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first:start', 'first:end', 'second:start']);
});

/**
 * lib/db.ts loaded afresh, so that its first getDb() opens `connection`: the
 * module keeps the connection it opened for good. jest.requireActual is a
 * plain require here (nothing mocks ../db), spelled so because a bare
 * require() is a lint warning in this repo. The registry was reset, so the
 * expo-sqlite it loads is the fresh mock set up here.
 */
function freshGetDb(connection: FakeSQLiteDatabase): typeof getDb {
  jest.resetModules();
  (
    jest.requireMock('expo-sqlite').openDatabaseAsync as jest.Mock
  ).mockResolvedValue(connection);
  return jest.requireActual('../db').getDb;
}

describe('the launch sweep of orphan synced splits (#137)', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it.each([
    {
      removed: 2,
      logged: [expect.stringContaining('2 orphan synced split(s)')],
    },
    { removed: 0, logged: [] },
  ])(
    'D1: runs after the migration ladder and before getDb() hands out the connection, and logs only a sweep that removed something ($removed removed)',
    async ({ removed, logged }) => {
      const connection = new FakeSQLiteDatabase();
      connection.runResult = { changes: removed };

      const db = await freshGetDb(connection)();

      expect(db).toBe(connection);
      const stamped = connection.statements.indexOf(
        `PRAGMA user_version = ${latestVersion()}`
      );
      const swept = connection.statements.findIndex((s) =>
        s.startsWith('DELETE FROM transaction_splits')
      );
      // The ladder ran, then the sweep, which had finished by the time the
      // connection was handed out (the fake records a statement only then).
      expect(stamped).toBeGreaterThanOrEqual(0);
      expect(swept).toBeGreaterThan(stamped);
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual(logged);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('D1b: a sweep that fails only warns, and getDb() still hands out the connection', async () => {
    const connection = new FakeSQLiteDatabase();
    connection.runResult = new Error('disk I/O error');

    const outcome = await freshGetDb(connection)().then(
      (db) => (db === (connection as unknown) ? 'the connection' : db),
      (e) => String(e)
    );

    expect(outcome).toBe('the connection');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].map(String).join(' ')).toMatch(/disk I\/O error/);
    expect(log).not.toHaveBeenCalled();
  });
});

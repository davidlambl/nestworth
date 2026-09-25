// lib/db.ts installs the transaction queue on the connection it opens (#110).
//
// Every other suite mocks '../db' with a factory of its own, so initDb never
// runs in jest, and nothing else would notice if it stopped installing the
// queue. Here expo-sqlite is mocked instead, and the REAL getDb() opens a
// connection shaped like expo-sqlite 16's SQLiteDatabase.
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

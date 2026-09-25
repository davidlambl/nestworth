// lib/transactionQueue.ts (#110): the withTransactionAsync callers of one
// connection run one at a time. Pure: the connections here are plain objects
// and one class shaped like expo-sqlite's SQLiteDatabase, with no SQLite
// behind them. What the queue prevents on a real connection is in
// syncTransactionQueue.test.ts.
import {
  isSerialised,
  serialiseTransactions,
  TRANSACTION_WAIT_WARN_MS,
} from '../transactionQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every callback already queued on a settled promise run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A connection whose withTransactionAsync logs BEGIN, COMMIT and ROLLBACK
 * around the task, where expo-sqlite would run them.
 */
function makeDb() {
  const log: string[] = [];
  const db = {
    withTransactionAsync: async (task: () => Promise<void>) => {
      log.push('BEGIN');
      try {
        await task();
        log.push('COMMIT');
      } catch (e) {
        log.push('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, log };
}

/**
 * expo-sqlite 16's shape (build/SQLiteDatabase.js): a prototype method that
 * reaches the connection through `this`. The fixture's adapter is a closure
 * that never touches `this`, so only a class like this one can tell a queue
 * that calls the method it replaced on the instance from one that calls it
 * detached, which throws on the first real transaction.
 */
class ExpoShapedDb {
  statements: string[] = [];
  tasks: (() => Promise<void>)[] = [];

  async execAsync(source: string): Promise<void> {
    this.statements.push(source);
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.tasks.push(task);
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

describe('serialiseTransactions', () => {
  it('starts the next call only once the previous one has settled, COMMIT included', async () => {
    const { db, log } = makeDb();
    serialiseTransactions(db);
    const gate = deferred();

    const first = db.withTransactionAsync(async () => {
      log.push('first');
      await gate.promise;
    });
    const second = db.withTransactionAsync(async () => {
      log.push('second');
    });
    await flush();

    expect(log).toEqual(['BEGIN', 'first']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual([
      'BEGIN',
      'first',
      'COMMIT',
      'BEGIN',
      'second',
      'COMMIT',
    ]);
  });

  it('rejects the caller whose task threw, with its error, and runs the next call after the ROLLBACK', async () => {
    const { db, log } = makeDb();
    serialiseTransactions(db);
    const gate = deferred();
    const boom = new Error('boom');

    const first = db
      .withTransactionAsync(async () => {
        log.push('first');
        await gate.promise;
        throw boom;
      })
      .then(
        () => 'resolved',
        (e: unknown) => e
      );
    const second = db.withTransactionAsync(async () => {
      log.push('second');
    });
    await flush();

    expect(log).toEqual(['BEGIN', 'first']);
    gate.resolve();
    expect(await first).toBe(boom);
    await second;
    expect(log).toEqual([
      'BEGIN',
      'first',
      'ROLLBACK',
      'BEGIN',
      'second',
      'COMMIT',
    ]);
  });

  it('runs calls in the order they were made, whatever order their tasks could finish in', async () => {
    const { db, log } = makeDb();
    serialiseTransactions(db);
    const gates = [deferred(), deferred(), deferred()];

    const calls = gates.map((gate, i) =>
      db.withTransactionAsync(async () => {
        log.push(`start ${i}`);
        await gate.promise;
        log.push(`end ${i}`);
      })
    );
    // The later tasks are free to finish; they have not even started.
    gates[2].resolve();
    gates[1].resolve();
    await flush();

    expect(log).toEqual(['BEGIN', 'start 0']);
    gates[0].resolve();
    await Promise.all(calls);
    expect(log).toEqual([
      'BEGIN',
      'start 0',
      'end 0',
      'COMMIT',
      'BEGIN',
      'start 1',
      'end 1',
      'COMMIT',
      'BEGIN',
      'start 2',
      'end 2',
      'COMMIT',
    ]);
  });

  it("calls the replaced method on its instance with the caller's own task, and passes its rejection through", async () => {
    const db = serialiseTransactions(new ExpoShapedDb());
    const task = async () => {};
    const boom = new Error('boom');

    await db.withTransactionAsync(task);
    const failed = await db
      .withTransactionAsync(async () => {
        throw boom;
      })
      .then(
        () => 'resolved',
        (e: unknown) => e
      );

    expect(db.tasks).toHaveLength(2);
    expect(db.tasks[0]).toBe(task);
    // What expo-sqlite rethrows after its ROLLBACK reaches the caller as is.
    expect(failed).toBe(boom);
    expect(db.statements).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
  });

  it('is idempotent, and a spread copy of the connection shares its queue', async () => {
    const { db, log } = makeDb();
    expect(isSerialised(db)).toBe(false);

    expect(serialiseTransactions(db)).toBe(db);
    const installed = db.withTransactionAsync;
    expect(isSerialised(db)).toBe(true);
    // One queue per connection: a second call installs nothing.
    serialiseTransactions(db);
    expect(db.withTransactionAsync).toBe(installed);

    // What the rollback tests hand the pure functions: a copy of the adapter
    // with one method replaced. It carries the marker, and its calls wait for
    // the original's.
    const copy = { ...db };
    expect(isSerialised(copy)).toBe(true);
    serialiseTransactions(copy);
    expect(copy.withTransactionAsync).toBe(installed);

    const gate = deferred();
    const viaOriginal = db.withTransactionAsync(async () => {
      log.push('original');
      await gate.promise;
    });
    const viaCopy = copy.withTransactionAsync(async () => {
      log.push('copy');
    });
    await flush();

    expect(log).toEqual(['BEGIN', 'original']);
    gate.resolve();
    await Promise.all([viaOriginal, viaCopy]);
    expect(log).toEqual([
      'BEGIN',
      'original',
      'COMMIT',
      'BEGIN',
      'copy',
      'COMMIT',
    ]);
  });
});

describe('the waiting watchdog', () => {
  let warn: jest.SpyInstance;
  let dev: boolean;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    dev = __DEV__;
  });

  afterEach(() => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
    warn.mockRestore();
    jest.useRealTimers();
  });

  /**
   * A call that starts at once and then holds the queue, and a second call
   * waiting behind it. Returns the release for the first.
   */
  function holdTheQueue() {
    const { db } = makeDb();
    serialiseTransactions(db);
    const gate = deferred();
    const first = db.withTransactionAsync(() => gate.promise);
    const second = db.withTransactionAsync(async () => {});
    return async () => {
      gate.resolve();
      await Promise.all([first, second]);
    };
  }

  // jest runs with __DEV__ true, as a development build does.
  it('warns once about a call still waiting for its turn, and never about one that started', async () => {
    const release = holdTheQueue();

    await jest.advanceTimersByTimeAsync(TRANSACTION_WAIT_WARN_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'has waited 5 s behind another transaction'
    );

    await release();
    await jest.advanceTimersByTimeAsync(10 * TRANSACTION_WAIT_WARN_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('arms nothing in a production build', async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    const release = holdTheQueue();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * TRANSACTION_WAIT_WARN_MS);
    expect(warn).not.toHaveBeenCalled();
    await release();
  });
});

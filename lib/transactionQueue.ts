/**
 * Runs the withTransactionAsync callers of one SQLite connection one at a
 * time (#110).
 *
 * Why. expo-sqlite's withTransactionAsync is BEGIN, the task, COMMIT, with
 * BEGIN inside its try (build/SQLiteDatabase.js), and its own docblock calls
 * it "not exclusive": nothing in expo-sqlite or below it serialises callers
 * on one connection, and lib/db.ts hands every caller the same one (on web,
 * one wa-sqlite connection in one worker; Electron runs the web export). So
 * a second caller's BEGIN failed ("cannot start a transaction within a
 * transaction") and its catch ran ROLLBACK, which ended the FIRST caller's
 * transaction: that caller's later statements committed one at a time, then
 * its COMMIT and its own ROLLBACK failed. Both directions happened. A delete
 * landing in the reset's wipe left every row and all four sync keys gone
 * behind the raw "cannot rollback - no transaction is active", or the parents
 * gone and their splits left behind; a wipe landing in a transfer delete left
 * one leg deleted and the other live (lib/__tests__/syncTransactionQueue.test.ts).
 * withExclusiveTransactionAsync would have closed it, but it throws on web;
 * nothing uses it, and it is left alone.
 *
 * How. serialiseTransactions replaces withTransactionAsync ON THE INSTANCE,
 * so every caller, present and future, goes through the queue without knowing
 * it: each call starts once the previous one has settled, however it settled.
 * A rejection reaches its own caller unchanged (expo-sqlite's rethrow after
 * its ROLLBACK included) and never holds up the next. lib/db.ts installs it
 * as it opens the connection, before the migration ladder runs, and the test
 * fixture's adapter applies it too (lib/testing/syncFixture.ts): the suites
 * mock '../db', so lib/db.ts never runs in jest. One timing change: BEGIN is
 * now issued a microtask after the call instead of synchronously inside it.
 *
 * Never call withTransactionAsync from inside another one's task. The inner
 * call waits for the outer to finish, and the outer waits for it: the outer
 * BEGIN has run and its COMMIT never comes, so every later plain write joins
 * a transaction nothing commits (lost when the process dies), and every later
 * transaction waits behind it. The app's writes freeze without an error. No
 * runtime signal tells a nested call from a concurrent one (the connection is
 * inside a transaction in both cases, and the task carries no token), so the
 * rule is kept by review, not detected and rejected as #110 first proposed.
 * The eight callers nest nothing: applyTransactionUpdate
 * (lib/transactionUpdate.ts), createTransfer (lib/transferCreate.ts),
 * applyTransactionDelete (lib/transactionDelete.ts),
 * applyAccountDelete (lib/accountDelete.ts),
 * usePostRecurringTransaction (lib/hooks/useRecurringRules.ts),
 * useReorderAccounts (lib/hooks/useAccounts.ts), wipeLocalData (lib/sync.ts)
 * and runMigrations (lib/migrations.ts), whose function steps are typed
 * without the method for this reason. In a development build, a call that has
 * waited 5 s for its turn logs a `[db]` warning: every transaction here takes
 * milliseconds, so a wait that long is already abnormal. Playwright forwards
 * the line (e2e/web/fixtures.ts) when the attempt runs past the stuck call by
 * that much; most of its waits give up after 10 s.
 *
 * What it does not cover. A statement run outside withTransactionAsync (every
 * write of the push and the pull, the realtime handlers, a hook's plain
 * write) still runs whenever it arrives, so it can land inside a caller's
 * transaction and share its fate: the wipe keeps such a row when it is
 * unsynced, as a hook's plain write leaves it, unless the write is an edit
 * that lands after its table's DELETE and finds no row; it deletes a synced
 * row, as a realtime write leaves it, or keeps it, by table order, for the
 * re-download to restore or refresh (wipeLocalData, #126); and a pull or
 * realtime write that lands in a hook's transaction which then fails is
 * rolled back with it, while the pull may still bank last_txn_pull_at, so the
 * row stays missing until the daily reconcile. Before #110 a colliding
 * caller's ROLLBACK did that too. Now it takes a failure inside the hook's
 * own transaction, which in practice means storage (a full disk, an I/O
 * error). A storage failure can also make SQLite abandon an open transaction
 * by itself, and the caller's later statements then commit alone, as they did
 * in a collision.
 */

/**
 * The method the queue wraps. expo-sqlite's SQLiteDatabase has it, and so
 * does the test fixture's adapter.
 */
export interface TransactionalDb {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

/** How long a call may wait for its turn before a development build warns. */
export const TRANSACTION_WAIT_WARN_MS = 5_000;

/**
 * Marks the installed function, so a second install is a no-op, and a copy of
 * the connection made by spreading it (the rollback tests make one) carries
 * the mark along with the function. Symbol.for, so two copies of this module
 * agree on it.
 */
const QUEUED = Symbol.for('nestworth.transactionQueue');

/** Whether `db.withTransactionAsync` is a queue this module installed. */
export function isSerialised(db: TransactionalDb): boolean {
  return Reflect.get(db.withTransactionAsync, QUEUED) === true;
}

/**
 * Queues `db`'s withTransactionAsync callers, in place, and returns `db`.
 * Calling it again on the same connection, or on a spread copy of it, does
 * nothing.
 */
export function serialiseTransactions<T extends TransactionalDb>(db: T): T {
  if (isSerialised(db)) return db;
  // Bound: expo-sqlite's method reaches the connection through `this`
  // (this.execAsync), and a detached one throws "Cannot read properties of
  // undefined (reading 'execAsync')" on the first real transaction. The
  // fixture's adapter never touches `this`, so no sync test would notice.
  const inner = db.withTransactionAsync.bind(db);
  // The queue lives in this closure, never on the instance: a spread copy of
  // the adapter takes the method but not a field written later, and only
  // closure state keeps the copy and the original on one queue.
  let tail: Promise<void> = Promise.resolve();
  const queued = (task: () => Promise<void>): Promise<void> => {
    const watchdog = __DEV__
      ? setTimeout(warnWaiting, TRANSACTION_WAIT_WARN_MS)
      : null;
    const run = tail.then(() => {
      if (watchdog !== null) clearTimeout(watchdog);
      return inner(task);
    });
    tail = run.then(ignore, ignore);
    return run;
  };
  Object.defineProperty(queued, QUEUED, { value: true });
  db.withTransactionAsync = queued;
  return db;
}

function ignore(): void {}

function warnWaiting(): void {
  console.warn(
    `[db] a transaction has waited ${TRANSACTION_WAIT_WARN_MS / 1000} s ` +
      'behind another transaction. A withTransactionAsync called from inside ' +
      "another one's task waits for itself forever (lib/transactionQueue.ts)."
  );
}

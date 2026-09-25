// The reset's wipe keeps a row written after its count (#126).
//
// resetLocalData counts the user's unsynced rows, and wipeLocalData counts
// them again as the first statement of its own transaction (#97). Mutation
// hooks write straight to SQLite, ungated by the sync lock, and a hook's plain
// write (one made outside withTransactionAsync) joins whatever transaction is
// open on the shared connection, the wipe's included, after its count. Such a
// row used to be wiped unpushed whenever its table's DELETE had not run yet,
// and a queued rule delete came back live: the re-download restored the row
// it had marked. Every DELETE of the wipe now takes only 'synced' rows. The
// count refuses over 'pending' and 'deleted' ones and the wipe removes only
// 'synced' ones, so a row a plain write lands after the count is kept if it
// is unsynced when its table's DELETE runs: a new row whatever the order of
// the DELETEs, and an edit of an existing row that lands before its table's
// DELETE. An edit that lands after it still finds no row (the last test).
//
// The joined writes below are the hooks' own statements, run synchronously on
// `_sqlite` from inside the wipe, so they land in its transaction after the
// re-count and cannot re-enter the hooked method. Each regression test was
// proven red on the wipe before #126; the comment above its first assertion
// on the store says what that run left. The last test is a pin, green before
// #126 and after.
//
// The server clock runs a minute ahead, as syncResetHardening.test.ts's
// serverClockAhead does: the fake stamps an upsert only when given a clock,
// and without one a parent pushed alone would keep a stamp older than the
// reset's cursor, which is the clock-skew path (#112), not the one production
// takes.
//
// Own file: these drive resetLocalData, which holds the lock, and module state
// (the lock, lastError) is shared by every test in a file. The helpers are
// copied from syncResetHardening.test.ts.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  pullChanges,
  pushChanges,
  resetLocalData,
  wipeLocalData,
} from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When every seeded row last synced, in PostgREST's rendering. */
const SYNCED_AT = '2026-05-01T00:00:00+00:00';
/** What the four sync_meta keys held before the reset. */
const T0 = '2026-06-15T00:00:00Z';

// Every sync_meta key the engine keeps for a user; the wipe clears all four.
const META_KEYS = [
  'last_pull_at',
  'last_pull_attempt_at',
  'last_txn_pull_at',
  'last_txn_reconcile_at',
].map((k) => `${k}:u`);

/**
 * The wipe's split DELETE, the first of its statements that removes
 * anything: no other split DELETE has `user_id = ?` in a subquery. Matches
 * the statement before #126 too, which the red proofs ran against.
 */
const WIPE_SPLIT_DELETE =
  /^DELETE FROM transaction_splits\s+WHERE [\s\S]*\(SELECT id FROM transactions\s+WHERE user_id = \?/;
/** The wipe's rules DELETE, before #126 and after. */
const WIPE_RULES_DELETE = /^DELETE FROM recurring_rules WHERE user_id = \?/;

let ctx: ReturnType<typeof wireSyncMocks>;
let meta: ReturnType<typeof wireSqliteSyncMeta>;
let quiet: jest.SpyInstance[];

beforeEach(async () => {
  ctx = wireSyncMocks({
    serverNow: toPgTimestamp(new Date(Date.now() + 60_000).toISOString()),
  });
  meta = wireSqliteSyncMeta(ctx.adapter);
  setLastError(null);
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );

  // a1, t1 split into s1 and s2, and r1: on the server and, as of the last
  // pull, here.
  ctx.store.accounts = [remoteAccount({ id: 'a1', updated_at: SYNCED_AT })];
  ctx.store.transactions = [
    remoteTxn({ id: 't1', amount: -10, updated_at: SYNCED_AT }),
  ];
  ctx.store.transaction_splits = ['s1', 's2'].map((id) => ({
    id,
    transaction_id: 't1',
    amount: -5,
    memo: null,
    updated_at: SYNCED_AT,
  }));
  ctx.store.recurring_rules = [remoteRule({ id: 'r1', updated_at: SYNCED_AT })];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    amount: -10,
    updated_at: SYNCED_AT,
  });
  for (const id of ['s1', 's2']) {
    await insertLocalSplit(ctx.adapter, {
      id,
      transaction_id: 't1',
      amount: -5,
      updated_at: SYNCED_AT,
    });
  }
  await insertLocalRule(ctx.adapter, { id: 'r1', updated_at: SYNCED_AT });
  for (const k of META_KEYS) meta.set(k, T0);
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
  setLastError(null);
});

/**
 * Runs `fn` just before the `nth` call of `method` whose SQL matches `match`.
 * Swapped on the adapter in place: resetLocalData reads getDb() once and
 * calls the wipe's statements on that object.
 */
function beforeNth(
  method: 'getAllAsync' | 'getFirstAsync' | 'runAsync',
  match: RegExp,
  nth: number,
  fn: () => void
): () => boolean {
  const real = ctx.adapter[method].bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  let seen = 0;
  let fired = false;
  (ctx.adapter as any)[method] = async (sql: string, params: any[] = []) => {
    if (match.test(sql) && ++seen === nth) {
      fired = true;
      fn();
    }
    return real(sql, params);
  };
  return () => fired;
}

/** Runs `fn` right after the first call of `method` whose SQL matches `match`. */
function afterFirst(
  method: 'getAllAsync' | 'getFirstAsync' | 'runAsync',
  match: RegExp,
  fn: () => void
): () => boolean {
  const real = ctx.adapter[method].bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  let fired = false;
  (ctx.adapter as any)[method] = async (sql: string, params: any[] = []) => {
    const out = await real(sql, params);
    if (!fired && match.test(sql)) {
      fired = true;
      fn();
    }
    return out;
  };
  return () => fired;
}

// --- the hooks' plain writes, synchronous and past the adapter ---------------

const now = () => new Date().toISOString();

/** useCreateTransaction: the parent, then each split, all 'pending'. */
function createTransactionSync(id: string, splitIds: string[]) {
  const at = now();
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
          status, created_at, updated_at, _sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      id,
      'u',
      'a1',
      '2026-09-25',
      'Typed',
      -10,
      null,
      null,
      'pending',
      at,
      at
    );
  for (const splitId of splitIds) {
    ctx.adapter._sqlite
      .prepare(
        `INSERT INTO transaction_splits
           (id, transaction_id, amount, memo, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      .run(splitId, id, -10 / splitIds.length, null, at);
  }
}

/** useCreateAccount's INSERT. */
function createAccountSync(id: string) {
  const at = now();
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO accounts
         (id, user_id, name, type, icon, initial_balance, exclude_from_total,
          sort_order, is_archived, created_at, updated_at, _sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`
    )
    .run(id, 'u', 'Savings', 'savings', null, 0, 0, 1, at, at);
}

/** useCreateRecurringRule's INSERT. */
function createRuleSync(id: string) {
  const at = now();
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO recurring_rules
         (id, user_id, account_id, frequency, next_date, end_date, template,
          created_at, updated_at, _sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(id, 'u', 'a1', 'monthly', '2026-10-01', null, '{}', at, at);
}

/**
 * useDeleteRecurringRule's UPDATE: the one plain writer of a 'deleted' row.
 * Returns how many rows it matched.
 */
function deleteRuleSync(id: string): number {
  return ctx.adapter._sqlite
    .prepare(
      "UPDATE recurring_rules SET _sync_status = 'deleted', updated_at = ? WHERE id = ?"
    )
    .run(now(), id).changes;
}

/**
 * useReceiptPhoto's UPDATE: the one plain field edit of a transaction (every
 * other one is a transaction of its own, which waits for the wipe's). It
 * leaves the splits alone.
 */
function attachReceiptSync(id: string) {
  ctx.adapter._sqlite
    .prepare(
      "UPDATE transactions SET receipt_path = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ?"
    )
    .run(`u/${id}.jpg`, now(), id);
}

/**
 * A pending split under a parent that is already synced. No plain writer
 * lands one after the count: useCreateTransaction writes its parent, pending,
 * first.
 */
function insertPendingSplitSync(id: string, txnId: string) {
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO transaction_splits
         (id, transaction_id, amount, memo, updated_at, _sync_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    )
    .run(id, txnId, -2, null, now());
}

// --- what is where -----------------------------------------------------------

/** `id:status` for every row of a table, by id, whoever it belongs to. */
function rows(table: string): string[] {
  return (
    ctx.adapter._sqlite
      .prepare(`SELECT id, _sync_status FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);
}

/** The whole local store: splits read by id, so an orphan would show. */
function local() {
  return {
    accounts: rows('accounts'),
    transactions: rows('transactions'),
    splits: rows('transaction_splits'),
    rules: rows('recurring_rules'),
  };
}

/** The four keys, as the SQLite table holds them. */
const keys = () => META_KEYS.map((k) => meta.get(k));

/** Every key written again by the re-download, none left from before. */
function expectKeysRestamped() {
  for (const value of keys()) {
    expect(value).toEqual(expect.any(String));
    expect(value).not.toBe(T0);
  }
}

const serverIds = (table: string) =>
  ctx.store[table].map((r: any) => r.id).sort();

const serverRow = (table: string, id: string) =>
  ctx.store[table].find((r: any) => r.id === id);

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

describe("a plain write that joins the wipe after its count and before its table's DELETE survives it (#126)", () => {
  it('a transaction created after the count survives the wipe, the re-download runs over it, and the next push uploads it', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      createTransactionSync('t9', ['s9'])
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: t9 and s9 wiped, unpushed.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced', 't9:pending'],
      splits: ['s1:synced', 's2:synced', 's9:pending'],
      rules: ['r1:synced'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverIds('transactions')).toEqual(['t1', 't9']);
    expect(serverSplitIds('t9')).toEqual(['s9']);
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced', 't9:synced'],
      splits: ['s1:synced', 's2:synced', 's9:synced'],
      rules: ['r1:synced'],
    });
  });

  it("a pending split under a synced parent survives the parent's wipe, and the next push adopts the parent and uploads it", async () => {
    // An invariant pin, though red before #126: no plain writer lands this
    // state after the count (see insertPendingSplitSync). It pins the split
    // DELETE's own `_sync_status = 'synced'`, which the test above leaves
    // free: t9's split is spared by its parent's clause as well.
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      insertPendingSplitSync('s9', 't1')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: s9 wiped with t1's other splits.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced', 's9:pending'],
      rules: ['r1:synced'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2', 's9']);
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced', 's9:synced'],
      rules: ['r1:synced'],
    });
  });

  it('an account created after the count survives the wipe, and the next push uploads it', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      createAccountSync('a9')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: a9 wiped, unpushed.
    expect(local()).toEqual({
      accounts: ['a1:synced', 'a9:pending'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:synced'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverIds('accounts')).toEqual(['a1', 'a9']);
    expect(local().accounts).toEqual(['a1:synced', 'a9:synced']);
  });

  it('a rule created after the count survives the wipe, and the next push uploads it', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      createRuleSync('r9')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: r9 wiped, unpushed.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:synced', 'r9:pending'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverIds('recurring_rules')).toEqual(['r1', 'r9']);
    expect(local().rules).toEqual(['r1:synced', 'r9:synced']);
  });

  it('a rule deleted after the count stays deleted through the re-download, and the next push tombstones it', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      deleteRuleSync('r1')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: r1 wiped, then re-downloaded live and synced. The user's
    // delete was undone, with nothing left to push.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:deleted'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverRow('recurring_rules', 'r1').deleted_at).toEqual(
      expect.any(String)
    );
    expect(local().rules).toEqual([]);
  });

  it('a field edit after the count keeps the parent and its synced splits, and the next push uploads the parent alone', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () =>
      attachReceiptSync('t1')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: t1, s1 and s2 wiped, and t1 re-downloaded synced, without
    // the receipt: the edit lost.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:pending'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:synced'],
    });
    expectKeysRestamped();

    await pushChanges('u');

    expect(serverRow('transactions', 't1').receipt_path).toBe('u/t1.jpg');
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:synced'],
    });
  });

  it('a field edit between the split DELETE and the transactions DELETE keeps the parent, and the pull after its push brings its splits back', async () => {
    // One of the two orders the narrowing leaves (the last test is the
    // other), and not a loss: t1 was still synced when the split DELETE ran,
    // so s1 and s2 went, and t1 is kept.
    const fired = afterFirst('runAsync', WIPE_SPLIT_DELETE, () =>
      attachReceiptSync('t1')
    );

    await resetLocalData('u');

    expect(fired()).toBe(true);
    // Before #126: the transactions DELETE took t1 as well, and the
    // re-download brought it back synced, without the receipt.
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:pending'],
      splits: [],
      rules: ['r1:synced'],
    });
    expectKeysRestamped();

    // t1 has no unsynced split row, so it goes up alone and the server keeps
    // its splits. Its new stamp is past the reset's cursor, so the push leaves
    // them to the pull after it (a stamp at or below the cursor would have the
    // push read them itself, #112).
    await pushChanges('u');
    expect(serverRow('transactions', 't1').receipt_path).toBe('u/t1.jpg');
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(local().splits).toEqual([]);

    await pullChanges('u');
    expect(local()).toEqual({
      accounts: ['a1:synced'],
      transactions: ['t1:synced'],
      splits: ['s1:synced', 's2:synced'],
      rules: ['r1:synced'],
    });
  });
});

describe('wipeLocalData on its own (#126)', () => {
  it('deletes only synced rows, so every row plain writes leave unsynced between its count and its DELETEs is kept, in every table', async () => {
    const fired = beforeNth('runAsync', WIPE_SPLIT_DELETE, 1, () => {
      createAccountSync('a9');
      createTransactionSync('t9', ['s9']);
      deleteRuleSync('r1');
    });

    await wipeLocalData(ctx.adapter, 'u');

    expect(fired()).toBe(true);
    // Before #126: an empty store.
    expect(local()).toEqual({
      accounts: ['a9:pending'],
      transactions: ['t9:pending'],
      splits: ['s9:pending'],
      rules: ['r1:deleted'],
    });
    expect(keys()).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('what the narrowing leaves (#126)', () => {
  it('a rule delete that lands after the rules DELETE finds no row, and the re-download brings the rule back live', async () => {
    // A pin, green before #126 and after: an edit or a delete of an existing
    // row that lands after its own table's DELETE matches nothing, as a hook
    // queued behind the wipe does, and the re-download restores the server's
    // copy. The user's delete is lost, with nothing left to push.
    let matched = -1;
    const fired = afterFirst('runAsync', WIPE_RULES_DELETE, () => {
      matched = deleteRuleSync('r1');
    });

    await resetLocalData('u');

    expect(fired()).toBe(true);
    expect(matched).toBe(0);
    expect(local().rules).toEqual(['r1:synced']);
    expect(serverRow('recurring_rules', 'r1').deleted_at ?? null).toBeNull();
  });
});

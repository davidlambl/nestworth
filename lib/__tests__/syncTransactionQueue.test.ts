// Transactions on the shared connection run one at a time (#110).
//
// expo-sqlite's withTransactionAsync is BEGIN, the task, COMMIT, with BEGIN
// inside its try, on the one connection lib/db.ts hands every caller. Two
// callers used to interleave: the second BEGIN failed ("cannot start a
// transaction within a transaction"), and its catch ran ROLLBACK, which ended
// the FIRST caller's transaction. That caller's later statements then
// committed one at a time, and its COMMIT failed. lib/transactionQueue.ts now
// queues the callers. The fixture's adapter applies it by default, as
// lib/db.ts does to the app's connection.
//
// Each test below was proven red on the adapter without the queue
// (`makeAdapter({ serialise: false })`, and the pre-#110 fixture): the comment
// above each `it` says what that run left behind. The seeds all belong to user
// 'u', the user the wipe is called for: its count is user-scoped, and a seed
// under another user would turn a refusal into a wipe.
//
// Rejections are compared as strings, never with rejects.toThrow(): the
// better-sqlite3 error class is bound per realm (sync-engine.md).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { wipeLocalData } from '../sync';
import { applyTransactionDelete } from '../transactionDelete';
import { createTransfer } from '../transferCreate';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
  wireSqliteSyncMeta,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** The time a hook stamps on its writes. */
const NOW = '2026-09-25T12:00:00.000Z';

/** Every sync_meta key the engine keeps for a user; the wipe clears all four. */
const META_KEYS = [
  'last_pull_at',
  'last_pull_attempt_at',
  'last_txn_pull_at',
  'last_txn_reconcile_at',
].map((k) => `${k}:u`);

/**
 * countUnsyncedRows. Called on wipeLocalData directly, as here, the only
 * query that matches is the wipe's own re-count, the first statement of its
 * transaction.
 */
const UNSYNCED_COUNT = /_sync_status IN \('pending','deleted'\)/;
/** The wipe's split DELETE: the first statement that removes anything. */
const WIPE_SPLIT_DELETE =
  /^DELETE FROM transaction_splits\s+WHERE transaction_id IN \(SELECT id FROM transactions WHERE user_id = \?\)/;

let adapter: ReturnType<typeof makeAdapter>;
let meta: ReturnType<typeof wireSqliteSyncMeta>;

beforeEach(() => {
  adapter = makeAdapter();
  meta = wireSqliteSyncMeta(adapter);
});

afterEach(() => {
  adapter._sqlite.close();
});

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The outcome of `p`, with its handler attached at once. An operation a hook
 * starts and nobody awaits yet would otherwise reject unhandled on the
 * adapter without the queue.
 */
function settle(p: Promise<unknown>): Promise<Outcome> {
  return p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: String(e) })
  );
}

/**
 * `run`, wrapped so that `fn` fires once, right after the first call whose SQL
 * matches `match` has resolved: a known point inside the caller's
 * transaction.
 */
function afterFirst<A extends unknown[], R>(
  run: (sql: string, ...rest: A) => Promise<R>,
  match: RegExp,
  fn: () => void
): { run: (sql: string, ...rest: A) => Promise<R>; fired: () => boolean } {
  let fired = false;
  return {
    run: async (sql: string, ...rest: A) => {
      const out = await run(sql, ...rest);
      if (!fired && match.test(sql)) {
        fired = true;
        fn();
      }
      return out;
    },
    fired: () => fired,
  };
}

/** Two synced accounts, a synced rule, and the user's four sync_meta keys. */
async function seedAccountsRuleAndKeys() {
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(adapter, { id: 'a2', updated_at: SYNCED_AT });
  await insertLocalRule(adapter, { id: 'r1', updated_at: SYNCED_AT });
  for (const k of META_KEYS) meta.set(k, SYNCED_AT);
}

/** A synced transaction t1 with one synced split s1. */
async function seedT1() {
  await insertLocalTxn(adapter, { id: 't1', updated_at: SYNCED_AT });
  await insertLocalSplit(adapter, {
    id: 's1',
    transaction_id: 't1',
    updated_at: SYNCED_AT,
  });
}

/** Both legs of a synced transfer, each with one synced split. */
async function seedTransfer() {
  for (const [id, account] of [
    ['from', 'a1'],
    ['to', 'a2'],
  ]) {
    await insertLocalTxn(adapter, {
      id,
      account_id: account,
      transfer_link_id: 'link',
      updated_at: SYNCED_AT,
    });
    await insertLocalSplit(adapter, {
      id: `${id}-s`,
      transaction_id: id,
      updated_at: SYNCED_AT,
    });
  }
}

/** `id:status` for every row of a table, by id. */
function rows(table: string): string[] {
  return (
    adapter._sqlite
      .prepare(`SELECT id, _sync_status FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);
}

/** The whole local store, and whether a transaction was left open. */
function store() {
  return {
    accounts: rows('accounts'),
    transactions: rows('transactions'),
    splits: rows('transaction_splits'),
    rules: rows('recurring_rules'),
    keys: META_KEYS.filter((k) => meta.get(k) !== undefined),
    open: adapter._sqlite.inTransaction,
  };
}

const EMPTY = {
  accounts: [],
  transactions: [],
  splits: [],
  rules: [],
  keys: [],
  open: false,
};

const NOTHING_LINKED = {
  ok: true,
  value: { linkedTransactionId: null, linkedAccountId: null },
};

describe("a hook's transaction that arrives during the wipe's waits for it (#110)", () => {
  // Without the queue: the delete's BEGIN failed and its ROLLBACK ended the
  // wipe's transaction just after the re-count. The delete rejected with
  // "cannot start a transaction within a transaction"; the wipe's DELETEs
  // committed one at a time, its COMMIT and then its ROLLBACK failed, and it
  // rejected with the raw "cannot rollback - no transaction is active" after
  // clearing every row and all four keys anyway.
  it("a delete that fires right after the wipe's re-count runs once the wipe has committed", async () => {
    await seedAccountsRuleAndKeys();
    await seedT1();
    let del: Promise<Outcome> | null = null;
    const hook = afterFirst(adapter.getFirstAsync, UNSYNCED_COUNT, () => {
      del = settle(applyTransactionDelete(adapter, 't1', { now: NOW }));
    });
    adapter.getFirstAsync = hook.run;

    const wipe = await settle(wipeLocalData(adapter, 'u'));

    expect(hook.fired()).toBe(true);
    expect(wipe).toEqual({ ok: true, value: undefined });
    // The delete ran over the emptied store: its marks matched nothing.
    expect(await del).toEqual(NOTHING_LINKED);
    expect(store()).toEqual(EMPTY);
  });

  // Without the queue: the same two rejections, one statement later. The
  // parents, the rule, the accounts and the keys were gone, and the split
  // DELETE had been rolled back: s1:synced was left under no parent.
  it("a delete that fires right after the wipe's split DELETE runs once the wipe has committed", async () => {
    await seedAccountsRuleAndKeys();
    await seedT1();
    let del: Promise<Outcome> | null = null;
    const hook = afterFirst(adapter.runAsync, WIPE_SPLIT_DELETE, () => {
      del = settle(applyTransactionDelete(adapter, 't1', { now: NOW }));
    });
    adapter.runAsync = hook.run;

    const wipe = await settle(wipeLocalData(adapter, 'u'));

    expect(hook.fired()).toBe(true);
    expect(wipe).toEqual({ ok: true, value: undefined });
    expect(await del).toEqual(NOTHING_LINKED);
    expect(store()).toEqual(EMPTY);
  });
});

describe("a wipe that arrives during a hook's transaction waits for it (#110)", () => {
  // Without the queue: the wipe's BEGIN failed ("cannot start a transaction
  // within a transaction") and its ROLLBACK ended the delete's transaction,
  // undoing the first leg's two marks. The second leg's marks then committed
  // alone, and the delete rejected with "cannot rollback - no transaction is
  // active": a half-deleted transfer, from:synced and to:deleted,
  // from-s:synced and to-s:deleted.
  it('a wipe that fires inside a transfer delete waits, then refuses over the four rows the delete marked', async () => {
    await seedAccountsRuleAndKeys();
    await seedTransfer();
    let wipe: Promise<Outcome> | null = null;
    // A copy of the adapter, as the rollback tests make one: the wipe runs on
    // the original, and the copy's queue must be the original's.
    const hook = afterFirst(
      adapter.runAsync,
      /^UPDATE transactions SET/,
      () => {
        wipe = settle(wipeLocalData(adapter, 'u'));
      }
    );
    const hooked = { ...adapter, runAsync: hook.run };

    const del = await settle(
      applyTransactionDelete(hooked, 'from', { now: NOW })
    );

    expect(hook.fired()).toBe(true);
    expect(del).toEqual({
      ok: true,
      value: { linkedTransactionId: 'to', linkedAccountId: 'a2' },
    });
    const refused = await wipe!;
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toMatch(
      /Couldn't upload 4 unsynced change\(s\)/
    );
    // Both legs are deleted whole, and the refusal wiped nothing.
    expect(store()).toEqual({
      accounts: ['a1:synced', 'a2:synced'],
      transactions: ['from:deleted', 'to:deleted'],
      splits: ['from-s:deleted', 'to-s:deleted'],
      rules: ['r1:synced'],
      keys: META_KEYS,
      open: false,
    });
  });

  // Without the queue: the wipe's ROLLBACK undid the first leg's INSERT, the
  // second leg committed alone, and the transfer rejected with "cannot
  // rollback - no transaction is active" while the wipe rejected with "cannot
  // start a transaction within a transaction": the to-leg pending and the
  // from-leg missing.
  it('a wipe that fires inside a transfer create waits, then refuses over the two legs', async () => {
    await seedAccountsRuleAndKeys();
    await seedT1();
    let wipe: Promise<Outcome> | null = null;
    const hook = afterFirst(
      adapter.runAsync,
      /^INSERT INTO transactions/,
      () => {
        wipe = settle(wipeLocalData(adapter, 'u'));
      }
    );
    const hooked = { ...adapter, runAsync: hook.run };
    const ids = ['link', 'leg-from', 'leg-to'];

    const transfer = await settle(
      createTransfer(
        hooked,
        {
          userId: 'u',
          fromAccountId: 'a1',
          toAccountId: 'a2',
          fromAccountName: 'Checking',
          toAccountName: 'Savings',
          amount: 25,
          txnDate: '2026-09-25',
        },
        { now: NOW, newId: () => ids.shift()! }
      )
    );

    expect(hook.fired()).toBe(true);
    expect(transfer.ok).toBe(true);
    const refused = await wipe!;
    expect(refused.ok ? '' : refused.error).toMatch(
      /Couldn't upload 2 unsynced change\(s\)/
    );
    expect(store()).toEqual({
      accounts: ['a1:synced', 'a2:synced'],
      transactions: ['leg-from:pending', 'leg-to:pending', 't1:synced'],
      splits: ['s1:synced'],
      rules: ['r1:synced'],
      keys: META_KEYS,
      open: false,
    });
  });
});

describe('the order is arrival order (#110)', () => {
  // Without the queue this collided too: the wipe's BEGIN failed and ended
  // the delete's transaction right after its BEGIN, the delete's marks
  // committed alone, and the delete rejected with "cannot rollback - no
  // transaction is active" while the wipe rejected with "cannot start a
  // transaction within a transaction".
  it('a delete queued before the wipe runs first, and the wipe then refuses over the rows it marked', async () => {
    await seedAccountsRuleAndKeys();
    await seedT1();

    const del = settle(applyTransactionDelete(adapter, 't1', { now: NOW }));
    const wipe = settle(wipeLocalData(adapter, 'u'));

    expect(await del).toEqual(NOTHING_LINKED);
    const refused = await wipe;
    expect(refused.ok ? '' : refused.error).toMatch(
      /Couldn't upload 2 unsynced change\(s\)/
    );
    expect(store()).toEqual({
      accounts: ['a1:synced', 'a2:synced'],
      transactions: ['t1:deleted'],
      splits: ['s1:deleted'],
      rules: ['r1:synced'],
      keys: META_KEYS,
      open: false,
    });
  });

  // Without the queue: the first test's outcome, both rejections and every
  // row and key gone. With it, the delete matches nothing; the re-download
  // that follows a real reset brings t1 back, for the user to delete again.
  it('a delete queued after the wipe runs over the emptied store and matches nothing', async () => {
    await seedAccountsRuleAndKeys();
    await seedT1();

    const wipe = settle(wipeLocalData(adapter, 'u'));
    const del = settle(applyTransactionDelete(adapter, 't1', { now: NOW }));

    expect(await wipe).toEqual({ ok: true, value: undefined });
    expect(await del).toEqual(NOTHING_LINKED);
    expect(store()).toEqual(EMPTY);
  });
});

// An edit of a transaction that no longer exists on this device (#127).
//
// applyTransactionUpdate ran its parent UPDATE without asking whether it
// matched a row, and two things can leave it none:
//
//  - The reset's wipe. An update whose transaction arrives while the wipe's
//    is open waits for it (#110), then runs over the emptied store. Its split
//    writes committed as orphan 'pending' rows; the re-download restored the
//    parent around them, and the next push adopted them and uploaded them
//    beside the parent's own splits.
//  - A tombstone. The pull, or realtime, consumes a transaction deleted
//    elsewhere with two plain statements (deleteLocalTransactionIfSynced),
//    which can land inside the update's transaction, between its BEGIN and
//    its parent UPDATE: expo-sqlite awaits each statement separately.
//
// The update now checks the UPDATE's `changes`. When it matched nothing, the
// update returns from its task, so its transaction commits what joined it and
// nothing of its own, and it throws once the transaction is over, the way the
// wipe refuses (#97). Throwing inside the task would roll back what joined:
// in the second shape, the tombstone's DELETEs.
//
// Each test was run against the code before #127: the comment above each
// `it` says what that run left behind. Rejections are compared as strings,
// never with rejects.toThrow(): the better-sqlite3 error class is bound per
// realm (sync-engine.md).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { pullChanges, pushChanges, wipeLocalData } from '../sync';
import { deleteLocalTransactionIfSynced } from '../tombstones';
import {
  applyTransactionUpdate,
  type UpdateTransactionInput,
} from '../transactionUpdate';
import {
  insertLocalSplit,
  insertLocalTxn,
  remoteTxn,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When t1 and its splits last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** The time the edit stamps on its writes. */
const EDITED_AT = '2026-09-25T12:00:00.000Z';

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
/** applyTransactionUpdate's parent UPDATE, the first statement of its task. */
const PARENT_UPDATE = /^UPDATE transactions SET/;

let ctx: ReturnType<typeof wireSyncMocks>;
let meta: ReturnType<typeof wireSqliteSyncMeta>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  // The wipe deletes the keys from the table; the default map never sees it.
  meta = wireSqliteSyncMeta(ctx.adapter);
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
});

/**
 * The text `p` rejects with, or null when it resolves, with the handler
 * attached at once: an update a hook starts and nobody awaits yet must not
 * reject unhandled.
 */
function rejection(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e) => String(e)
  );
}

/**
 * Runs `fn` right after the first call of `method` whose SQL matches `match`
 * resolves. Installed on the adapter itself, which the engine and the update
 * both reach by reference.
 */
function afterFirst(
  method: 'getFirstAsync' | 'runAsync',
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

/**
 * Runs `fn`, and waits for it, just before the `nth` call of `method` whose
 * SQL matches `match`.
 */
function beforeNth(
  method: 'getFirstAsync' | 'runAsync',
  match: RegExp,
  nth: number,
  fn: () => Promise<void>
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
      await fn();
    }
    return real(sql, params);
  };
  return () => fired;
}

const localTxnStatus = (id: string) =>
  (
    ctx.adapter._sqlite
      .prepare('SELECT _sync_status FROM transactions WHERE id = ?')
      .get(id) as { _sync_status: string } | undefined
  )?._sync_status ?? null;

/** `id:status` for every local split of `txnId`, by id. */
const localSplits = (txnId: string) =>
  (
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
      )
      .all(txnId) as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);

/** `id:amount` for every server split of `txnId`, by id. */
const serverSplits = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => `${s.id}:${s.amount}`)
    .sort();

/** t1 (-10) with splits s1 and s2 (-5 each), synced: on the server and here. */
async function seedT1() {
  ctx.store.transactions = [
    remoteTxn({ id: 't1', amount: -10, updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  ctx.store.transaction_splits = ['s1', 's2'].map((id) => ({
    id,
    transaction_id: 't1',
    amount: -5,
    memo: null,
    updated_at: toPgTimestamp(SYNCED_AT),
  }));
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
}

/**
 * What the transaction screen's save writes: applyTransactionUpdate, as
 * useUpdateTransaction calls it. The cast is for TxnDb's generic
 * getFirstAsync, which the fixture's adapter does not declare.
 */
function edit(
  input: Omit<UpdateTransactionInput, 'accountId'>,
  splitIds: string[] = []
) {
  let n = 0;
  return applyTransactionUpdate(
    ctx.adapter as any,
    { accountId: 'a1', ...input },
    { now: EDITED_AT, newSplitId: () => splitIds[n++] }
  );
}

describe("an update queued behind the reset's wipe (#127)", () => {
  // Before #127: the update rejected with "TypeError: Cannot read properties
  // of null (reading 'id')" after committing s3 and s4 as pending orphans.
  // The pull restored t1, s1 and s2 around them, and the push adopted t1 and
  // uploaded all four: splits of -5, -5, -4 and -6 under a -10 transaction,
  // on the server and here.
  it("U6: fails whole, and after the re-download the next push uploads only the server's set", async () => {
    await seedT1();
    for (const k of META_KEYS) meta.set(k, SYNCED_AT);
    // The user re-splits t1 (a splits UI, #26) while the wipe's transaction
    // is open: the update's transaction waits for it (#110).
    let update: Promise<string | null> | null = null;
    const fired = afterFirst('getFirstAsync', UNSYNCED_COUNT, () => {
      update = rejection(
        edit(
          {
            id: 't1',
            splits: [
              { amount: -4, memo: null },
              { amount: -6, memo: null },
            ],
          },
          ['s3', 's4']
        )
      );
    });

    await wipeLocalData(ctx.adapter, 'u');
    const err = await update;
    // The rest of the reset: the re-download, then the next push.
    await pullChanges('u');
    await pushChanges('u');

    expect(fired()).toBe(true);
    expect({
      err,
      t1: localTxnStatus('t1'),
      local: localSplits('t1'),
      server: serverSplits('t1'),
    }).toEqual({
      err: expect.stringMatching(/no longer exists/),
      t1: 'synced',
      local: ['s1:synced', 's2:synced'],
      server: ['s1:-5', 's2:-5'],
    });
  });
});

describe('an update racing a tombstone delete of its transaction (#127)', () => {
  // Before #127: these same rows, and the TypeError, so this proves the
  // readable error again (as U5 in applyTransactionUpdate.test.ts does). What
  // it pins is the refusal's shape. Throwing inside the task instead gives the
  // readable error too, but its ROLLBACK undoes the tombstone's DELETEs: t1,
  // s1 and s2 come back as synced, deleted elsewhere yet shown here, and a
  // pull that consumed the tombstone banks its cursor past it, so they stay
  // until the daily reconcile.
  it("U8 (pin of the idiom): the tombstone's two DELETEs, landing inside the update's transaction before its parent UPDATE, stay committed through the refusal", async () => {
    await seedT1();
    let joined: boolean | null = null;
    let deleted: boolean | null = null;
    const fired = beforeNth('runAsync', PARENT_UPDATE, 1, async () => {
      joined = ctx.adapter._sqlite.inTransaction;
      deleted = await deleteLocalTransactionIfSynced(ctx.adapter, 't1');
    });

    const err = await rejection(edit({ id: 't1', payee: 'Edited' }));

    expect(fired()).toBe(true);
    expect({
      joined,
      deleted,
      err,
      t1: localTxnStatus('t1'),
      splits: localSplits('t1'),
      open: ctx.adapter._sqlite.inTransaction,
    }).toEqual({
      joined: true,
      deleted: true,
      err: expect.stringMatching(/no longer exists/),
      t1: null,
      splits: [],
      open: false,
    });
  });
});

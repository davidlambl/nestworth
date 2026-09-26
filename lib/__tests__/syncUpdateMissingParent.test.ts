// An edit of a transaction that no longer exists on this device (#127), or
// that this device has deleted (#139).
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
// And a third thing left it one it should not have had: a row this device
// had marked 'deleted', a delete not uploaded yet. The edit set it back to
// 'pending', and the push uploaded the edit instead of the delete (#139).
//
// The update now checks the UPDATE's `changes`, and the UPDATE skips a
// 'deleted' row. When it matched nothing, the update returns from its task,
// so its transaction commits what joined it and nothing of its own, and it
// throws once the transaction is over, the way the wipe refuses (#97), with
// its own words for a row deleted here. Throwing inside the task would roll
// back what joined: in the second shape, the tombstone's DELETEs, and in the
// third, any plain write that landed there (U8b).
//
// Each test was run against the code before its issue's fix: the comment
// above each `it` says what that run left behind. Rejections are compared
// as strings, never with rejects.toThrow(): the better-sqlite3 error class
// is bound per realm (sync-engine.md).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyTransactionEvent } from '../realtimeHandlers';
import { pullChanges, pushChanges, wipeLocalData } from '../sync';
import { deleteLocalTransactionIfSynced } from '../tombstones';
import { applyTransactionDelete } from '../transactionDelete';
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

describe('an edit of a transaction this device has deleted (#139)', () => {
  /** When the delete marked its rows. */
  const DELETED_AT = '2026-09-25T11:00:00.000Z';

  /** The server's copy of `id`, with whether it carries a tombstone. */
  const serverTxn = (id: string) => {
    const r = ctx.store.transactions.find((t: any) => t.id === id);
    return r
      ? {
          payee: r.payee,
          memo: r.memo,
          amount: r.amount,
          tombstoned: r.deleted_at != null,
        }
      : null;
  };

  // Before #139: the edit resolved and set t1 back to 'pending' with payee
  // Edited, its splits still 'deleted' under it. The push upserted t1 live
  // and, its splits unsynced, replaced the server's set with nothing: t1 came
  // back on every device, edited and with no splits, and the delete was lost.
  // The server's splits are gone on both trees: here the delete's own batch
  // removes them.
  it('S1: is refused, and the next push uploads the delete, not the edit', async () => {
    await seedT1();
    await applyTransactionDelete(ctx.adapter, 't1', { now: DELETED_AT });

    const err = await rejection(edit({ id: 't1', payee: 'Edited' }));
    await pushChanges('u');

    expect({
      err,
      t1: localTxnStatus('t1'),
      local: localSplits('t1'),
      server: serverTxn('t1'),
      serverSplits: serverSplits('t1'),
    }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      t1: null,
      local: [],
      server: { payee: 'Payee', memo: null, amount: -10, tombstoned: true },
      serverSplits: [],
    });
  });

  // Before #139: the edit set `from` back to 'pending' with the new memo and
  // amount, and its leg lookup skips a deleted row, so `to` stayed deleted.
  // The push upserted `from` live and tombstoned `to`: half a transfer, its
  // transfer_link_id pointing at a row deleted everywhere.
  it('S2: of one leg of a transfer is refused, and the push tombstones both legs', async () => {
    ctx.store.transactions = [
      remoteTxn({
        id: 'from',
        account_id: 'a1',
        amount: -50,
        transfer_link_id: 'L',
      }),
      remoteTxn({
        id: 'to',
        account_id: 'a2',
        amount: 50,
        transfer_link_id: 'L',
      }),
    ];
    await insertLocalTxn(ctx.adapter, {
      id: 'from',
      account_id: 'a1',
      amount: -50,
      transfer_link_id: 'L',
    });
    await insertLocalTxn(ctx.adapter, {
      id: 'to',
      account_id: 'a2',
      amount: 50,
      transfer_link_id: 'L',
    });

    const deleted = await applyTransactionDelete(ctx.adapter, 'from', {
      now: DELETED_AT,
    });
    const err = await rejection(
      edit({ id: 'from', memo: 'Edited', amount: -60 })
    );
    await pushChanges('u');

    expect({
      linked: deleted.linkedTransactionId,
      err,
      local: { from: localTxnStatus('from'), to: localTxnStatus('to') },
      server: { from: serverTxn('from'), to: serverTxn('to') },
    }).toEqual({
      linked: 'to',
      err: expect.stringMatching(/was deleted on this device/),
      local: { from: null, to: null },
      server: {
        from: { payee: 'Payee', memo: null, amount: -50, tombstoned: true },
        to: { payee: 'Payee', memo: null, amount: 50, tombstoned: true },
      },
    });
  });

  // Before #139: the edit resolved, as in S1. What this pins is the shape of
  // the refusal for a row deleted here, as U8 does for a missing one: a plain
  // write that joined the edit's transaction, here realtime's insert of
  // another transaction, stays committed. Thrown inside the task instead, the
  // refusal reads the same, but its ROLLBACK takes t2 with it, as it would a
  // pull's write that the pull then banks its cursor past.
  it("U8b (pin of the idiom, for a row deleted here): a realtime write landing inside the refused edit's transaction stays committed", async () => {
    await seedT1();
    await applyTransactionDelete(ctx.adapter, 't1', { now: DELETED_AT });
    let joined: boolean | null = null;
    const fired = beforeNth('runAsync', PARENT_UPDATE, 1, async () => {
      joined = ctx.adapter._sqlite.inTransaction;
      await applyTransactionEvent(ctx.adapter, {
        eventType: 'INSERT',
        new: remoteTxn({
          id: 't2',
          amount: -3,
          updated_at: '2026-09-25T11:30:00+00:00',
        }),
      });
    });

    const err = await rejection(edit({ id: 't1', payee: 'Edited' }));

    expect(fired()).toBe(true);
    expect({
      joined,
      err,
      t1: localTxnStatus('t1'),
      t2: localTxnStatus('t2'),
      open: ctx.adapter._sqlite.inTransaction,
    }).toEqual({
      joined: true,
      err: expect.stringMatching(/was deleted on this device/),
      t1: 'deleted',
      t2: 'synced',
      open: false,
    });
  });

  // Before #139: the edit resolved, as in S1, and the drop below found t1
  // pending and left it. What this pins is where the status is read: inside
  // the task, before the transaction ends. Once the push has uploaded a
  // delete it hard-deletes the row (its batch's DELETE, run here by hand
  // right after the edit's COMMIT); read after the transaction, the refusal
  // would find no row and say "no longer exists".
  it('S3 (pin of where the status is read): the push dropping the row right after the refused edit commits leaves the refusal its own words', async () => {
    await seedT1();
    await applyTransactionDelete(ctx.adapter, 't1', { now: DELETED_AT });
    const real = ctx.adapter.withTransactionAsync.bind(ctx.adapter);
    ctx.adapter.withTransactionAsync = async (task: () => Promise<void>) => {
      await real(task);
      ctx.adapter._sqlite
        .prepare(
          "DELETE FROM transactions WHERE id = 't1' AND _sync_status = 'deleted'"
        )
        .run();
    };

    const err = await rejection(edit({ id: 't1', payee: 'Edited' }));

    expect({ err, t1: localTxnStatus('t1') }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      t1: null,
    });
  });

  // Green before #139 too. No writer produces a NULL `_sync_status`, and
  // every read hides such a row, but it is not deleted. `!= 'deleted'` is
  // NULL for it, not true, so that filter would refuse the edit with #127's
  // "no longer exists" over a row that exists; `IS NOT 'deleted'` lets it
  // through. Here because the fixture's column is nullable:
  // applyTransactionUpdate.test.ts declares it NOT NULL.
  it("N1 (pin): an edit of a row whose _sync_status is NULL still applies, since the filter is IS NOT 'deleted', not != 'deleted'", async () => {
    await seedT1();
    ctx.adapter._sqlite
      .prepare("UPDATE transactions SET _sync_status = NULL WHERE id = 't1'")
      .run();

    const err = await rejection(edit({ id: 't1', payee: 'Edited' }));

    expect({
      err,
      t1: ctx.adapter._sqlite
        .prepare('SELECT payee, _sync_status FROM transactions WHERE id = ?')
        .get('t1'),
    }).toEqual({
      err: null,
      t1: { payee: 'Edited', _sync_status: 'pending' },
    });
  });
});

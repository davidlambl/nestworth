// #125: every write of a server split checks, inside its own statement, that
// the parent's local row is still synced.
//
// Four writers put the server's splits into this store, each after checking
// that the parent is synced: initialPull's loop, step 3 of pullTransactions,
// the reconcile's refresh, and the push's refresh of a parent it uploaded
// alone (#112). Each used to leave a window between that check and its last
// INSERT, one statement per split. A re-split landing there (the parent
// pending, its old splits marked deleted, new ones pending) got the server's
// splits inserted synced beside its own, since their ids differ, and the next
// push, which sends every live split of a parent that carries an unsynced
// one, uploaded both: a permanent duplicate. Another check can only move such
// a window, never close it, so the DELETE of a parent's synced splits
// (deleteSyncedSplits) and each INSERT (upsertRemoteSplit) now carry the
// condition themselves.
//
// This file drives the two writers whose window lies between two local
// statements, running the edit synchronously from inside the adapter: the
// reconcile (its re-check, then the DELETE, then the INSERTs) and the push's
// refresh (its guarded mark-synced, then the same). W3 and W4 re-split right
// AFTER the DELETE. W3f and W4f edit a field right BEFORE it, the case the
// DELETE's own condition is for, as F3 does for step 3. The other two
// writers' windows are their split reads' round trips: W2 and F3 in
// syncPullStamp.test.ts, R2b in syncBootstrapPopulated.test.ts.
//
// The server's splits carry ids other than the local ones throughout (s5 and
// s6, where this device holds s1 and s2 and a re-split writes s3 and s4): a
// split that comes back under its own id takes the ON CONFLICT path, whose
// `_sync_status = 'synced'` condition already refused to overwrite an
// unsynced row.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { pullChanges, pushChanges } from '../sync';
import { setLastError } from '../syncStatus';
import {
  insertLocalSplit,
  insertLocalTxn,
  remoteTxn,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';
import { applyTransactionUpdate } from '../transactionUpdate';

/** This device's last pull began here, by its own clock: last_txn_pull_at. */
const CURSOR = '2026-06-15T00:00:00Z';
/** When this device last pulled t1 and its splits. */
const PULLED_AT = '2026-06-01T00:00:00Z';
/**
 * The server's clock as the push lands, 5 s short of that cursor: the device
 * clock runs ahead of the server's (syncSplitsPushedAlone.test.ts).
 */
const SERVER_BEHIND = '2026-06-14T23:59:55+00:00';
/** When another device re-split t1, by the server's clock. */
const RESPLIT_AT = '2026-06-14T23:59:45+00:00';
/** The local edit that makes t1 pending before the push, by this device's clock. */
const EDITED_AT = '2026-06-15T00:00:10Z';
/** The local edit that lands mid-sync, by this device's clock. */
const EDITED_AGAIN_AT = '2026-06-15T00:00:20Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
  setLastError(null);
});

/** A split of t1 as the server holds it. */
const serverSplit = (id: string) => ({
  id,
  transaction_id: 't1',
  amount: -5,
  memo: null,
  updated_at: '2026-06-01T00:00:00+00:00',
});

const localSplits = (txnId: string) =>
  (
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
      )
      .all(txnId) as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);

const localTxn = (id: string) => {
  const row = ctx.adapter._sqlite
    .prepare('SELECT _sync_status, updated_at FROM transactions WHERE id = ?')
    .get(id) as { _sync_status: string; updated_at: string } | undefined;
  return row && { status: row._sync_status, updated_at: row.updated_at };
};

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

/** t1's splits as this device last pulled them: s1 and s2, synced. */
async function insertPulledSplits() {
  for (const id of ['s1', 's2']) {
    await insertLocalSplit(ctx.adapter, {
      id,
      transaction_id: 't1',
      amount: -5,
      updated_at: PULLED_AT,
    });
  }
}

/**
 * A re-split of `txnId` as lib/transactionUpdate.ts writes it, in one SQLite
 * transaction: the parent pending with the edit's stamp, the splits it holds
 * marked deleted, and s3 and s4 inserted pending.
 */
function resplitLocally(txnId: string, now: string) {
  const sql = ctx.adapter._sqlite;
  sql.transaction(() => {
    sql
      .prepare(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?"
      )
      .run(now, txnId);
    sql
      .prepare(
        "UPDATE transaction_splits SET _sync_status = 'deleted', updated_at = ? WHERE transaction_id = ? AND _sync_status != 'deleted'"
      )
      .run(now, txnId);
    for (const [id, amount] of [
      ['s3', -3],
      ['s4', -7],
    ] as const) {
      sql
        .prepare(
          "INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status) VALUES (?, ?, ?, NULL, ?, 'pending')"
        )
        .run(id, txnId, amount, now);
    }
  })();
}

/** An edit that leaves the splits alone, a payee here: the parent pending. */
function editPayeeLocally(txnId: string, now: string) {
  ctx.adapter._sqlite
    .prepare(
      "UPDATE transactions SET payee = 'Edited again', updated_at = ?, _sync_status = 'pending' WHERE id = ?"
    )
    .run(now, txnId);
}

/**
 * The DELETE of a parent's synced splits: the same text at all three sites,
 * and on main, where it was the whole statement, the first line of it here.
 * Each test runs one engine entry point whose first such DELETE is the one it
 * means: the reconcile's comes before step 3's in pullChanges, and
 * pushChanges has only the refresh's.
 */
const SYNCED_SPLIT_DELETE =
  /^DELETE FROM transaction_splits WHERE transaction_id = \? AND _sync_status = 'synced'/;

/**
 * Runs `edit` once, right before or right after the first DELETE of a
 * parent's synced splits the engine sends. The engine reaches the adapter by
 * reference (wireSyncMocks mocks getDb to resolve ctx.adapter itself), so
 * replacing the method on that object puts the edit between two of the
 * engine's statements, where a mutation hook's write can land. The edit
 * writes through `_sqlite`, past the adapter, so it cannot re-enter this
 * wrapper.
 */
function atFirstSyncedSplitDelete(
  when: 'before' | 'after',
  edit: () => void
): () => boolean {
  const real = ctx.adapter.runAsync.bind(ctx.adapter);
  let fired = false;
  ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
    const hit = !fired && SYNCED_SPLIT_DELETE.test(sql);
    if (hit) {
      fired = true;
      if (when === 'before') edit();
    }
    const out = await real(sql, params);
    if (hit && when === 'after') edit();
    return out;
  };
  return () => fired;
}

/**
 * A due reconcile that heals t1 and nothing else: the server corrected it to
 * an OLDER stamp than the local copy, so no incremental read lists it (the
 * cursor is later than both), and it holds s5 and s6 where this device holds
 * s1 and s2. No reconcile key, so the enumeration is due.
 */
async function seedReconcile() {
  ctx.meta.set('last_pull_at:u', CURSOR);
  ctx.meta.set('last_pull_attempt_at:u', CURSOR);
  ctx.meta.set('last_txn_pull_at:u', CURSOR);
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    updated_at: '2026-03-01T00:00:00Z',
    payee: 'Stale',
  });
  await insertPulledSplits();
  ctx.store.transactions = [
    remoteTxn({ id: 't1', updated_at: '2026-02-01T00:00:00Z', payee: 'Fixed' }),
  ];
  ctx.store.transaction_splits = [serverSplit('s5'), serverSplit('s6')];
}

/**
 * The #112 case: t1 synced here with s1 and s2 and re-split on the server into
 * s5 and s6, then edited here without touching its splits, so the push
 * uploads it alone. The server's clock is behind the cursor, so the stamp the
 * parent adopts is one the next pull would not list, and the push reads t1's
 * splits itself after its loop.
 */
async function seedPushedAlone() {
  ctx.meta.set('last_txn_pull_at:u', CURSOR);
  ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
  ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: RESPLIT_AT })];
  ctx.store.transaction_splits = [serverSplit('s5'), serverSplit('s6')];
  await insertLocalTxn(ctx.adapter, { id: 't1', updated_at: PULLED_AT });
  await insertPulledSplits();
  // The cast is for TxnDb's generic getFirstAsync, which the fixture's
  // adapter does not declare.
  await applyTransactionUpdate(
    ctx.adapter as any,
    { accountId: 'a1', id: 't1', payee: 'Edited' },
    { now: EDITED_AT, newSplitId: () => 'unused' }
  );
  ctx.installSupabase({ serverNow: SERVER_BEHIND });
}

describe("the reconcile's split writes (#125)", () => {
  it("W3: a re-split landing between the reconcile's re-check and its split writes is not doubled", async () => {
    await seedReconcile();
    const fired = atFirstSyncedSplitDelete('after', () =>
      resplitLocally('t1', EDITED_AGAIN_AT)
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // The DELETE ran first and took s1 and s2, so the re-split marked nothing
    // deleted, and s3 and s4 are its own. Before #125 the INSERTs that
    // followed wrote s5 and s6 beside them.
    expect(localSplits('t1')).toEqual(['s3:pending', 's4:pending']);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
    });

    // The push sends every live split of a parent that carries an unsynced
    // one, so before #125 it left all four on the server.
    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("W3f: a field edit landing between the reconcile's re-check and its DELETE keeps the parent's own synced splits", async () => {
    await seedReconcile();
    const fired = atFirstSyncedSplitDelete('before', () =>
      editPayeeLocally('t1', EDITED_AGAIN_AT)
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // Before #125 the DELETE took s1 and s2 and the INSERTs wrote s5 and s6
    // under the pending parent; with the INSERT's condition alone it would be
    // left with no splits at all. It keeps the set it had,
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);

    // and the pull after its push brings the server's, as in step 3 (F3):
    // the push uploads t1 alone and the server keeps s5 and s6, and the fake
    // stamps the update a minute past this device's clock, after the cursor
    // this pull banked, so the next pull lists t1, synced by then.
    ctx.installSupabase({
      serverNow: toPgTimestamp(new Date(Date.now() + 60_000).toISOString()),
    });
    await pushChanges('u');
    expect(serverSplitIds('t1')).toEqual(['s5', 's6']);

    expect(await pullChanges('u')).toBe(true);
    expect(localTxn('t1')?.status).toBe('synced');
    expect(localSplits('t1')).toEqual(['s5:synced', 's6:synced']);
  });
});

describe("the push's refresh of a parent it uploaded alone (#112, #125)", () => {
  it("W4: a re-split landing between the refresh's mark and its split writes is not doubled", async () => {
    await seedPushedAlone();
    const fired = atFirstSyncedSplitDelete('after', () =>
      resplitLocally('t1', EDITED_AGAIN_AT)
    );

    await pushChanges('u');

    expect(fired()).toBe(true);
    // As in W3: s1 and s2 went with the DELETE, and s3 and s4 are the
    // re-split's own. Before #125 s5 and s6 were written beside them.
    expect(localSplits('t1')).toEqual(['s3:pending', 's4:pending']);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
    });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("W4f: a field edit landing between the refresh's mark and its DELETE keeps the parent's own synced splits", async () => {
    await seedPushedAlone();
    const fired = atFirstSyncedSplitDelete('before', () =>
      editPayeeLocally('t1', EDITED_AGAIN_AT)
    );

    await pushChanges('u');

    expect(fired()).toBe(true);
    // Before #125 the DELETE took s1 and s2 and the INSERTs wrote s5 and s6
    // under the pending parent; with the INSERT's condition alone it would be
    // left with none.
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);

    // Its next push uploads the second edit alone under the same skew, and
    // refreshes it then.
    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s5:synced', 's6:synced']);
    expect(serverSplitIds('t1')).toEqual(['s5', 's6']);
  });
});

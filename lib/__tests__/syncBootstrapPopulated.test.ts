// #96: initialPull is written for an EMPTY store. Its split loop deletes no
// stale synced split (and until #113 did not filter by the parent's local
// status either), and it reads live rows only and then banks both transaction
// keys. Over a store that already holds the user's rows that does two kinds of
// damage, which the review of #91 reproduced with fixture probes (the P9
// scenarios in that PR's body):
//
//   - a DUPLICATE SPLIT SET: the server's splits land beside a local pending
//     re-split (P9-A, until #113), or beside synced splits another device has
//     since replaced (P9-B). The next push sends every local split of a
//     pending parent, so the server ends up holding both sets;
//   - a SURVIVING DELETION: a transaction tombstoned elsewhere is never read,
//     and both transaction keys are banked past it (P9-C).
//
// #91 keeps the ordinary paths off it: needsInitialPull asks for both pull keys
// to be unset. What remained is narrow: a first bootstrap killed mid-download;
// one that gave up on a failed read (a lost session included, #95) with no
// pull after it to record an attempt, because its session was cancelled
// before startSyncSession's fullSync, or that fullSync was refused for want of
// a session (#95 stamps neither key), or its push threw before the pull; a
// reset whose download threw after landing some tables; or a row that a local
// write or a realtime event landed before the bootstrap.
// Since #96 initialPull checks the store itself and hands one that holds any of
// this user's rows to pullChanges, the same substitute its queued branch
// already runs.
//
// One interaction needed the push side: a parent edited before its splits
// landed. pullChanges skips a pending parent's splits, and the push used to
// replace the server's set with the local one, which is empty; the loop's
// unfiltered split read had happened to save them on the relaunch path. Since
// #97 the push replaces a pending parent's server splits only when a split row
// under it is pending or deleted, so that parent goes up alone and the pull
// after the push brings its splits down. A test below pins it.
//
// Own file: `lastError` in lib/syncStatus.ts and `_syncInProgress` in
// lib/sync.ts are module state shared by every test in a file, and initialPull
// holds the lock, so each test starts from a cleared error, awaits everything
// it starts, and afterEach asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  initialPull,
  needsInitialPull,
  pullChanges,
  pushChanges,
  resetLocalData,
  startSyncSession,
} from '../sync';
import { supabase } from '../supabase';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import { statusLabel } from '../syncStatusHelpers';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  type SupabaseOpts,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** A device's last complete pull, before the reset in the narrow-path test. */
const T0 = '2026-06-15T00:00:00Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
  // The populated path warns by design, and so does every injected failure.
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

const lastError = () => getSyncSnapshot().lastError;

const localIds = (table: string) =>
  ctx.adapter._sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((r: any) => r.id);

/** A parent's local splits as `id:_sync_status`, in id order. */
const localSplits = (txnId: string) =>
  ctx.adapter._sqlite
    .prepare(
      'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
    )
    .all(txnId)
    .map((r: any) => `${r.id}:${r._sync_status}`);

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s) => s.transaction_id === txnId)
    .map((s) => s.id)
    .sort();

/**
 * t1's split set before any re-split, as fresh objects every call: the fake
 * server mutates the rows and arrays it is handed.
 */
const oldSplits = () => [
  { id: 's1', transaction_id: 't1', amount: -5, memo: null },
  { id: 's2', transaction_id: 't1', amount: -5, memo: null },
];

/** The set a re-split replaces them with: new ids, -3 and -7. */
const newSplits = () => [
  { id: 's3', transaction_id: 't1', amount: -3, memo: null },
  { id: 's4', transaction_id: 't1', amount: -7, memo: null },
];

/**
 * The splits a re-split writes locally (lib/transactionUpdate.ts): new ids,
 * stamped with the edit's time, 'pending' until a push uploads them. The
 * caller puts the parent in the same state.
 */
async function insertPendingResplit(txnId: string, now: string) {
  for (const s of newSplits()) {
    await insertLocalSplit(ctx.adapter, {
      ...s,
      transaction_id: txnId,
      updated_at: now,
      _sync_status: 'pending',
    });
  }
}

/**
 * Takes the session away just before the first page request on `table`, by
 * flipping `anonScoped` on the options object the fake was installed with,
 * which it reads on every request (syncSession.test.ts's flipAnonBeforePage,
 * at page 0). Every read before that page is answered as the user.
 */
function loseSessionAtFirstRead(remote: SupabaseOpts, table: string) {
  const realFrom = (supabase as any).from;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t === table) {
      const realRange = builder.range;
      builder.range = (from: number, to: number) => {
        remote.anonScoped = true;
        return realRange(from, to);
      };
    }
    return builder;
  };
}

describe("initialPull over a store that already holds this user's rows runs pullChanges (#96)", () => {
  it('P9-A: a split edit not yet pushed is uploaded alone when the bootstrap finds the store populated', async () => {
    // The user re-split t1 and the app closed before the push landed. No local
    // account or rule, on purpose: the transaction alone must make the store
    // count as populated.
    const now = new Date().toISOString();
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      amount: -10,
      updated_at: now,
      _sync_status: 'pending',
    });
    await insertPendingResplit('t1', now);
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = oldSplits();

    await initialPull('u');

    // Before #96 the loop inserted the server's s1 and s2 beside the pending
    // s3 and s4,
    expect(localSplits('t1')).toEqual(['s3:pending', 's4:pending']);

    // and the push, which sends every local split of a pending parent, left
    // the server holding both sets: -10 split into -20.
    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('P9-B: a re-split made on another device replaces the old splits', async () => {
    // This device holds t1 and its old splits, synced. Another device has
    // since re-split t1: a newer updated_at, and new split ids.
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1', amount: -10 });
    for (const s of oldSplits()) {
      await insertLocalSplit(ctx.adapter, s);
    }
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [
      remoteTxn({ id: 't1', amount: -10, updated_at: '2026-02-01T00:00:00Z' }),
    ];
    ctx.store.transaction_splits = newSplits();

    await initialPull('u');

    // The loop never deletes a stale synced split, so before #96 s1 and s2
    // stayed beside the server's s3 and s4.
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('P9-C: a transaction deleted on another device is deleted', async () => {
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1', amount: -10 });
    await insertLocalTxn(ctx.adapter, { id: 't2', amount: -99 });
    await insertLocalSplit(ctx.adapter, {
      id: 's9',
      transaction_id: 't2',
      amount: -99,
    });
    // Another device deleted t2: a tombstone, i.e. an UPDATE that stamped
    // deleted_at and, through the trigger, a newer updated_at. Its split stays
    // on the server; splits ride their parent until the purge.
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [
      remoteTxn({ id: 't1', amount: -10 }),
      remoteTxn({
        id: 't2',
        amount: -99,
        updated_at: '2026-02-01T00:00:00+00:00',
        deleted_at: '2026-02-01T00:00:00+00:00',
      }),
    ];
    ctx.store.transaction_splits = [
      { id: 's9', transaction_id: 't2', amount: -99, memo: null },
    ];

    await initialPull('u');

    // The loop reads live rows only, so before #96 it never saw the tombstone,
    // and it banked both transaction keys past it: t2 stayed until the daily
    // reconcile.
    expect(localIds('transactions')).toEqual(['t1']);
    expect(localSplits('t2')).toEqual([]);
  });

  it('the narrow path end to end: a reset whose split download threw, a local re-split, then a healthy relaunch', async () => {
    // sync_meta is a SQLite table in production, and the wipe deletes this
    // user's keys from it; the fixture's Map would never see that. This device
    // last synced at T0.
    const metaTable = wireSqliteSyncMeta(ctx.adapter);
    for (const key of [
      'last_pull_at',
      'last_pull_attempt_at',
      'last_txn_pull_at',
      'last_txn_reconcile_at',
    ]) {
      metaTable.set(`${key}:u`, T0);
    }
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = oldSplits();
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });

    // Past the wipe, the download lands a1 and t1 and then throws on t1's
    // splits: both pull keys stay unset over a store that is no longer empty.
    // (The reconcile ran before the split read and banked its own key, so the
    // relaunch below does not repeat it.)
    let err: unknown = null;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/Failed to download splits/);
    expect(await needsInitialPull('u')).toBe(true);
    expect(localIds('transactions')).toEqual(['t1']);
    expect(localSplits('t1')).toEqual([]);

    // Before the relaunch, the user re-splits t1 here (as
    // lib/transactionUpdate.ts does: parent pending, splits replaced).
    const now = new Date().toISOString();
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(now);
    ctx.adapter._sqlite
      .prepare("DELETE FROM transaction_splits WHERE transaction_id = 't1'")
      .run();
    await insertPendingResplit('t1', now);

    // The relaunch, with the network back. needsInitialPull sends it to
    // initialPull. Before #96 its loop inserted s1 and s2 beside the pending
    // s3 and s4, and startSyncSession's fullSync then uploaded all four.
    ctx.installSupabase();
    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(await needsInitialPull('u')).toBe(false);
  });

  // Depends on #95, whose session guard makes this path. A first bootstrap
  // whose session goes away mid-download fails the read it was in (an empty
  // page it cannot vouch for) after streaming some pages, and the fullSync
  // after it is refused and stamps neither key: a populated store with both
  // pull keys unset, which the next signed launch bootstraps again. The #95
  // review drove that to a duplicate split set (its probe C, server splits
  // [s1, s9]); here the session goes at t1's split read. The same mechanism as
  // the reset test above, with a first bootstrap as the download that failed.
  it('a bootstrap that lost its session mid-download, then a re-split, then a signed relaunch uploads the re-split alone', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -10, memo: null },
    ];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    loseSessionAtFirstRead(remote, 'transaction_splits');

    await startSyncSession('u');

    // a1 and t1 landed before the session went. The bootstrap threw at the
    // split read, and the fullSync after it was refused: nothing is stamped.
    expect(lastError()).toMatch(/^Couldn't renew your sign-in/);
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBeUndefined();
    expect(await needsInitialPull('u')).toBe(true);
    expect(localIds('transactions')).toEqual(['t1']);
    expect(localSplits('t1')).toEqual([]);

    // Before any sync succeeds, the user re-splits t1 into s9 (as
    // lib/transactionUpdate.ts does: parent pending, splits replaced).
    const now = new Date().toISOString();
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(now);
    ctx.adapter._sqlite
      .prepare("DELETE FROM transaction_splits WHERE transaction_id = 't1'")
      .run();
    await insertLocalSplit(ctx.adapter, {
      id: 's9',
      transaction_id: 't1',
      amount: -10,
      updated_at: now,
      _sync_status: 'pending',
    });

    // The signed relaunch. Before #96 its loop inserted s1 beside the pending
    // s9, and the fullSync after it uploaded both: -20 on a -10 transaction.
    ctx.installSupabase();
    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s9']);
    expect(localSplits('t1')).toEqual(['s9:synced']);
  });

  // The review of #104 found this path. Before #97 the push deleted t1's
  // server splits and uploaded none, and this test pinned that ([]). #97's
  // push-side guard (replace a pending parent's server splits only when a
  // split row under it is pending or deleted) uploads t1 alone instead.
  it("a parent edited before its splits landed keeps its server splits, and the relaunch's full sync brings them here", async () => {
    const metaTable = wireSqliteSyncMeta(ctx.adapter);
    for (const key of [
      'last_pull_at',
      'last_pull_attempt_at',
      'last_txn_pull_at',
      'last_txn_reconcile_at',
    ]) {
      metaTable.set(`${key}:u`, T0);
    }
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = oldSplits();
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });

    // As above: past the wipe, the download lands a1 and t1 and then throws
    // on t1's splits.
    let err: unknown = null;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/Failed to download splits/);
    expect(await needsInitialPull('u')).toBe(true);
    expect(localSplits('t1')).toEqual([]);

    // Before the relaunch, the user edits t1's payee: an update with no
    // `splits` (lib/transactionUpdate.ts), so the parent goes pending with
    // still no split under it.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET payee = 'Edited', updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(new Date().toISOString());
    // Both are still on the server here.
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);

    // The relaunch runs pullChanges over the populated store, and its split
    // refresh skips the pending t1, so s1 and s2 do not land here yet. The
    // push in startSyncSession's fullSync uploads t1 alone and the server
    // keeps its splits; the pull after that push lists t1, synced by then,
    // and brings them down. The fake stamps an update with `serverNow`, here
    // a minute past this device's clock, so the stamp lands after the pull's
    // cursor as the trigger's does in production. Without it the fake keeps
    // the edit's own, earlier stamp, and the pull would not list t1.
    ctx.installSupabase({
      serverNow: toPgTimestamp(new Date(Date.now() + 60_000).toISOString()),
    });
    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it('over a populated store a failed read is reported and the attempt recorded, as the queued substitute does', async () => {
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.installSupabase({ errorReadsOn: new Set(['recurring_rules']) });

    await initialPull('u');

    // pullChanges's report, in the words of every other pull. Before #96 the
    // loop threw instead: "initialPull recurring_rules failed: ...", with no
    // attempt recorded and the bootstrap still due.
    expect(lastError()).toMatch(/^Couldn't download recurring rules/);
    expect(statusLabel(getSyncSnapshot())).toBe('Sync error');
    // The attempt is recorded, so the next launch runs pullChanges again
    // rather than asking for another bootstrap,
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBeTruthy();
    expect(await needsInitialPull('u')).toBe(false);
    // and nothing claims a complete pull: none of the loop's stamps ran.
    expect(ctx.meta.get('last_pull_at:u')).toBeUndefined();
  });
});

describe('the bootstrap loop still runs where it was written to run', () => {
  it('control: an empty store still takes the bootstrap loop and records a completed reconcile', async () => {
    // No remote transactions at all, which is what tells the loop from its
    // substitute: initialPull stamps last_txn_reconcile_at from its snapshot
    // unconditionally, while pullChanges banks it only when the enumeration
    // returned rows (an empty read is never authoritative).
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];

    await initialPull('u');

    expect(localIds('accounts')).toEqual(['a1']);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeTruthy();
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBe(
      ctx.meta.get('last_pull_at:u')
    );
    expect(lastError()).toBeNull();
  });

  it("a store holding only another user's rows still bootstraps this one", async () => {
    // Another account signed in on this device. Its rows say nothing about
    // whether THIS user's store is empty.
    await insertLocalAccount(ctx.adapter, { id: 'b-acct', user_id: 'b' });
    await insertLocalTxn(ctx.adapter, {
      id: 'b-txn',
      user_id: 'b',
      account_id: 'b-acct',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];

    await initialPull('u');

    // The same discriminator as the control above: only the loop banks it.
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeTruthy();
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBe(
      ctx.meta.get('last_pull_at:u')
    );
    // And the other account's rows are left alone.
    expect(localIds('accounts')).toEqual(['a1', 'b-acct']);
    expect(localIds('transactions')).toEqual(['b-txn']);
  });
});

// #113: a row written DURING the download. The store check above runs once,
// before the first read, and the user can edit a transaction the loop has
// already landed. The loop used to insert every split it read whatever the
// parent's local status, so a re-split made in that window got the server's
// splits beside it, and the push, which uploads every live split of a parent
// carrying an unsynced one, sent both sets. Since #113 the loop takes the
// reconcile's shape: it filters the batch to parents still synced before its
// split read, reads again after it, and writes only under a parent still
// synced then. Unreachable in the app until a splits UI exists (#26).

/**
 * A re-split of `txnId` as lib/transactionUpdate.ts writes it, in one SQLite
 * transaction: the parent pending with the edit's stamp, the splits it holds
 * marked deleted, and s3 and s4 inserted pending. Synchronous, so it can run
 * inside a fake request.
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
    for (const s of newSplits()) {
      sql
        .prepare(
          "INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status) VALUES (?, ?, ?, ?, ?, 'pending')"
        )
        .run(s.id, txnId, s.amount, s.memo, now);
    }
  })();
}

/**
 * Runs `edit` once, right after the first `INSERT INTO transactions` the
 * engine runs: over the empty store these tests start from, that is the
 * loop's upsert of t1, which lands before the loop reads any split. The
 * engine writes through the adapter getDb hands it, so wrapping the adapter's
 * runAsync puts the edit between two of the engine's statements, where a
 * mutation hook's write can land.
 */
function afterFirstTransactionLands(edit: () => Promise<void>) {
  const realRun = ctx.adapter.runAsync;
  let fired = false;
  ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
    const result = await realRun(sql, params);
    if (!fired && /^\s*INSERT INTO transactions\b/.test(sql)) {
      fired = true;
      await edit();
    }
    return result;
  };
  return { fired: () => fired };
}

/**
 * Counts the page requests of every split read, and runs `edit`, if given,
 * inside the first one: after the loop's filter has let the batch through,
 * before that page's answer reaches the loop. The same wrap of `.range()`,
 * which every paged read ends in, as loseSessionAtFirstRead above.
 */
function watchSplitReads(edit?: () => void) {
  const realFrom = (supabase as any).from;
  let pages = 0;
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table === 'transaction_splits') {
      const realRange = builder.range;
      builder.range = (from: number, to: number) => {
        if (pages++ === 0) {
          edit?.();
        }
        return realRange(from, to);
      };
    }
    return builder;
  };
  return { pages: () => pages };
}

/** The loop ran to its end: it stamps all three keys from one snapshot. */
function expectLoopCompleted() {
  const stamp = ctx.meta.get('last_pull_at:u');
  expect(stamp).toBeTruthy();
  expect(ctx.meta.get('last_txn_pull_at:u')).toBe(stamp);
  expect(ctx.meta.get('last_txn_reconcile_at:u')).toBe(stamp);
}

describe('a transaction edited while the bootstrap is downloading keeps its own splits (#113)', () => {
  beforeEach(() => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', amount: -10 })];
    ctx.store.transaction_splits = oldSplits();
  });

  it('R2: a re-split made while the bootstrap is downloading is not doubled', async () => {
    const splitReads = watchSplitReads();
    const hook = afterFirstTransactionLands(async () => {
      resplitLocally('t1', new Date().toISOString());
    });

    await initialPull('u');

    expect(hook.fired()).toBe(true);
    expect(lastError()).toBeNull();
    expectLoopCompleted();
    // Before #113 the loop inserted the server's s1 and s2 beside the pending
    // s3 and s4,
    expect(localSplits('t1')).toEqual(['s3:pending', 's4:pending']);
    // and it does not even ask for them now: the filter before the read drops
    // a parent that is already pending, so a batch holding only t1 is never
    // read.
    expect(splitReads.pages()).toBe(0);

    // The push sends every live split of a parent that carries an unsynced
    // one, so before #113 it left all four on the server: -10 split into -20.
    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('R2b: a re-split landing while the split batch is being read is not doubled either', async () => {
    // A second parent in the same batch, untouched: only t1's splits may be
    // left out.
    ctx.store.transactions.push(remoteTxn({ id: 't2', amount: -99 }));
    ctx.store.transaction_splits.push({
      id: 's5',
      transaction_id: 't2',
      amount: -99,
      memo: null,
    });
    // t1 is still synced when the filter runs, so the batch is read, and the
    // re-split lands while that read is in flight.
    const splitReads = watchSplitReads(() =>
      resplitLocally('t1', new Date().toISOString())
    );

    await initialPull('u');

    expect(splitReads.pages()).toBeGreaterThan(0);
    expect(lastError()).toBeNull();
    expectLoopCompleted();
    // The page still carries s1 and s2. The filter before the read had
    // already passed t1, so only the re-read after it spares the re-split.
    expect(localSplits('t1')).toEqual(['s3:pending', 's4:pending']);
    expect(localSplits('t2')).toEqual(['s5:synced']);

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  // A pin, not a regression test. Before #113 this scenario already ended
  // well: the loop wrote s1 and s2 under the pending parent, and they match
  // the server. What it pins is the filter's cost and how it heals: a
  // transaction edited during the download without touching its splits is
  // left without them until the pull after its push brings them.
  it('R3 (pin): a status toggle made while downloading leaves the transaction without splits until the pull after its push', async () => {
    const hook = afterFirstTransactionLands(async () => {
      ctx.adapter._sqlite
        .prepare(
          "UPDATE transactions SET status = 'reconciled', updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
        )
        .run(new Date().toISOString());
    });

    await initialPull('u');

    expect(hook.fired()).toBe(true);
    expectLoopCompleted();
    // The cost: the filter skipped t1, so its splits are not here yet. This
    // is the one assertion that fails on the old loop, which wrote them.
    expect(localSplits('t1')).toEqual([]);

    // No split row under t1 is unsynced, so the push uploads t1 alone and the
    // server keeps its splits (#97). The server stamps the update, as its
    // trigger does, here a second past the cursor this bootstrap banked, so
    // the pull after the push lists t1.
    const cursor = ctx.meta.get('last_txn_pull_at:u') as string;
    ctx.installSupabase({
      serverNow: toPgTimestamp(
        new Date(Date.parse(cursor) + 1000).toISOString()
      ),
    });
    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(ctx.store.transactions.find((t) => t.id === 't1').status).toBe(
      'reconciled'
    );

    // How it heals: that pull lists t1, synced by then, and refreshes its
    // splits (pullTransactions, step 3).
    await pullChanges('u');

    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it('R4 (control): a download nobody touches lands every split', async () => {
    ctx.store.transactions.push(remoteTxn({ id: 't2', amount: -99 }));
    ctx.store.transaction_splits.push({
      id: 's3',
      transaction_id: 't2',
      amount: -99,
      memo: null,
    });

    await initialPull('u');

    expect(lastError()).toBeNull();
    expectLoopCompleted();
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(localSplits('t2')).toEqual(['s3:synced']);
  });
});

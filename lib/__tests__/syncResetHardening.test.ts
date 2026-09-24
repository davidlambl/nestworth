// Reset hardening (#97). Two ways "Reset & re-download from cloud" used to fail
// the user, both found by the adversarial review of #92:
//
//  - The count-to-wipe window. resetLocalData counts the user's unsynced rows,
//    round-trips the reachability probe (up to 30 s), and only then wipes.
//    Mutation hooks write straight to SQLite and are not gated by the lock, so
//    an edit landing in that window was wiped unpushed. The wipe now re-counts
//    as the first statement of its own transaction and refuses.
//  - Unsynced splits under a SYNCED parent. The guard counted them, but the
//    push uploads splits only for a pending parent, so no push could clear
//    them and the reset was refused forever. The push now adopts such a
//    parent, and a 'deleted' split is left out of the upload and dropped once
//    its parent is marked synced.
//
// And a third, found by the review of #96: a pending parent's splits were
// replaced on the server from whatever this device held, even when it held
// none (a download that never landed them) or a stale copy (another device
// re-split the parent since). The server's splits are now replaced only when
// this device changed them, which an edit shows by leaving an unsynced split
// row: applyTransactionUpdate marks the rows it replaces 'deleted'.
//
// Own file: these drive resetLocalData, which holds the lock, and module state
// (the lock, lastError) is shared by every test in a file; see
// syncDrainErrors.test.ts, which these helpers are copied from.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  fullSync,
  initialPull,
  needsInitialPull,
  pullChanges,
  pushChanges,
  requestPush,
  resetLocalData,
  startSyncSession,
} from '../sync';
import {
  getSyncSnapshot,
  refreshPendingCount,
  setLastError,
} from '../syncStatus';
import {
  ACCOUNT_COLS,
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';
import { applyTransactionEvent } from '../realtimeHandlers';
import { applyTransactionDelete } from '../transactionDelete';
import {
  applyTransactionUpdate,
  type UpdateTransactionInput,
} from '../transactionUpdate';

/** What the server's BEFORE UPDATE trigger stamps, in PostgREST's rendering. */
const SERVER_NOW = '2026-06-01T12:00:00+00:00';
/** When the rows below last synced: older than SERVER_NOW, so a restamp shows. */
const OLD = '2026-05-01T00:00:00Z';
/** A local edit made after that sync. */
const EDITED_AT = '2026-05-02T00:00:00Z';
/** A second local edit, landing while a push is in flight. */
const REDIRTIED_AT = '2026-05-03T00:00:00Z';
const NOW = '2026-01-01T00:00:00Z';
const T0 = '2026-06-15T00:00:00Z';
/** This device's last pull, before another device re-split t1. */
const CURSOR = '2026-05-10T00:00:00Z';
/** When another device re-split t1. */
const RESPLIT_AT = '2026-05-20T00:00:00Z';

// Every sync_meta key the engine keeps for a user; the wipe clears all four.
const META_KEYS = [
  'last_pull_at',
  'last_pull_attempt_at',
  'last_txn_pull_at',
  'last_txn_reconcile_at',
] as const;

// The reset's pre-wipe guard: what its own push left unsynced. Since #97 the
// wipe's re-count runs the same query, but only after the probe, so the first
// match is still the guard's.
const RESET_GUARD = /_sync_status IN \('pending','deleted'\)/;

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks({ serverNow: SERVER_NOW });
  setLastError(null);
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
  setLastError(null);
});

/**
 * What a mutation hook does while a sync holds the lock: a pending row written
 * straight to SQLite. Synchronous, and past the adapter, so it cannot re-enter
 * the hook that calls it.
 */
function insertPendingAccountSync(id: string) {
  ctx.adapter._sqlite
    .prepare(
      `INSERT INTO accounts (${ACCOUNT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      'u',
      `Account ${id}`,
      'checking',
      null,
      0,
      0,
      0,
      0,
      NOW,
      NOW,
      'pending'
    );
}

/**
 * Runs `fn` right after the first call of `method` whose SQL matches `match`
 * resolves: a known point inside the holder, with the lock held.
 */
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

/**
 * Runs `fn` just before the `nth` call of `method` whose SQL matches `match`.
 * For the wipe's re-count (the second count of a reset) that is a point inside
 * the wipe's transaction, after its BEGIN.
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

/**
 * Runs a reset that must fail, and returns its rejection as a string.
 * resetLocalData drains the queue in its finally, so everything queued during
 * it has run by the time this returns.
 */
async function failedReset(): Promise<string> {
  let err: unknown = null;
  try {
    await resetLocalData('u');
  } catch (e) {
    err = e;
  }
  // String(err), never rejects.toThrow(): better-sqlite3 binds its error class
  // per realm, and these suites share a worker.
  return String(err);
}

const states = (rows: unknown[]) =>
  (rows as { id: string; _sync_status: string }[]).map(
    (r) => `${r.id}:${r._sync_status}`
  );

const localAccounts = () =>
  states(
    ctx.adapter._sqlite
      .prepare('SELECT id, _sync_status FROM accounts ORDER BY id')
      .all()
  );

const localSplits = (txnId: string) =>
  states(
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
      )
      .all(txnId)
  );

const localTxnStatus = (id: string) =>
  (
    ctx.adapter._sqlite
      .prepare('SELECT _sync_status FROM transactions WHERE id = ?')
      .get(id) as { _sync_status: string } | undefined
  )?._sync_status ?? null;

const serverTxn = (id: string) =>
  ctx.store.transactions.find((r: any) => r.id === id);

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

type Status = 'synced' | 'pending' | 'deleted';

/**
 * t1 on the server with the splits named, and locally in `parent` state with
 * each local split in the state given. A pending row carries the time of the
 * local edit that made it pending; a synced one, the time it last synced.
 */
async function seedT1(
  parent: Status,
  serverSplits: string[],
  localSplitStates: Record<string, Status>
) {
  ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: OLD })];
  ctx.store.transaction_splits = serverSplits.map((id) => ({
    id,
    transaction_id: 't1',
    amount: -10,
    memo: null,
    updated_at: '2026-05-01T00:00:00+00:00',
  }));
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    updated_at: parent === 'synced' ? OLD : EDITED_AT,
    _sync_status: parent,
  });
  for (const [id, status] of Object.entries(localSplitStates)) {
    await insertLocalSplit(ctx.adapter, {
      id,
      transaction_id: 't1',
      amount: -10,
      updated_at: status === 'synced' ? OLD : EDITED_AT,
      _sync_status: status,
    });
  }
}

/**
 * A server clock a minute past this device's, for a trigger stamp that must
 * land after a pull began, as it does in production. The fixed SERVER_NOW is
 * older than any cursor a pull banks from the real clock: that is the
 * clock-skew case the split-guard comment at `splitsChanged` in pushChanges describes, in which the
 * next pull never lists the pushed parent.
 */
const serverClockAhead = () =>
  toPgTimestamp(new Date(Date.now() + 60_000).toISOString());

/** A split as the server holds it: stamped, in PostgREST's rendering. */
const serverSplit = (id: string) => ({
  id,
  transaction_id: 't1',
  amount: -5,
  memo: null,
  updated_at: '2026-05-01T00:00:00+00:00',
});

/**
 * What the transaction screen writes: applyTransactionUpdate, as
 * useUpdateTransaction calls it. The cast is for TxnDb's generic
 * getFirstAsync, which the fixture's adapter does not declare.
 */
async function edit(
  input: Omit<UpdateTransactionInput, 'accountId'>,
  splitIds: string[] = []
) {
  let n = 0;
  await applyTransactionUpdate(
    ctx.adapter as any,
    { accountId: 'a1', ...input },
    { now: EDITED_AT, newSplitId: () => splitIds[n++] }
  );
}

/**
 * The same write for a payee edit, synchronously and past the adapter, for a
 * hook that fires between two of a holder's statements (insertPendingAccountSync
 * explains why).
 */
function editPayeeSync(id: string) {
  ctx.adapter._sqlite
    .prepare(
      "UPDATE transactions SET payee = 'Edited', updated_at = ?, _sync_status = 'pending' WHERE id = ?"
    )
    .run(EDITED_AT, id);
}

describe("the reset's count-to-wipe window (#97)", () => {
  it("a row written between the guard's count and the wipe refuses the reset and is neither wiped nor re-downloaded over", async () => {
    const metaTable = wireSqliteSyncMeta(ctx.adapter);
    for (const k of META_KEYS) metaTable.set(`${k}:u`, T0);
    await insertLocalAccount(ctx.adapter, { id: 'a1', name: 'Local copy' });
    ctx.store.accounts = [
      remoteAccount({ id: 'a1', name: 'Server copy', updated_at: T0 }),
    ];
    // What a mutation hook does during the probe's round trip: the guard has
    // counted nothing unsynced, and the lock does not gate the write.
    const fired = afterFirst('getFirstAsync', RESET_GUARD, () =>
      insertPendingAccountSync('a-typed')
    );

    const err = await failedReset();

    expect(fired()).toBe(true);
    expect(err).toMatch(/Couldn't upload 1 unsynced change\(s\)/);
    expect(err).toMatch(/reset cancelled/);
    // Nothing was wiped: the typed row is still here and still queued, and the
    // synced one was not re-downloaded over.
    expect(localAccounts()).toEqual(['a-typed:pending', 'a1:synced']);
    const a1: any = ctx.adapter._sqlite
      .prepare('SELECT name FROM accounts WHERE id = ?')
      .get('a1');
    expect(a1.name).toBe('Local copy');
    for (const k of META_KEYS) expect(metaTable.get(`${k}:u`)).toBe(T0);
    expect(getSyncSnapshot().lastError).toBe(err.replace(/^Error: /, ''));
    expect(await needsInitialPull('u')).toBe(false);
  });
});

describe("the wipe's refusal keeps a write that joined its transaction (#97)", () => {
  it("a write that joins the wipe's transaction before its re-count is kept, and the reset refuses", async () => {
    const metaTable = wireSqliteSyncMeta(ctx.adapter);
    for (const k of META_KEYS) metaTable.set(`${k}:u`, T0);
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1', updated_at: T0 })];
    // withTransactionAsync is not exclusive: a hook's write landing between
    // the wipe's BEGIN and its re-count runs inside the wipe's transaction.
    const fired = beforeNth('getFirstAsync', RESET_GUARD, 2, () =>
      insertPendingAccountSync('a-joined')
    );

    const err = await failedReset();

    expect(fired()).toBe(true);
    expect(err).toMatch(/Couldn't upload 1 unsynced change\(s\)/);
    // The refusal commits instead of rolling back. Rolling back discarded the
    // very row the count had just reported as kept.
    expect(localAccounts()).toEqual(['a-joined:pending', 'a1:synced']);
    for (const k of META_KEYS) expect(metaTable.get(`${k}:u`)).toBe(T0);
    expect(getSyncSnapshot().lastError).toBe(err.replace(/^Error: /, ''));
  });
});

describe('unsynced splits under a synced parent (#97)', () => {
  it('a pending split under a synced parent is carried by the next push, and the reset then proceeds', async () => {
    await seedT1('synced', ['s1'], { s1: 'synced', s2: 'pending' });

    await pushChanges('u');

    // The parent went up again (the trigger restamped it) and took s2 along.
    expect(serverTxn('t1').updated_at).toBe(SERVER_NOW);
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);

    // Refused before #97: "Couldn't upload 1 unsynced change(s)", on every try.
    await resetLocalData('u');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it('a deleted split under a synced parent is removed from the server by the next push and dropped locally', async () => {
    // What an interrupted useDeleteTransaction left before #97: the splits
    // marked, the parent not.
    await seedT1('synced', ['s1', 's2'], { s1: 'synced', s2: 'deleted' });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1']);
    expect(serverTxn('t1').updated_at).toBe(SERVER_NOW);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual(['s1:synced']);

    await resetLocalData('u');
    expect(localSplits('t1')).toEqual(['s1:synced']);
  });

  it("adopts only this user's synced parents: a transaction deleted with its splits is tombstoned, and another account's orphan waits for that account's push", async () => {
    // Not a regression test (the engine passed it before #97): it pins the
    // adoption's `_sync_status = 'synced'` and `user_id = ?`, which the tests
    // above leave free. Without the first, the push re-queues every
    // transaction deleted with its splits as a live edit and resurrects it on
    // the server.
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: OLD }),
      remoteTxn({ id: 'tb', user_id: 'b', updated_at: OLD }),
    ];
    ctx.store.transaction_splits = ['s1', 's2', 'sb1'].map((id) => ({
      id,
      transaction_id: id === 'sb1' ? 'tb' : 't1',
      amount: -10,
      memo: null,
      updated_at: '2026-05-01T00:00:00+00:00',
    }));
    await insertLocalTxn(ctx.adapter, { id: 't1', updated_at: OLD });
    for (const id of ['s1', 's2']) {
      await insertLocalSplit(ctx.adapter, {
        id,
        transaction_id: 't1',
        updated_at: OLD,
      });
    }
    await applyTransactionDelete(ctx.adapter, 't1', { now: EDITED_AT });
    // b, signed in on this device earlier, left a pending split under a
    // synced parent.
    await insertLocalTxn(ctx.adapter, {
      id: 'tb',
      user_id: 'b',
      updated_at: OLD,
    });
    await insertLocalSplit(ctx.adapter, {
      id: 'sb1',
      transaction_id: 'tb',
      updated_at: OLD,
    });
    await insertLocalSplit(ctx.adapter, {
      id: 'sb2',
      transaction_id: 'tb',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect(serverTxn('t1').deleted_at).toEqual(expect.any(String));
    expect(serverSplitIds('t1')).toEqual([]);
    expect(localTxnStatus('t1')).toBeNull();
    expect(localSplits('t1')).toEqual([]);
    // b's push adopts it; u's neither touches nor uploads it.
    expect(localTxnStatus('tb')).toBe('synced');
    expect(localSplits('tb')).toEqual(['sb1:synced', 'sb2:pending']);
    expect(serverTxn('tb').updated_at).toBe(OLD);
    expect(serverSplitIds('tb')).toEqual(['sb1']);
  });
});

describe("a 'deleted' split in the push (#97)", () => {
  it('a deleted split under a pending parent never reaches the server and is dropped once the parent is synced', async () => {
    await seedT1('pending', ['s1', 's2'], { s1: 'pending', s2: 'deleted' });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1']);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual(['s1:synced']);
    await refreshPendingCount('u');
    expect(getSyncSnapshot().pendingCount).toBe(0);
    await resetLocalData('u');
  });

  it('the hard delete spares the deleted splits of a parent re-dirtied mid-push', async () => {
    await seedT1('pending', ['s1', 's2'], { s1: 'pending', s2: 'deleted' });
    // An edit to t1 landing while its upsert is in flight: mark-synced must
    // miss, and so must the delete that rides on it.
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      onAfterUpsert: async (table) => {
        if (table !== 'transactions') return;
        await ctx.adapter.runAsync(
          `UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          [REDIRTIED_AT, 't1']
        );
      },
    });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1']);
    expect(localTxnStatus('t1')).toBe('pending');
    // Left for the next push, which leaves it out of the upload again.
    expect(localSplits('t1')).toContain('s2:deleted');
  });
});

describe("a pending parent's splits are replaced only when this device changed them (#97)", () => {
  it("a parent whose splits never landed, edited offline after the reset's download failed, keeps the server's splits", async () => {
    const metaTable = wireSqliteSyncMeta(ctx.adapter);
    for (const k of META_KEYS) metaTable.set(`${k}:u`, T0);
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: OLD })];
    ctx.store.transaction_splits = [serverSplit('s1'), serverSplit('s2')];

    // The reset's download fails at the split read: t1 lands without them.
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      errorReadsOn: new Set(['transaction_splits']),
    });
    expect(await failedReset()).toMatch(/Failed to download splits/);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual([]);

    // Still offline: a foreground sync records an attempt, so the relaunch
    // syncs (push first) rather than bootstrapping, and the user renames t1.
    ctx.installSupabase({ offline: true });
    await fullSync('u');
    expect(await needsInitialPull('u')).toBe(false);
    await edit({ id: 't1', payee: 'Edited' });
    await requestPush('u');
    expect(localTxnStatus('t1')).toBe('pending');

    ctx.installSupabase({ serverNow: SERVER_NOW });
    await startSyncSession('u');

    // Replacing the server's set from this device's copy of it -- none --
    // deleted both splits everywhere.
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it("a parent a first bootstrap left without its splits, edited offline, keeps the server's splits through the relaunch", async () => {
    // The #104 review's R1-bootstrap shape. A first bootstrap lands a1 and t1
    // and then fails at the split read; the app closes before any other pull.
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: OLD })];
    ctx.store.transaction_splits = [serverSplit('s1'), serverSplit('s2')];
    ctx.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });
    await initialPull('u');
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual([]);
    expect(await needsInitialPull('u')).toBe(true);

    // Offline, the user renames t1; its push goes nowhere.
    ctx.installSupabase({ offline: true });
    await edit({ id: 't1', payee: 'Edited' });
    await requestPush('u');

    // The relaunch finds the store populated and pulls with pullChanges,
    // which skips the pending t1's splits (#96); its full sync then pushes t1
    // with none under it.
    ctx.installSupabase({ serverNow: serverClockAhead() });
    await startSyncSession('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it("a parent a killed bootstrap left without its splits, edited during the relaunch, keeps the server's splits", async () => {
    // The #104 review's R4 shape. What a bootstrap killed after the
    // transactions landed leaves: a1 and t1, t1's splits never read, no keys.
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1', updated_at: OLD });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: OLD })];
    ctx.store.transaction_splits = [serverSplit('s1'), serverSplit('s2')];
    expect(await needsInitialPull('u')).toBe(true);

    // The relaunch pulls with pullChanges over the populated store (#96). The
    // user renames t1 once it has landed; the edit's push queues behind the
    // pull, which then skips the pending t1's splits.
    ctx.installSupabase({ serverNow: serverClockAhead() });
    const fired = afterFirst('runAsync', /INSERT INTO transactions/, () => {
      editPayeeSync('t1');
      void requestPush('u');
    });
    await startSyncSession('u');

    expect(fired()).toBe(true);
    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it('a parent edited without touching its splits keeps the set another device gave it, and the next pull brings that set here', async () => {
    // This device holds t1 with s1, s2 as of its last pull, at CURSOR.
    await seedT1('synced', [], { s1: 'synced', s2: 'synced' });
    for (const k of [
      'last_pull_at',
      'last_pull_attempt_at',
      'last_txn_pull_at',
    ]) {
      ctx.meta.set(`${k}:u`, CURSOR);
    }
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    // Another device has re-split t1 since.
    ctx.store.transactions = [remoteTxn({ id: 't1', updated_at: RESPLIT_AT })];
    ctx.store.transaction_splits = [serverSplit('s3'), serverSplit('s4')];
    await edit({ id: 't1', payee: 'Edited' });

    await pushChanges('u');

    // Replacing the set would have put this device's stale s1, s2 back.
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(serverTxn('t1').updated_at).toBe(SERVER_NOW);
    expect(localTxnStatus('t1')).toBe('synced');

    // The push moved t1 past the cursor, so the next pull refreshes its splits.
    await pullChanges('u');
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("a parent realtime delivered without its splits, edited before the next pull, keeps the server's splits", async () => {
    // A synced device. Another device posts a transaction that carries splits
    // (a legacy recurring template), and realtime delivers the parent here:
    // applyTransactionEvent writes the parent only, splits wait for a pull
    // (#21). The user edits it before that pull.
    for (const k of [
      'last_pull_at',
      'last_pull_attempt_at',
      'last_txn_pull_at',
    ]) {
      ctx.meta.set(`${k}:u`, CURSOR);
    }
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    const posted = remoteTxn({ id: 't1', updated_at: RESPLIT_AT });
    ctx.store.transactions = [posted];
    ctx.store.transaction_splits = [serverSplit('s1'), serverSplit('s2')];
    await applyTransactionEvent(ctx.adapter, {
      eventType: 'INSERT',
      new: { ...posted },
    });
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual([]);
    await edit({ id: 't1', payee: 'Edited' });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(serverTxn('t1').payee).toBe('Edited');

    await pullChanges('u');
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
  });

  it("a re-split still replaces the server's set and leaves no deleted row behind", async () => {
    // A pin, not a regression test: the push replaced every pending parent's
    // set before, so this passed then. It fails if the rule is inverted.
    await seedT1('synced', ['s1', 's2'], { s1: 'synced', s2: 'synced' });
    await edit(
      {
        id: 't1',
        splits: [
          { amount: -3, memo: null },
          { amount: -7, memo: null },
        ],
      },
      ['s3', 's4']
    );

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('removing every split empties the server set too', async () => {
    // Also a pin: it passed before, because the push replaced every pending
    // parent's set. Now it depends on applyTransactionUpdate marking the
    // removed rows 'deleted' rather than deleting them, since a parent with no
    // unsynced split row is uploaded alone.
    await seedT1('synced', ['s1', 's2'], { s1: 'synced', s2: 'synced' });
    await edit({ id: 't1', splits: [] });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual([]);
    expect(localTxnStatus('t1')).toBe('synced');
    expect(localSplits('t1')).toEqual([]);
  });
});

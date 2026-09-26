// The order of the local hard deletes of a transaction and its splits (#137).
//
// Three paths remove a transaction row and its splits with two plain
// statements, outside any transaction: the tombstone consumer
// (deleteLocalTransactionIfSynced, run by the pull's step 1, by realtime and
// by the reconcile's absence-deletes), the push's read-back drop (a pending
// row whose upsert landed on a tombstone, or was refused as purged) and the
// push's deleted-transactions batch. Each deleted the PARENT first. The app
// killed between the two statements, or the second one throwing, left the
// splits with no parent: invisible (every split read is keyed on a loaded
// parent), never pushed, never counted by the reset guard and never wiped.
// Nothing ever found them again.
//
// Each path now deletes the splits FIRST, under the parent's own predicate,
// and the parent second. The same interruption leaves a parent without its
// splits, which is still what its delete matches, so the next pass finishes
// the job: the next pull, or at the latest the daily reconcile, for the
// tombstone consumer; the next push for the other two.
//
// Splits first opens one window of its own, at the tombstone consumer only:
// between its two DELETEs the parent is still synced, so a server split a
// sync writes for it right then is let in, and the parent DELETE would leave
// it with no parent. The consumer's third statement deletes it (the last
// describe).
//
// A kill is modelled as a throw just before the pair's SECOND statement.
// PAIR_DELETE matches both statements of each pair (a split DELETE and a
// parent DELETE both start with it) and nothing these one-row seeds reach
// before them: step 3, the #112 refresh and the reconcile run after the pair,
// pushTable's DELETEs start with another table, and the adoption is an
// UPDATE. Every test asserts that the hook fired.
//
// Each test was run against the code before #137: the comment above each
// `it` says what that run left behind. Rejections are compared as strings,
// never with rejects.toThrow(): the better-sqlite3 error class is bound per
// realm (sync-engine.md).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyAccountDelete } from '../accountDelete';
import { applyTransactionEvent } from '../realtimeHandlers';
import { pullChanges, pushChanges } from '../sync';
import { applyTransactionDelete } from '../transactionDelete';
import { applyTransactionUpdate } from '../transactionUpdate';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When t1 and its splits last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** The pull cursor: after t1 last synced, before it was deleted elsewhere. */
const CURSOR = '2026-05-11T00:00:00Z';
/** A cursor past the tombstone, as a device whose clock runs ahead has one. */
const CURSOR_AHEAD = '2026-06-02T00:00:00Z';
/** When another device deleted t1: the stamp its tombstone carries. */
const DELETED_AT = '2026-06-01T00:00:00+00:00';
/** The stamp this device's own writes carry (an edit, a delete). */
const EDITED_AT = '2026-09-25T12:00:00.000Z';
/** A reconcile key older than a day: the next pull reconciles. */
const RECONCILE_DUE = '2026-01-01T00:00:00Z';

/** Both statements of each pair, and nothing else these seeds reach first. */
const PAIR_DELETE = /^DELETE FROM transaction/;

let ctx: ReturnType<typeof wireSyncMocks>;
let meta: ReturnType<typeof wireSqliteSyncMeta>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
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
 * attached at once.
 */
function rejection(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e) => String(e)
  );
}

/**
 * Runs `fn`, and waits for it, just before the `nth` call of `method` whose
 * SQL matches `match`. Installed on the adapter itself, which the engine
 * reaches by reference through the mocked getDb.
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

/** The app killed just before the pair's second statement. */
const killBeforeSecondDelete = () =>
  beforeNth('runAsync', PAIR_DELETE, 2, async () => {
    throw new Error('killed');
  });

/**
 * Account a1 and transaction t1 (-10) with splits s1 and s2 (-5 each), synced:
 * on the server and here. `local` overrides t1's local row.
 */
async function seedT1(local: Record<string, unknown> = {}) {
  ctx.store.accounts = [remoteAccount({ id: 'a1' })];
  await insertLocalAccount(ctx.adapter, { id: 'a1' });
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
    ...local,
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

/** Another device deleted t1: its server row now carries the tombstone. */
function deleteT1Elsewhere() {
  Object.assign(ctx.store.transactions[0], {
    deleted_at: DELETED_AT,
    updated_at: DELETED_AT,
  });
}

/** The pull keys of a device that last pulled at `cursor`. */
function pulledAt(cursor: string, reconciledAt: string) {
  for (const k of [
    'last_pull_at',
    'last_pull_attempt_at',
    'last_txn_pull_at',
  ]) {
    meta.set(`${k}:u`, cursor);
  }
  meta.set('last_txn_reconcile_at:u', reconciledAt);
}

/** `status@updated_at` of a local transaction, or null once it is gone. */
function localTxn(id: string): string | null {
  const row = ctx.adapter._sqlite
    .prepare('SELECT _sync_status, updated_at FROM transactions WHERE id = ?')
    .get(id) as { _sync_status: string; updated_at: string } | undefined;
  return row ? `${row._sync_status}@${row.updated_at}` : null;
}

/** `id@transaction_id:status` for EVERY local split, so an orphan shows. */
function allSplits(): string[] {
  return (
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, transaction_id, _sync_status FROM transaction_splits ORDER BY id'
      )
      .all() as { id: string; transaction_id: string; _sync_status: string }[]
  ).map((r) => `${r.id}@${r.transaction_id}:${r._sync_status}`);
}

/** The tombstone stamp on the server's copy of a transaction, or null. */
const serverDeletedAt = (id: string): string | null =>
  ctx.store.transactions.find((t: any) => t.id === id)?.deleted_at ?? null;

/** The ids of the server's splits of `txnId`, sorted. */
const serverSplits = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

/** A field edit from the transaction screen: applyTransactionUpdate. */
function editPayee(id: string) {
  return applyTransactionUpdate(
    ctx.adapter as any,
    { id, accountId: 'a1', payee: 'Edited' },
    { now: EDITED_AT, newSplitId: () => 'unused' }
  );
}

describe("the tombstone consumer (deleteLocalTransactionIfSynced) deletes a parent's splits before the parent (#137)", () => {
  // Before #137: the pull rejected with t1 gone and s1 and s2 left behind,
  // synced and parentless, and the next pull, finding no t1 to delete, left
  // them there for good.
  it('K1: the pull killed between the two DELETEs leaves t1 synced without splits and its cursor unmoved, and the next pull deletes t1', async () => {
    await seedT1();
    pulledAt(CURSOR, new Date().toISOString());
    deleteT1Elsewhere();
    const fired = killBeforeSecondDelete();

    const err = await rejection(pullChanges('u'));
    const afterKill = {
      t1: localTxn('t1'),
      splits: allSplits(),
      cursor: meta.get('last_txn_pull_at:u'),
      attempt: meta.get('last_pull_attempt_at:u'),
    };
    const ok = await pullChanges('u');

    expect(fired()).toBe(true);
    expect({
      err,
      afterKill,
      ok,
      afterNextPull: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      err: 'Error: killed',
      afterKill: {
        t1: `synced@${SYNCED_AT}`,
        splits: [],
        cursor: CURSOR,
        attempt: CURSOR,
      },
      ok: true,
      afterNextPull: { t1: null, splits: [] },
    });
  });

  // Before #137: the event rejected with t1 gone and s1 and s2 orphaned, and
  // neither step 1 nor the reconcile of the next pull touched them.
  it('K1r: realtime killed between the two DELETEs leaves t1 synced without splits, and the next pull deletes t1', async () => {
    await seedT1();
    pulledAt(CURSOR, RECONCILE_DUE);
    deleteT1Elsewhere();
    const fired = killBeforeSecondDelete();

    const err = await rejection(
      applyTransactionEvent(ctx.adapter, {
        eventType: 'UPDATE',
        new: { ...ctx.store.transactions[0] },
        old: { id: 't1' },
      })
    );
    const afterKill = { t1: localTxn('t1'), splits: allSplits() };
    const ok = await pullChanges('u');

    expect(fired()).toBe(true);
    expect({
      err,
      afterKill,
      ok,
      afterPull: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      err: 'Error: killed',
      afterKill: { t1: `synced@${SYNCED_AT}`, splits: [] },
      ok: true,
      afterPull: { t1: null, splits: [] },
    });
  });

  // The same, with the cursor already past the tombstone's stamp, as a device
  // whose clock runs ahead of the server's has it (CONTRIBUTING, Sync Engine):
  // step 1 no longer lists the tombstone, so t1 waits for the daily
  // reconcile, which finds it absent from the server's live rows. Before
  // #137: t1 gone and s1 and s2 orphaned through both pulls.
  it('K1s: under a cursor past the tombstone the incremental pull leaves the split-less t1, and the daily reconcile deletes it', async () => {
    await seedT1();
    pulledAt(CURSOR_AHEAD, new Date().toISOString());
    deleteT1Elsewhere();
    const fired = killBeforeSecondDelete();

    const err = await rejection(
      applyTransactionEvent(ctx.adapter, {
        eventType: 'UPDATE',
        new: { ...ctx.store.transactions[0] },
        old: { id: 't1' },
      })
    );
    const incremental = await pullChanges('u');
    const afterIncremental = { t1: localTxn('t1'), splits: allSplits() };
    meta.set('last_txn_reconcile_at:u', RECONCILE_DUE);
    const reconciled = await pullChanges('u');

    expect(fired()).toBe(true);
    expect({
      err,
      incremental,
      afterIncremental,
      reconciled,
      afterReconcile: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      err: 'Error: killed',
      incremental: true,
      afterIncremental: { t1: `synced@${SYNCED_AT}`, splits: [] },
      reconciled: true,
      afterReconcile: { t1: null, splits: [] },
    });
  });

  // A pin of the window the reorder opens, not a regression. Before #137 the
  // edit landed after the parent DELETE, matched nothing and was refused
  // ("This transaction no longer exists on this device…"), and the push had
  // nothing to do. Now it lands after the split DELETE, while t1 is still
  // synced, and is accepted: t1 goes pending without its splits, and the
  // next push's upsert lands on the tombstone and drops it, as delete wins
  // over any edit. Both end with t1 gone here and dead on the server; nothing
  // is lost that delete-wins would have kept.
  it('W1 (pin of the trade): an edit landing between the two DELETEs is accepted, and the next push drops it under delete-wins', async () => {
    await seedT1();
    pulledAt(CURSOR, new Date().toISOString());
    deleteT1Elsewhere();
    let editErr: string | null | undefined;
    const fired = beforeNth('runAsync', PAIR_DELETE, 2, async () => {
      editErr = await rejection(editPayee('t1'));
    });

    const ok = await pullChanges('u');
    const afterPull = { t1: localTxn('t1'), splits: allSplits() };
    const pushErr = await rejection(pushChanges('u'));

    expect(fired()).toBe(true);
    expect({
      editErr,
      ok,
      afterPull,
      pushErr,
      afterPush: {
        t1: localTxn('t1'),
        splits: allSplits(),
        serverDeletedAt: serverDeletedAt('t1'),
      },
    }).toEqual({
      editErr: null,
      ok: true,
      afterPull: { t1: `pending@${EDITED_AT}`, splits: [] },
      pushErr: null,
      afterPush: { t1: null, splits: [], serverDeletedAt: DELETED_AT },
    });
  });
});

describe("the push's read-back drop deletes a parent's splits before the parent (#137)", () => {
  // Before #137: the push rejected with t1 gone and s1 and s2 orphaned, and
  // the next push, with no pending t1 left, had nothing to do.
  it('K2: killed between the two DELETEs, it leaves t1 pending at its own stamp without splits, and the next push drops it', async () => {
    await seedT1({
      payee: 'Edited',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });
    deleteT1Elsewhere();
    const fired = killBeforeSecondDelete();

    const err = await rejection(pushChanges('u'));
    const afterKill = { t1: localTxn('t1'), splits: allSplits() };
    const err2 = await rejection(pushChanges('u'));

    expect(fired()).toBe(true);
    expect({
      err,
      afterKill,
      err2,
      afterNextPush: {
        t1: localTxn('t1'),
        splits: allSplits(),
        serverDeletedAt: serverDeletedAt('t1'),
      },
    }).toEqual({
      err: 'Error: killed',
      afterKill: { t1: `pending@${EDITED_AT}`, splits: [] },
      err2: null,
      afterNextPush: { t1: null, splits: [], serverDeletedAt: DELETED_AT },
    });
  });
});

describe("the push's deleted-transactions batch deletes a parent's splits before the parent (#137)", () => {
  // Before #137: the push rejected with t1 gone and s1 and s2 left behind as
  // 'deleted' rows with no parent, which the next push never looked at.
  it('K3: after a transaction delete, killed between the two DELETEs, it leaves t1 deleted without splits, and the next push deletes it', async () => {
    await seedT1();
    await applyTransactionDelete(ctx.adapter, 't1', { now: EDITED_AT });
    const fired = killBeforeSecondDelete();

    const err = await rejection(pushChanges('u'));
    const afterKill = {
      t1: localTxn('t1'),
      splits: allSplits(),
      serverTombstoned: serverDeletedAt('t1') != null,
      serverSplits: serverSplits('t1'),
    };
    const err2 = await rejection(pushChanges('u'));

    expect(fired()).toBe(true);
    expect({
      err,
      afterKill,
      err2,
      afterNextPush: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      err: 'Error: killed',
      afterKill: {
        t1: `deleted@${EDITED_AT}`,
        splits: [],
        serverTombstoned: true,
        serverSplits: [],
      },
      err2: null,
      afterNextPush: { t1: null, splits: [] },
    });
  });

  // An account delete marks its transactions deleted and leaves their splits
  // alone (lib/accountDelete.ts), so the batch meets them still 'synced'.
  // Before #137: t1 gone and s1 and s2 left as SYNCED orphans.
  it('K3a: after an account delete, killed between the two DELETEs, it leaves t1 deleted without splits, and the next push deletes it', async () => {
    await seedT1();
    await applyAccountDelete(ctx.adapter, 'a1', { now: EDITED_AT });
    const fired = killBeforeSecondDelete();

    const err = await rejection(pushChanges('u'));
    const afterKill = {
      t1: localTxn('t1'),
      splits: allSplits(),
      serverTombstoned: serverDeletedAt('t1') != null,
      serverSplits: serverSplits('t1'),
    };
    const err2 = await rejection(pushChanges('u'));

    expect(fired()).toBe(true);
    expect({
      err,
      afterKill,
      err2,
      afterNextPush: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      err: 'Error: killed',
      afterKill: {
        t1: `deleted@${EDITED_AT}`,
        splits: [],
        serverTombstoned: true,
        serverSplits: [],
      },
      err2: null,
      afterNextPush: { t1: null, splits: [] },
    });
  });
});

describe('the tombstone consumer deletes a server split a sync wrote between its two DELETEs (#137 review)', () => {
  // Between the consumer's split DELETE and its parent DELETE the parent is
  // still synced, so upsertRemoteSplit's guard lets in a server split that a
  // sync holding the lock writes for it right then, and the parent DELETE
  // left that split with no parent, as #125's race did before #134. Realtime's
  // consumer is not lock-gated, so it runs beside every writer of server
  // splits: step 3, the reconcile's refresh and the refresh after a push
  // (#112), driven here, and the first-login download, which writes through
  // the same guarded INSERT. The consumer's third statement, run once the
  // parent is gone, deletes it.
  //
  // Red on this PR's first head (splits first, no third statement): t1 gone
  // and s5 left synced with no parent, through the next pull and its
  // reconcile. Green on main, for another reason: its consumer deletes the
  // parent first, so the guard refuses the INSERT. So these pin this PR's own
  // window, not a regression of main.

  /** The pull cursor these seeds share. */
  const RACE_CURSOR = '2026-06-15T00:00:00Z';
  /** When this device last pulled t1 and its splits. */
  const PULLED_AT = '2026-06-01T00:00:00Z';
  /** When another device deletes t1, during the sync. */
  const RACE_TOMBSTONE = '2026-06-20T00:00:00+00:00';

  /** A server split of t1. */
  const serverSplit = (id: string) => ({
    id,
    transaction_id: 't1',
    amount: -5,
    memo: null,
    updated_at: toPgTimestamp(PULLED_AT),
  });

  /** t1 as this device pulled it, synced, with s1 and s2. */
  async function pulledT1(fields: Record<string, unknown> = {}) {
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      updated_at: PULLED_AT,
      ...fields,
    });
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
   * Another device deletes t1 while the sync writes t1's server splits. At
   * the sync's first split INSERT the server row is tombstoned and realtime's
   * consumer starts beside the sync, through a handle of its own so that its
   * statements can be held apart from the sync's: its first statement runs,
   * then the sync's INSERT, then the rest of the consumer. Two chains of
   * awaited statements on one connection interleave that way once they
   * overlap.
   */
  function tombstoneAtFirstSplitInsert(): () => boolean {
    const real = ctx.adapter.runAsync.bind(ctx.adapter) as (
      sql: string,
      params?: any[]
    ) => Promise<any>;
    let fired = false;
    (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
      if (fired || !/^INSERT INTO transaction_splits/.test(sql)) {
        return real(sql, params);
      }
      fired = true;
      Object.assign(ctx.store.transactions[0], {
        deleted_at: RACE_TOMBSTONE,
        updated_at: RACE_TOMBSTONE,
      });
      let atSecond!: () => void;
      const reachedSecond = new Promise<void>((r) => {
        atSecond = r;
      });
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let n = 0;
      const realtimeDb = {
        runAsync: async (s: string, p: any[] = []) => {
          if (++n === 2) {
            atSecond();
            await released;
          }
          return real(s, p);
        },
      };
      const consumer = applyTransactionEvent(realtimeDb, {
        eventType: 'UPDATE',
        new: { ...ctx.store.transactions[0] },
        old: { id: 't1' },
      });
      consumer.then(atSecond, atSecond);
      await reachedSecond;
      const out = await real(sql, params);
      release();
      await consumer;
      return out;
    };
    return () => fired;
  }

  /** The next pull, with the reconcile due: it lists the tombstone too. */
  async function theNextPull() {
    meta.set('last_txn_reconcile_at:u', RECONCILE_DUE);
    return pullChanges('u');
  }

  it("R1: step 3's split write, met by realtime's tombstone of t1, leaves no split behind", async () => {
    pulledAt(RACE_CURSOR, new Date().toISOString());
    await pulledT1();
    ctx.store.transactions = [
      remoteTxn({
        id: 't1',
        updated_at: '2026-06-16T00:00:00+00:00',
        payee: 'Newer',
      }),
    ];
    ctx.store.transaction_splits = [serverSplit('s5'), serverSplit('s6')];
    const fired = tombstoneAtFirstSplitInsert();

    const ok = await pullChanges('u');
    const afterRace = { t1: localTxn('t1'), splits: allSplits() };
    const next = await theNextPull();

    expect(fired()).toBe(true);
    expect({
      ok,
      afterRace,
      next,
      afterNextPull: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      ok: true,
      afterRace: { t1: null, splits: [] },
      next: true,
      afterNextPull: { t1: null, splits: [] },
    });
  });

  it("R2: the reconcile refresh's split write, met by realtime's tombstone of t1, leaves no split behind", async () => {
    pulledAt(RACE_CURSOR, RECONCILE_DUE);
    // A correction stamped older than the cursor: only the reconcile sees it.
    await pulledT1({ updated_at: '2026-03-01T00:00:00Z', payee: 'Stale' });
    ctx.store.transactions = [
      remoteTxn({
        id: 't1',
        updated_at: '2026-02-01T00:00:00Z',
        payee: 'Fixed',
      }),
    ];
    ctx.store.transaction_splits = [serverSplit('s5'), serverSplit('s6')];
    const fired = tombstoneAtFirstSplitInsert();

    const ok = await pullChanges('u');
    const afterRace = { t1: localTxn('t1'), splits: allSplits() };
    const next = await theNextPull();

    expect(fired()).toBe(true);
    expect({
      ok,
      afterRace,
      next,
      afterNextPull: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      ok: true,
      afterRace: { t1: null, splits: [] },
      next: true,
      afterNextPull: { t1: null, splits: [] },
    });
  });

  it("R3: the post-push refresh's split write (#112), met by realtime's tombstone of t1, leaves no split behind", async () => {
    meta.set('last_txn_pull_at:u', RACE_CURSOR);
    meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-06-14T23:59:45+00:00' }),
    ];
    ctx.store.transaction_splits = [serverSplit('s5'), serverSplit('s6')];
    await pulledT1();
    await applyTransactionUpdate(
      ctx.adapter as any,
      { id: 't1', accountId: 'a1', payee: 'Edited' },
      { now: '2026-06-15T00:00:10Z', newSplitId: () => 'unused' }
    );
    // The server's clock runs behind this device's: the upsert's stamp is not
    // past the pull cursor, so the push refreshes t1's splits itself.
    ctx.installSupabase({ serverNow: '2026-06-14T23:59:55+00:00' });
    const fired = tombstoneAtFirstSplitInsert();

    const pushErr = await rejection(pushChanges('u'));
    const afterRace = { t1: localTxn('t1'), splits: allSplits() };
    const next = await theNextPull();

    expect(fired()).toBe(true);
    expect({
      pushErr,
      afterRace,
      next,
      afterNextPull: { t1: localTxn('t1'), splits: allSplits() },
    }).toEqual({
      pushErr: null,
      afterRace: { t1: null, splits: [] },
      next: true,
      afterNextPull: { t1: null, splits: [] },
    });
  });
});

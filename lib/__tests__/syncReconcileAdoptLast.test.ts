// #136: the reconcile writes a parent's fields, replaces its splits and adopts
// the server's stamp last, one parent at a time.
//
// The reconcile heals a synced parent whose stamp differs from the server's,
// and pulls one this device lacks (pullTransactions, step 2). Until #136 it
// wrote each batch of up to 200 in phases: every parent took the server's
// fields AND stamp first (forceUpsertRemoteTransaction), then every parent's
// synced splits were deleted, then every server split was written. A stop in
// between (a kill, or a statement that throws: nothing here runs inside a
// transaction) left those parents MATCHING the server over their old splits,
// part of the new ones or none. The next enumeration compares stamps, so it
// planned nothing, and step 3 never lists such a parent either (its stamp is
// no newer than the cursor): the split set stayed wrong until the parent next
// changed on the server. A parent this device did not hold was inserted the
// same way, which is why "splits first, parent last" cannot fix it: a server
// split is written only under a synced local parent (#125).
//
// Now each parent in turn gets the server's fields under the placeholder
// stamp '' (one julianday cannot read, and no other writer produces), then its
// synced splits are deleted and the server's written, and the server's stamp
// is adopted last by an UPDATE that matches only the placeholder. A stop
// anywhere leaves the parent at '', which differs from the server's stamp,
// and the reconcile key unbanked, so the next pull's reconcile re-plans that
// parent and every untouched one after it. Realtime's last-write-wins guard
// refuses every row over '' (julianday('') is NULL), so an event landing
// inside a parent's window cannot put the server's stamp on a partial set;
// and the reconcile's snapshot counts '' as reconcilable, so a parent left at
// '' and then deleted on the server is still deleted here. A parent the
// snapshot held is inserted only while it is still here, so a tombstone that
// lands before its turn is not undone.
//
// The seeds follow syncSplitGuard.test.ts's seedReconcile: the cursor later
// than every stamp (step 1 lists nothing), no reconcile key (the enumeration
// is due), each parent synced here with <id>-a and <id>-b and held on the
// server with <id>-x and <id>-y. The default seed is a correction to an OLDER
// stamp; the "server-newer" seed is the other way round. Under these seeds
// the first `INSERT INTO transactions` pullChanges sends is the reconcile's
// fields write, and its first split DELETE and split INSERT are the
// reconcile's too.
//
// Regression tests fail on the code before #136. Pins pass there too, and
// exist to fail on a wrong fix. RT1 and RT1x are against the first design
// planned for #136, which kept the local stamp through the writes: a realtime
// write newer than the read, landing BEFORE the fields write, then left the
// parent matching the server over the read's older fields and splits, with no
// stop at all. The other pins are against the mutants listed in the PR, or
// guard what a wrong fix could lose (a tombstone or a local edit inside a
// parent's window). Two pins (RK5, RTg) assert what the placeholder costs, a
// realtime write dropped inside a parent's window, which the code before #136
// applied at once: they fail there by design, as sync.test.ts's rewritten
// force-upsert pin does.
//
// A server row a test changes is REPLACED in the fake's store, never mutated
// in place: the fake answers select('*') with its own row objects and readAll
// keeps them, so an in-place change made after the reconcile's read would
// also rewrite the rows it read (a real response is a fresh object).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyTransactionEvent } from '../realtimeHandlers';
import { pullChanges, pushChanges } from '../sync';
import { setLastError } from '../syncStatus';
import {
  insertLocalSplit,
  insertLocalTxn,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

/** This device's last pull began here: all three pull keys. */
const CURSOR = '2026-06-15T00:00:00Z';
/** The default seed: this device holds the parent at LOCAL_AT, */
const LOCAL_AT = '2026-03-01T00:00:00Z';
/** and the server corrected it to an OLDER stamp. */
const SERVER_AT = '2026-02-01T00:00:00Z';
/** The server-newer seed: this device holds the parent at OLD_LOCAL_AT, */
const OLD_LOCAL_AT = '2026-01-01T00:00:00Z';
/** and the server at a later stamp. */
const NEW_SERVER_AT = '2026-03-01T00:00:00Z';
/** A write another device makes while the reconcile runs, newer than both. */
const LATER_WRITE_AT = '2026-07-01T00:00:00+00:00';
/** A write between the default seed's two stamps (SERVER_AT < it < LOCAL_AT). */
const BETWEEN_WRITE_AT = '2026-02-15T00:00:00+00:00';
/** An event older than NEW_SERVER_AT and newer than OLD_LOCAL_AT. */
const OLDER_WRITE_AT = '2026-02-01T00:00:00+00:00';
/** A local edit that lands mid-reconcile, by this device's clock. */
const EDITED_AGAIN_AT = '2026-06-15T00:00:20Z';
/** The stamp a parent carries from its fields write until its adopt. */
const PLACEHOLDER = '';

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

/** A split as the server holds it. */
const serverSplit = (id: string, txnId: string) => ({
  id,
  transaction_id: txnId,
  amount: -5,
  memo: null,
  updated_at: '2026-06-01T00:00:00+00:00',
});

/**
 * A due reconcile: the three pull keys at the cursor, later than every stamp
 * here, so step 1 lists nothing, and no reconcile key. Each parent is held on
 * the server at `server` as 'Fixed' with <id>-x and <id>-y, and here, unless
 * `local` is null, synced at `local` as 'Stale' with <id>-a and <id>-b.
 */
async function seed(
  ...parents: { id: string; local: string | null; server: string }[]
) {
  ctx.meta.set('last_pull_at:u', CURSOR);
  ctx.meta.set('last_pull_attempt_at:u', CURSOR);
  ctx.meta.set('last_txn_pull_at:u', CURSOR);
  for (const { id, local, server } of parents) {
    if (local != null) {
      await insertLocalTxn(ctx.adapter, {
        id,
        updated_at: local,
        payee: 'Stale',
      });
      for (const splitId of [`${id}-a`, `${id}-b`]) {
        await insertLocalSplit(ctx.adapter, {
          id: splitId,
          transaction_id: id,
          amount: -5,
          updated_at: '2026-06-01T00:00:00Z',
        });
      }
    }
    ctx.store.transactions.push(
      remoteTxn({ id, updated_at: server, payee: 'Fixed' })
    );
    ctx.store.transaction_splits.push(
      serverSplit(`${id}-x`, id),
      serverSplit(`${id}-y`, id)
    );
  }
}

/** The default seed: `id` corrected on the server to an older stamp. */
const correction = (id: string) => ({
  id,
  local: LOCAL_AT,
  server: SERVER_AT,
});

/** The server-newer seed. */
const serverNewer = (id: string) => ({
  id,
  local: OLD_LOCAL_AT,
  server: NEW_SERVER_AT,
});

/** `id`'s local row as { status, updated_at, payee }; undefined when absent. */
function localTxn(id: string) {
  const row = ctx.adapter._sqlite
    .prepare(
      'SELECT _sync_status, updated_at, payee FROM transactions WHERE id = ?'
    )
    .get(id) as
    | { _sync_status: string; updated_at: string | null; payee: string }
    | undefined;
  return (
    row && {
      status: row._sync_status,
      updated_at: row.updated_at,
      payee: row.payee,
    }
  );
}

/** localTxn's shape for a synced row. */
const synced = (updated_at: string, payee: string) => ({
  status: 'synced',
  updated_at,
  payee,
});

/** `txnId`'s local splits as `id:status`, ordered by id. */
const localSplits = (txnId: string) =>
  (
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = ? ORDER BY id'
      )
      .all(txnId) as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);

/** Local splits whose parent row is gone: invisible, never pushed or wiped. */
const orphanSplits = () =>
  (
    ctx.adapter._sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM transaction_splits s WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = s.transaction_id)'
      )
      .get() as { n: number }
  ).n;

const reconcileKey = () => ctx.meta.get('last_txn_reconcile_at:u');

/** `id`'s row as the server holds it now. */
const serverTxn = (id: string) =>
  ctx.store.transactions.find((t: any) => t.id === id);

/** The ids of `txnId`'s splits on the server, sorted. */
const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

/**
 * Writes `patch` over `id`'s server row by REPLACING the row object (see the
 * header: an in-place change would leak into what the reconcile read).
 */
function serverWrite(id: string, patch: Record<string, unknown>) {
  const rows = ctx.store.transactions;
  const i = rows.findIndex((t: any) => t.id === id);
  rows[i] = { ...rows[i], ...patch };
  return rows[i];
}

/** Replaces `txnId`'s split set on the server: another device re-split it. */
function serverResplit(txnId: string, splitIds: string[]) {
  ctx.store.transaction_splits = ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id !== txnId)
    .concat(splitIds.map((splitId) => serverSplit(splitId, txnId)));
}

/**
 * `row` applied as useRealtimeSync applies an event: without the lock, and
 * through upsertRemoteTransaction's last-write-wins guard.
 */
async function realtime(row: any) {
  await applyTransactionEvent(ctx.adapter, {
    eventType: 'UPDATE',
    new: { ...row },
    old: { id: row.id },
  });
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
 * A re-split of `txnId` as lib/transactionUpdate.ts writes it, in one SQLite
 * transaction: the parent pending with the edit's stamp, the splits it holds
 * marked deleted, and <txnId>-n inserted pending.
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
    sql
      .prepare(
        "INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status) VALUES (?, ?, -3, NULL, ?, 'pending')"
      )
      .run(`${txnId}-n`, txnId, now);
  })();
}

/**
 * The hooks' patterns. FIELDS is the reconcile's fields write,
 * forceUpsertRemoteTransaction's statement (upsertRemoteTransaction's starts
 * the same way, but under these seeds nothing sends it before the reconcile).
 * The DELETE's first line is, word for word, the statement it was before
 * #125; the split INSERT is `VALUES` before #125 and `SELECT` since.
 */
const FIELDS = /^INSERT INTO transactions\b/;
const SPLIT_DELETE =
  /^DELETE FROM transaction_splits WHERE transaction_id = \? AND _sync_status = 'synced'/;
const SPLIT_INSERT =
  /^INSERT INTO transaction_splits \(id, transaction_id, amount, memo, updated_at, _sync_status\)\s+(VALUES|SELECT)/;

/**
 * Makes the `nth` runAsync whose SQL matches `match` throw instead of
 * running: the pull stopped at that statement. Nothing in the reconcile runs
 * inside a transaction, so a statement that throws leaves the store as a
 * process killed right there would: every statement before it written,
 * nothing after.
 */
function throwAt(match: RegExp, nth: number, message: string): () => boolean {
  const real = ctx.adapter.runAsync.bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  let seen = 0;
  let fired = false;
  (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
    if (!fired && match.test(sql) && ++seen === nth) {
      fired = true;
      throw new Error(message);
    }
    return real(sql, params);
  };
  return () => fired;
}

/**
 * Runs `fn` right before or right after the `nth` runAsync whose SQL matches
 * `match`: a point between two of the engine's statements, where a hook write
 * or a realtime event can land. The engine reaches the adapter by reference
 * (wireSyncMocks mocks getDb to resolve ctx.adapter itself), so replacing the
 * method on that object puts `fn` there. `fn` may write through the adapter
 * itself, as a realtime event does: once fired, the hook passes every later
 * statement through.
 */
function at(
  when: 'before' | 'after',
  match: RegExp,
  nth: number,
  fn: () => void | Promise<void>
): () => boolean {
  const real = ctx.adapter.runAsync.bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  let seen = 0;
  let fired = false;
  (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
    const hit = !fired && match.test(sql) && ++seen === nth;
    if (hit) fired = true;
    if (hit && when === 'before') await fn();
    const out = await real(sql, params);
    if (hit && when === 'after') await fn();
    return out;
  };
  return () => fired;
}

/** What a promise rejected with, as text ('' if it resolved): realm-safe. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return String(e);
  }
}

/**
 * A pull with the reconcile due again, as the next day's would be: the key
 * the previous pull banked, dropped. The cursor has moved to that pull's
 * start by then, past every stamp here, so step 1 lists nothing.
 */
async function forcedReconcile(): Promise<boolean> {
  ctx.meta.delete('last_txn_reconcile_at:u');
  return pullChanges('u');
}

describe("a stop inside the reconcile's writes leaves a drift the next pull heals (#136)", () => {
  it('RK1: stopped at the first split insert, the parent is left at the placeholder over no splits, and the next pull heals it', async () => {
    await seed(correction('t1'));
    const killed = throwAt(SPLIT_INSERT, 1, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(killed()).toBe(true);
    // The fields and the DELETE ran. Before #136 the parent took the server's
    // stamp with its fields, so the next enumeration found nothing to do and
    // the split set stayed empty for good.
    expect(localTxn('t1')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t1')).toEqual([]);
    expect(reconcileKey()).toBeUndefined();

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(reconcileKey()).toBeDefined();
  });

  it('RK1b: stopped at the split DELETE, the parent is left at the placeholder over its old splits, and the next pull heals it', async () => {
    await seed(correction('t1'));
    const killed = throwAt(SPLIT_DELETE, 1, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(killed()).toBe(true);
    expect(localTxn('t1')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-a:synced', 't1-b:synced']);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it('RK1c: a parent this device lacked, stopped at the first split insert, is left at the placeholder, and the next pull heals it', async () => {
    await seed({ id: 't1', local: null, server: SERVER_AT });
    const killed = throwAt(SPLIT_INSERT, 1, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(killed()).toBe(true);
    // Before #136 the insert path took the server's stamp too: equal stamps
    // over no splits, which no enumeration re-planned.
    expect(localTxn('t1')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t1')).toEqual([]);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it('RK1d: a parent left at the placeholder and then deleted on the server below the cursor is deleted here with its splits', async () => {
    // A regression test for the placeholder's `reconcilable` clause, and a pin
    // on the code before #136, whose stop left a stamp julianday reads. The
    // stop comes after one split insert, so the parent holds part of its set.
    await seed({ id: 't1', local: null, server: SERVER_AT });
    throwAt(SPLIT_INSERT, 2, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );
    expect(localSplits('t1')).toEqual(['t1-x:synced']);

    // The tombstone's stamp is below the cursor, so no incremental read lists
    // it: only the reconcile's enumeration sees it, as absent.
    serverWrite('t1', {
      deleted_at: BETWEEN_WRITE_AT,
      updated_at: BETWEEN_WRITE_AT,
    });

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toBeUndefined();
    expect(localSplits('t1')).toEqual([]);
    expect(orphanSplits()).toBe(0);
  });

  it('RK3: stopped at the second parent, the first is complete and the second is left at the placeholder over its old splits', async () => {
    await seed(correction('t1'), correction('t2'));
    const killed = throwAt(SPLIT_DELETE, 2, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(killed()).toBe(true);
    // One parent at a time: t1's writes all ran before t2's began. In phases
    // (every fields write, then every DELETE, then every INSERT, then every
    // adopt) this stop would leave t1 at the placeholder over no splits,
    // which the next pull still heals: what these lines pin is the order
    // itself, whose value is that each parent's realtime window spans only
    // its own statements.
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(localTxn('t2')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t2')).toEqual(['t2-a:synced', 't2-b:synced']);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(localTxn('t2')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t2')).toEqual(['t2-x:synced', 't2-y:synced']);
  });

  it("RK3b: stopped at the second parent's fields write, the first is complete and the second untouched", async () => {
    await seed(correction('t1'), correction('t2'));
    const killed = throwAt(FIELDS, 2, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(killed()).toBe(true);
    // Before #136 every parent took the server's stamp before any split was
    // written, so this stop left t1 matching the server over its OLD splits.
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(localTxn('t2')).toEqual(synced(LOCAL_AT, 'Stale'));
    expect(localSplits('t2')).toEqual(['t2-a:synced', 't2-b:synced']);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t2')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t2')).toEqual(['t2-x:synced', 't2-y:synced']);
  });
});

describe('what the reconcile writes when nothing stops it (#136)', () => {
  it("RK0c (pin): a parent this device lacked is pulled with the server's stamp and its splits", async () => {
    await seed({ id: 't1', local: null, server: SERVER_AT });

    expect(await pullChanges('u')).toBe(true);

    // The stamp is the point: an insert that wrote some other placeholder
    // than the one the adopt matches would leave it there.
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(reconcileKey()).toBeDefined();
  });

  it('RK0e (pin): a parent the server holds no splits for loses its stale synced ones', async () => {
    await seed(correction('t1'));
    serverResplit('t1', []);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual([]);
  });
});

describe("realtime inside the reconcile's window (#136)", () => {
  it('RT1 (pin): a newer write applied just BEFORE the fields write is overwritten by the read, a drift the next reconcile heals', async () => {
    await seed(correction('t1'));
    const fired = at('before', FIELDS, 1, () =>
      realtime(
        serverWrite('t1', { updated_at: LATER_WRITE_AT, payee: 'Realtime' })
      )
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // The read's fields and stamp, older than the server's now: not
    // converged, but not matching either. A fields write that kept the stamp
    // the row held at that statement would have left the write's stamp over
    // the read's fields, which no pass re-plans.
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);

    expect(await forcedReconcile()).toBe(true);

    expect(localTxn('t1')).toEqual(synced(LATER_WRITE_AT, 'Realtime'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it('RT1x (pin): the same newer write re-split the parent, and the next reconcile brings its splits', async () => {
    await seed(correction('t1'));
    const fired = at('before', FIELDS, 1, async () => {
      serverResplit('t1', ['t1-z']);
      await realtime(
        serverWrite('t1', { updated_at: LATER_WRITE_AT, payee: 'Realtime' })
      );
    });

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);

    expect(await forcedReconcile()).toBe(true);

    expect(localTxn('t1')).toEqual(synced(LATER_WRITE_AT, 'Realtime'));
    expect(localSplits('t1')).toEqual(['t1-z:synced']);
  });

  it('RT2: the realtime event of the very row the reconcile read, applied before its fields write, and then a stop, is healed by the next pull', async () => {
    await seed(serverNewer('t1'));
    const fired = at('before', FIELDS, 1, () => realtime(serverTxn('t1')));
    const killed = throwAt(SPLIT_INSERT, 1, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(fired()).toBe(true);
    expect(killed()).toBe(true);
    // The event gave the parent the server's stamp before the fields write;
    // the fields write replaced it with the placeholder. Before #136 the stamp
    // stayed the server's, over no splits, for good.
    expect(localTxn('t1')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t1')).toEqual([]);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(NEW_SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it('RT4: the same event applied AFTER the fields write is refused, so a stop still leaves the placeholder, and the next pull heals it', async () => {
    await seed(serverNewer('t1'));
    const fired = at('after', FIELDS, 1, () => realtime(serverTxn('t1')));
    const killed = throwAt(SPLIT_INSERT, 1, 'killed in the reconcile');

    expect(await rejection(pullChanges('u'))).toMatch(
      /killed in the reconcile/
    );

    expect(fired()).toBe(true);
    expect(killed()).toBe(true);
    // julianday('') is NULL, so the last-write-wins guard refuses the event.
    // A NULL placeholder, or a kept local stamp, would have let it put the
    // server's stamp on the empty set.
    expect(localTxn('t1')).toEqual(synced(PLACEHOLDER, 'Fixed'));
    expect(localSplits('t1')).toEqual([]);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual(synced(NEW_SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it("RK5 (pin of the new contract): a newer write arriving inside the parent's window is dropped, a drift the next reconcile heals", async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, () =>
      realtime(
        serverWrite('t1', { updated_at: LATER_WRITE_AT, payee: 'Realtime' })
      )
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // The price of the placeholder: realtime refuses the event, which is
    // never sent again, and the adopt writes the stamp the reconcile READ.
    // Before #136 the event landed at once.
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(reconcileKey()).toBeDefined();

    expect(await forcedReconcile()).toBe(true);

    expect(localTxn('t1')).toEqual(synced(LATER_WRITE_AT, 'Realtime'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it("RK5x: a newer write that re-split the parent inside its window is not left over the read's splits, and the next reconcile brings its own", async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, async () => {
      serverResplit('t1', ['t1-z']);
      await realtime(
        serverWrite('t1', { updated_at: LATER_WRITE_AT, payee: 'Realtime' })
      );
    });

    expect(await pullChanges('u')).toBe(true);
    expect(fired()).toBe(true);

    // Before #136 the event landed between the fields write and the split
    // writes, which then put the splits the reconcile READ under the event's
    // stamp: matching the server, over a set it no longer holds, for good.
    expect(await forcedReconcile()).toBe(true);

    expect(localTxn('t1')).toEqual(synced(LATER_WRITE_AT, 'Realtime'));
    expect(localSplits('t1')).toEqual(['t1-z:synced']);
  });

  it("RT3 (pin): an OLDER event inside the parent's window changes nothing", async () => {
    await seed(serverNewer('t1'));
    const fired = at('after', FIELDS, 1, () =>
      realtime({
        ...serverTxn('t1'),
        updated_at: OLDER_WRITE_AT,
        payee: 'Older',
      })
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // A NULL placeholder would have taken it, and an unguarded adopt would
    // then have put the server's stamp over its fields for good.
    expect(localTxn('t1')).toEqual(synced(NEW_SERVER_AT, 'Fixed'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    expect(serverTxn('t1').payee).toBe('Fixed');
  });

  it("RTg (pin of the new contract): a write between the two stamps arriving inside the parent's window is dropped, and the next reconcile heals it", async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, () =>
      realtime(
        serverWrite('t1', { updated_at: BETWEEN_WRITE_AT, payee: 'Realtime' })
      )
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));

    expect(await forcedReconcile()).toBe(true);

    expect(localTxn('t1')).toEqual(synced(BETWEEN_WRITE_AT, 'Realtime'));
    expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
  });

  it("TB (pin): a tombstone arriving inside the parent's window deletes it and leaves no orphan split", async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, () =>
      realtime(
        serverWrite('t1', {
          deleted_at: LATER_WRITE_AT,
          updated_at: LATER_WRITE_AT,
        })
      )
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toBeUndefined();
    expect(localSplits('t1')).toEqual([]);
    expect(orphanSplits()).toBe(0);
  });
});

describe("a tombstone that lands before a parent's turn (#136)", () => {
  // A parent waits for its fields write through the reads and every earlier
  // parent's writes. A tombstone realtime applies to it there deletes the
  // local row, and the fields write's insert path would bring it back, with
  // its splits, until a later pass reads the tombstone: so a parent the pass's
  // snapshot held is inserted only while it is still here. TB2 and TB2i are
  // green on the code before #136, whose phases ran every fields write before
  // the first split write; TB0 and TB0n fail there too.
  it.each([
    { id: 'TB2', point: 'split DELETE', statement: SPLIT_DELETE },
    { id: 'TB2i', point: 'first split insert', statement: SPLIT_INSERT },
  ])(
    "$id: a tombstone for the second parent, applied right after the first parent's $point, is not undone",
    async ({ statement }) => {
      await seed(correction('t1'), correction('t2'));
      const fired = at('after', statement, 1, () =>
        realtime(
          serverWrite('t2', {
            deleted_at: LATER_WRITE_AT,
            updated_at: LATER_WRITE_AT,
          })
        )
      );

      expect(await pullChanges('u')).toBe(true);

      expect(fired()).toBe(true);
      expect(localTxn('t2')).toBeUndefined();
      expect(localSplits('t2')).toEqual([]);
      expect(orphanSplits()).toBe(0);
      expect(localTxn('t1')).toEqual(synced(SERVER_AT, 'Fixed'));
      expect(localSplits('t1')).toEqual(['t1-x:synced', 't1-y:synced']);
    }
  );

  it.each([
    { id: 'TB0', label: 'the default seed', parent: correction },
    { id: 'TB0n', label: 'the server-newer seed', parent: serverNewer },
  ])(
    "$id: a tombstone applied right before the parent's fields write is not undone ($label)",
    async ({ parent }) => {
      await seed(parent('t1'));
      const fired = at('before', FIELDS, 1, () =>
        realtime(
          serverWrite('t1', {
            deleted_at: LATER_WRITE_AT,
            updated_at: LATER_WRITE_AT,
          })
        )
      );

      expect(await pullChanges('u')).toBe(true);

      expect(fired()).toBe(true);
      expect(localTxn('t1')).toBeUndefined();
      expect(localSplits('t1')).toEqual([]);
      expect(orphanSplits()).toBe(0);
    }
  );
});

describe("a local edit inside the reconcile's window (#136)", () => {
  it('FE (pin): a field edit right after the fields write keeps the parent pending over its own synced splits', async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, () =>
      editPayeeLocally('t1', EDITED_AGAIN_AT)
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    // The DELETE, the INSERTs and the adopt all refuse a parent that is not
    // synced: the edit keeps its stamp, and the splits it rides on stay.
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
      payee: 'Edited again',
    });
    expect(localSplits('t1')).toEqual(['t1-a:synced', 't1-b:synced']);
  });

  it('RK4 (pin): a re-split right after the fields write keeps only its own split, which the push uploads', async () => {
    await seed(correction('t1'));
    const fired = at('after', FIELDS, 1, () =>
      resplitLocally('t1', EDITED_AGAIN_AT)
    );

    expect(await pullChanges('u')).toBe(true);

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: EDITED_AGAIN_AT,
      payee: 'Fixed',
    });
    expect(localSplits('t1')).toEqual([
      't1-a:deleted',
      't1-b:deleted',
      't1-n:pending',
    ]);

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['t1-n']);
    expect(localSplits('t1')).toEqual(['t1-n:synced']);
  });
});

// The splits of a parent pushed alone, when the next pull would miss it (#112).
//
// Since #97 a pending transaction whose local splits are all synced, or that
// has none, is uploaded alone: the server keeps its split set, and the push
// adopts the server's updated_at. The pull after the push was trusted to list
// the parent and refresh its splits (pullTransactions, step 3). It lists a row
// only if its server stamp is later than last_txn_pull_at, the previous pull's
// start by THIS device's clock. With the device clock running ahead of the
// server's, a push landing within that lead adopts a stamp at or below the
// cursor: the pull skips the parent, the daily reconcile finds the local and
// server stamps equal, and a stale or missing local split set stayed until the
// parent next changed on the server.
//
// The push now detects exactly that case and reads those parents' splits
// itself, after its loop. Each parent stays pending through that read; then
// it is marked synced with its OWN stamp, its splits are replaced, and it
// takes the server's stamp only as the last statement (#128). A failed read,
// or anything that stops the refresh after the parent's mark and before that
// last statement, leaves it synced WITHOUT the server's stamp: a drift the
// reconcile sees and heals, parent and splits together. That reconcile is
// the next pull's (#140): the push clears the reconcile key before the
// refresh and puts it back only after a refresh that read everything, so a
// failed read or a stop, a kill included, leaves it cleared.
//
// Regression tests fail on the code before #112; the pins (N1-N4, F2) pass
// there too, and exist to fail on the wrong fix: a refresh on every push, one
// without a cursor, one that replaces a set this device changed, one that
// drops a split no push has sent, or one that overrides a local edit made
// mid-flight. The #128 tests at the end stop the refresh at a chosen
// statement, or land a write inside it. Their regression tests fail on the
// code before #128, which adopted the server's stamp in the mark, before the
// splits were replaced. Their pins pass there too, and fail on the variants
// #128 rejected or must not drift into: a parent marked synced in the loop,
// before the read; a DELETE guarded on the parent's stamp instead of on its
// being synced; an adopt not guarded on the stamp the loop read. The #140
// tests at the very end, all but the C4 and C5 pins, and the six earlier
// tests that fail or stop the refresh and then pull (F1, K1, K2, K3a, E1,
// K3b), fail on the code before #140, which left the key banked, so the
// reconcile waited up to a day: those six deleted the key by hand before
// their pull. C4 and C5 pass there too, and fail on a restore dropped or
// writing a fresh stamp, and on a clear with nothing set aside. P8, R1 and
// R1b still delete the key by hand, after a refresh that read everything,
// to force a reconcile the push has no reason to ask for. The suite keeps
// sync_meta in the adapter's own table (wireSqliteSyncMeta), where the
// push's DELETE lands: the fixture's default map never sees one.
//
// The server's clock is the fixture's `serverNow`, which the fake stamps on
// the UPDATE path only, so a parent a test skews is on the server before the
// push (N4's is not, on purpose). The offsets are whole seconds: the fake's
// `gt` compares strings, and PostgREST's '+00:00' rendering sorts below a 'Z'
// cursor within one second.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyTransactionEvent } from '../realtimeHandlers';
import { supabase } from '../supabase';
import { fullSync, pullChanges, pushChanges, requestPush } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalSplit,
  insertLocalTxn,
  remoteTxn,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';
import {
  applyTransactionUpdate,
  type UpdateTransactionInput,
} from '../transactionUpdate';

/** This device's last pull began here, by its own clock: `last_txn_pull_at`. */
const CURSOR = '2026-06-15T00:00:00Z';
/**
 * The server's clock as the push lands, 5 s short of that cursor: the device
 * clock runs ahead of the server's by more than the time since the pull began.
 */
const SERVER_BEHIND = '2026-06-14T23:59:55+00:00';
/** The cursor itself, as PostgREST renders it. */
const SERVER_AT_CURSOR = '2026-06-15T00:00:00+00:00';
/** Clocks in step: the push lands after the pull began. */
const SERVER_AFTER = '2026-06-15T00:00:05+00:00';
/**
 * When another device re-split t1, by the server's clock: after this device's
 * last pull began, which the skew still puts below the cursor.
 */
const RESPLIT_AT = '2026-06-14T23:59:45+00:00';
/** When this device last pulled t1 and its splits. */
const OLD = '2026-06-01T00:00:00Z';
/** The local edit that makes t1 pending, by this device's clock. */
const EDITED_AT = '2026-06-15T00:00:10Z';
/** A second local edit, landing while the push is in flight. */
const REDIRTIED_AT = '2026-06-15T00:00:20Z';
/**
 * An edit made offline, or long enough before its push that the server's
 * clock has passed it by the upload despite the skew: not later than the
 * stamp the upload gets (SERVER_BEHIND), itself not later than the cursor.
 * The realtime echo of that upload is newer than such an edit.
 */
const OFFLINE_EDIT_AT = '2026-06-14T23:59:00Z';
/**
 * Another device's write to t1, by the server's clock: after this push's
 * upload, and still short of the cursor, so no incremental pull lists it.
 */
const ELSEWHERE_AT = '2026-06-14T23:59:58+00:00';
/**
 * A reconcile banked an hour ago: not due, and unlike the seed's "just now"
 * never equal to a stamp the push itself could write.
 */
const bankedAnHourAgo = () =>
  new Date(Date.now() - 60 * 60 * 1000).toISOString();

/**
 * wireSyncMocks' context with sync_meta in the adapter's own table
 * (wireSqliteSyncMeta), where the push's `DELETE FROM sync_meta` of the
 * reconcile key lands (#140); the fixture's in-memory map would never see
 * it. `meta` answers the map's three calls, so seeds and assertions read as
 * before.
 */
type Ctx = Omit<ReturnType<typeof wireSyncMocks>, 'meta'> & {
  meta: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
  };
};

let ctx: Ctx;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  const wired = wireSyncMocks();
  const table = wireSqliteSyncMeta(wired.adapter);
  ctx = {
    ...wired,
    meta: {
      ...table,
      delete: (key) => {
        wired.adapter._sqlite
          .prepare('DELETE FROM sync_meta WHERE key = ?')
          .run(key);
      },
    },
  };
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

/** A split as the server holds it: stamped, in PostgREST's rendering. */
const serverSplit = (id: string, txnId = 't1') => ({
  id,
  transaction_id: txnId,
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

/** What the reset guard would count: every row a push still has to send. */
const unsyncedRows = () =>
  (
    ctx.adapter._sqlite
      .prepare(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE _sync_status IN ('pending','deleted'))
              + (SELECT COUNT(*) FROM transaction_splits WHERE _sync_status IN ('pending','deleted')) AS n`
      )
      .get() as { n: number }
  ).n;

const serverTxn = (id: string) =>
  ctx.store.transactions.find((r: any) => r.id === id);

const serverSplitIds = (txnId: string) =>
  ctx.store.transaction_splits
    .filter((s: any) => s.transaction_id === txnId)
    .map((s: any) => s.id)
    .sort();

const warned = (pattern: RegExp) =>
  quiet[1].mock.calls.some((args) => pattern.test(String(args[0])));

/**
 * What the transaction screen writes for an edit that leaves the splits alone:
 * applyTransactionUpdate, as useUpdateTransaction calls it. The cast is for
 * TxnDb's generic getFirstAsync, which the fixture's adapter does not declare.
 */
async function edit(
  input: Omit<UpdateTransactionInput, 'accountId'>,
  now = EDITED_AT
) {
  await applyTransactionUpdate(
    ctx.adapter as any,
    { accountId: 'a1', ...input },
    { now, newSplitId: () => 'unused' }
  );
}

/**
 * The same write, synchronously and past the adapter, for an edit landing
 * inside the push's round trip (onAfterUpsert).
 */
function editPayeeSync(id: string) {
  ctx.adapter._sqlite
    .prepare(
      "UPDATE transactions SET payee = 'Edited again', updated_at = ?, _sync_status = 'pending' WHERE id = ?"
    )
    .run(REDIRTIED_AT, id);
}

/**
 * A transaction on the server with `serverSplits`, and here as this device
 * last pulled it — synced at OLD, with `stale` synced under it — then edited
 * at `editedAt` without touching its splits, so the push uploads it alone.
 * The cursor is CURSOR, and the reconcile was banked just now, so a pull is
 * incremental unless that key is cleared: by a test, or by a push whose
 * refresh failed or stopped (#140).
 */
async function seedEdited(
  id: string,
  serverSplits: string[],
  stale: string[],
  editedAt = EDITED_AT
) {
  ctx.meta.set('last_txn_pull_at:u', CURSOR);
  ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
  ctx.store.transactions.push(remoteTxn({ id, updated_at: RESPLIT_AT }));
  ctx.store.transaction_splits.push(
    ...serverSplits.map((splitId) => serverSplit(splitId, id))
  );
  await insertLocalTxn(ctx.adapter, { id, updated_at: OLD });
  for (const splitId of stale) {
    await insertLocalSplit(ctx.adapter, {
      id: splitId,
      transaction_id: id,
      amount: -5,
      updated_at: OLD,
    });
  }
  await edit({ id, payee: 'Edited' }, editedAt);
}

const seedEditedT1 = (
  serverSplits: string[],
  stale: string[],
  editedAt = EDITED_AT
) => seedEdited('t1', serverSplits, stale, editedAt);

/**
 * Drops `updated_at` from the read-back of every transactions upsert, as a
 * server that did not report one would. Install it AFTER installSupabase,
 * whose `from` it wraps.
 */
function readBackWithoutStamp() {
  const realFrom = (supabase as any).from;
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table !== 'transactions') return builder;
    const upsert = builder.upsert;
    builder.upsert = (row: any, opts: any) => {
      const written = upsert(row, opts);
      const select = written.select;
      written.select = (cols?: string) => {
        const selected = select(cols);
        const single = selected.single;
        selected.single = async () => {
          const res = await single();
          if (!res.data) return res;
          const { updated_at: _dropped, ...rest } = res.data;
          return { ...res, data: rest };
        };
        return selected;
      };
      return written;
    };
    return builder;
  };
}

/**
 * Counts the page requests on transaction_splits from here on — `.range()`
 * calls, not `from()` calls, which the push's split writes make too — and the
 * length of each request's parent-id list. Install it AFTER installSupabase,
 * whose `from` it wraps.
 */
function watchSplitReads() {
  const realFrom = (supabase as any).from;
  const seen = { pages: 0, idLists: [] as number[] };
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table !== 'transaction_splits') return builder;
    const range = builder.range;
    const inFilter = builder.in;
    builder.in = (col: string, vals: any[]) => {
      seen.idLists.push(vals.length);
      return inFilter(col, vals);
    };
    builder.range = (from: number, to: number) => {
      seen.pages++;
      return range(from, to);
    };
    return builder;
  };
  return seen;
}

/**
 * Runs `fn` right after the first call of `method` whose SQL matches `match`
 * resolves: a known point inside the push. The engine reaches the adapter by
 * reference (wireSyncMocks mocks getDb to resolve ctx.adapter itself), so
 * replacing the method on that object puts `fn` between two of the engine's
 * statements.
 */
function afterFirst(
  method: 'getFirstAsync' | 'runAsync',
  match: RegExp,
  fn: () => void | Promise<void>
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
      await fn();
    }
    return out;
  };
  return () => fired;
}

/**
 * The hooks' patterns. The DELETE's first line is, word for word, the
 * statement it was before #125 (deleteSyncedSplits); the INSERT is
 * upsertRemoteSplit's, `VALUES` before #125 and `SELECT` since; the mark
 * adopted the server's stamp through `COALESCE` before #128. Each pattern
 * matches both forms, so a test runs unchanged on the code before the fix.
 */
const SYNCED_SPLITS_DELETE =
  /^DELETE FROM transaction_splits WHERE transaction_id = \? AND _sync_status = 'synced'/;
const SPLIT_INSERT =
  /^INSERT INTO transaction_splits \(id, transaction_id, amount, memo, updated_at, _sync_status\)\s+(VALUES|SELECT)/;
const REFRESH_MARK =
  /^UPDATE transactions\s+SET _sync_status = 'synced'(, updated_at = COALESCE\(\?, updated_at\))?\s+WHERE id = \? AND updated_at = \? AND _sync_status = 'pending'/;

/**
 * Makes the `nth` runAsync whose SQL matches `match` throw instead of
 * running: the push stopped at that statement. Nothing in the refresh runs
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
 * Runs `fn` inside the first page request of a transaction_splits read,
 * before that page is answered: a point inside the refresh's read, where a
 * hook write or a realtime event can land. Install it AFTER installSupabase,
 * whose `from` it wraps.
 */
function duringSplitRead(fn: () => void | Promise<void>): () => boolean {
  const realFrom = (supabase as any).from;
  let fired = false;
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table !== 'transaction_splits') return builder;
    const range = builder.range;
    builder.range = (from: number, to: number) => {
      if (fired) return range(from, to);
      fired = true;
      return Promise.resolve(fn()).then(() => range(from, to));
    };
    return builder;
  };
  return () => fired;
}

/**
 * Fails the first page request of a transaction_splits read, as a dropped
 * connection would, and answers every later one. Install it AFTER
 * installSupabase, whose `from` it wraps.
 */
function failFirstSplitRead(): () => boolean {
  const realFrom = (supabase as any).from;
  let failed = false;
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table !== 'transaction_splits') return builder;
    const range = builder.range;
    builder.range = (from: number, to: number) => {
      if (failed) return range(from, to);
      failed = true;
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST000', message: 'connection dropped' },
      });
    };
    return builder;
  };
  return () => failed;
}

/**
 * Fails every page request of a transaction_splits read whose parent-id list
 * holds `id`, and answers every other. Install it AFTER installSupabase,
 * whose `from` it wraps.
 */
function failSplitReadListing(id: string): () => boolean {
  const realFrom = (supabase as any).from;
  let failed = false;
  (supabase as any).from = (table: string) => {
    const builder = realFrom(table);
    if (table !== 'transaction_splits') return builder;
    let listed: string[] = [];
    const inFilter = builder.in;
    builder.in = (col: string, vals: string[]) => {
      listed = vals;
      return inFilter(col, vals);
    };
    const range = builder.range;
    builder.range = (from: number, to: number) => {
      if (!listed.includes(id)) return range(from, to);
      failed = true;
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST000', message: 'connection dropped' },
      });
    };
    return builder;
  };
  return () => failed;
}

/**
 * `id`'s row as the server now holds it, applied as useRealtimeSync applies
 * an event: the echo of this device's own upload, or another device's write.
 * The handler takes no lock; upsertRemoteTransaction refuses the row over a
 * local one that is not synced, or is newer.
 */
async function realtimeUpdate(id: string) {
  await applyTransactionEvent(ctx.adapter, {
    eventType: 'UPDATE',
    new: { ...serverTxn(id) },
    old: { id },
  });
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
 * A process killed at the `nth` runAsync whose SQL matches `match`: that
 * statement does not run, or with `after` runs as the last one, and every
 * call on the adapter from then on fails, as nothing runs in a killed
 * process, no catch and no finally. throwAt fails one statement and lets
 * every catch run, so a clear in a catch would pass a throwAt test; it
 * fails here. `revive()` is the next launch, over the same store.
 */
function killAt(
  match: RegExp,
  nth: number,
  opts: { after?: boolean } = {}
): { fired: () => boolean; revive: () => void } {
  let seen = 0;
  let dead = false;
  let fired = false;
  for (const method of [
    'getAllAsync',
    'getFirstAsync',
    'runAsync',
    'execAsync',
  ] as const) {
    const real = (ctx.adapter as any)[method].bind(ctx.adapter) as (
      sql: string,
      params?: any[]
    ) => Promise<any>;
    (ctx.adapter as any)[method] = async (sql: string, params: any[] = []) => {
      if (dead) throw new Error('process killed');
      if (method === 'runAsync' && match.test(sql) && ++seen === nth) {
        fired = true;
        dead = true;
        if (!opts.after) throw new Error('process killed');
      }
      return real(sql, params);
    };
  }
  return {
    fired: () => fired,
    revive: () => {
      dead = false;
    },
  };
}

/** The SQL of every runAsync matching `match` from here on. */
function runsOf(match: RegExp): string[] {
  const real = ctx.adapter.runAsync.bind(ctx.adapter) as (
    sql: string,
    params?: any[]
  ) => Promise<any>;
  const seen: string[] = [];
  (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
    if (match.test(sql)) seen.push(sql);
    return real(sql, params);
  };
  return seen;
}

describe('a parent pushed alone under a device clock running ahead (#112)', () => {
  it("P8: gets the server's splits at the push, and the pull after it keeps them", async () => {
    // Another device re-split t1 into s3, s4; this device still holds s1, s2.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });

    await pushChanges('u');

    // The server kept the other device's set, and this device has it now.
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });

    // Nothing after the push would have brought them: t1's stamp is below the
    // cursor, so the pull does not list it, and the reconcile, forced here
    // (this refresh read everything, so the push put the key back, #140),
    // finds the local and server stamps equal.
    ctx.meta.delete('last_txn_reconcile_at:u');
    expect(await pullChanges('u')).toBe(true);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeDefined();
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('P8b: a stamp EQUAL to the cursor is a miss too', async () => {
    // The pull asks for `updated_at > cursor`, and Postgres's `>` excludes the
    // cursor itself.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_AT_CURSOR });

    await pushChanges('u');

    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_AT_CURSOR,
    });
  });

  it('P8c: a read-back that carries no stamp at all is a miss too', async () => {
    // The server's clock is in step here, but the stamp never came back, so
    // the push cannot tell whether the next pull lists t1. SQLite's julianday
    // of NULL is NULL, and `NULL > cursor` is not true: read as a miss. So is
    // any stamp julianday cannot read, which Date.parse would turn into NaN
    // and a string comparison would order as text.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_AFTER });
    readBackWithoutStamp();

    await pushChanges('u');

    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    // With no stamp to adopt, the parent keeps its own, as the loop's mark does.
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
  });

  it('M1: a parent held without its splits gets them', async () => {
    // A download that failed at the split read, or realtime, left t1 here
    // with none of its splits.
    await seedEditedT1(['s1', 's2'], []);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual(['s1', 's2']);
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(localTxn('t1')?.status).toBe('synced');
  });

  it('M2: a parent whose server set is empty loses its stale local split', async () => {
    // Another device removed every split of t1.
    await seedEditedT1([], ['s1']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });

    await pushChanges('u');

    expect(serverSplitIds('t1')).toEqual([]);
    expect(localSplits('t1')).toEqual([]);
    expect(localTxn('t1')?.status).toBe('synced');
  });

  it("F1: a failed split read marks the parent synced with its OWN stamp, and the next pull's reconcile heals parent and splits together", async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({
      serverNow: SERVER_BEHIND,
      errorReadsOn: new Set(['transaction_splits']),
    });

    await pushChanges('u');

    // The edit is on the server ...
    expect(serverTxn('t1').payee).toBe('Edited');
    expect(serverTxn('t1').updated_at).toBe(SERVER_BEHIND);
    // ... so the parent is synced, but keeps its own stamp rather than the
    // server's: the drift the reconcile looks for.
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    // Nothing is left for a push to send again — so a reset does not refuse
    // over an edit that did upload — and nothing is reported but the warning.
    expect(unsyncedRows()).toBe(0);
    expect(getSyncSnapshot().lastError).toBeNull();
    expect(warned(/split refresh after push/)).toBe(true);

    // The reads work again, the server's clock still behind. The reconcile
    // is due: the push cleared its key before the read, and a failed read
    // leaves it cleared (#140).
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('B1: parents past the first batch of 200 are refreshed too, and no read lists more than 200', async () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) => `t${String(i).padStart(3, '0')}`
    );
    for (const id of ids) {
      await seedEdited(id, [`${id}-server`], [`${id}-stale`]);
    }
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const reads = watchSplitReads();

    await pushChanges('u');

    expect(localSplits('t200')).toEqual(['t200-server:synced']);
    const splitIds = (
      ctx.adapter._sqlite
        .prepare(
          "SELECT id FROM transaction_splits WHERE _sync_status = 'synced' ORDER BY id"
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    expect(splitIds).toEqual(ids.map((id) => `${id}-server`));
    expect(unsyncedRows()).toBe(0);
    // PostgREST encodes `in.(...)` into the query string: bounded per request.
    expect(reads.pages).toBeGreaterThan(0);
    expect(Math.max(...reads.idLists)).toBeLessThanOrEqual(200);
  });

  it('B2: each parent in a batch takes only its own server splits, and one edited again mid-flight takes none', async () => {
    // t1 and t2 are set aside together and read in one batch. t1 is edited
    // again while its upload is in flight, so its mark matches nothing.
    await seedEdited('t1', ['s3'], ['s1']);
    await seedEdited('t2', ['s6'], ['s5']);
    let first = true;
    ctx.installSupabase({
      serverNow: SERVER_BEHIND,
      onAfterUpsert: async (table) => {
        if (table === 'transactions' && first) {
          first = false;
          editPayeeSync('t1');
        }
      },
    });

    await pushChanges('u');

    expect(localSplits('t1')).toEqual(['s1:synced']);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: REDIRTIED_AT,
    });
    expect(localSplits('t2')).toEqual(['s6:synced']);
    expect(localTxn('t2')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
  });
});

describe('pins: when the push must NOT read splits, or must not write them (#112)', () => {
  it('N1: with the clocks in step no split is read at the push, and the pull after it refreshes as before', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_AFTER });
    const reads = watchSplitReads();

    await pushChanges('u');

    expect(reads.pages).toBe(0);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_AFTER,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);

    expect(await pullChanges('u')).toBe(true);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('N2: with no cursor no split is read at the push, and the pull after it reads every row', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.meta.delete('last_txn_pull_at:u');
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const reads = watchSplitReads();

    await pushChanges('u');

    expect(reads.pages).toBe(0);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });

    expect(await pullChanges('u')).toBe(true);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('F2: a parent edited again during the round trip is not refreshed and stays pending', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({
      serverNow: SERVER_BEHIND,
      onAfterUpsert: async (table) => {
        if (table === 'transactions') editPayeeSync('t1');
      },
    });

    await pushChanges('u');

    // Its next push uploads the second edit, and refreshes then.
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: REDIRTIED_AT,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
  });

  it('N3: a parent whose splits this device changed uploads them under the same skew, and is not refreshed', async () => {
    // Its set is the newer one, and the push has just put it on the server,
    // so a stamp below the cursor costs it nothing.
    await seedEditedT1(['s1', 's2'], ['s1', 's2']);
    const newIds = ['s3', 's4'];
    await applyTransactionUpdate(
      ctx.adapter as any,
      {
        accountId: 'a1',
        id: 't1',
        splits: [
          { amount: -3, memo: null },
          { amount: -7, memo: null },
        ],
      },
      { now: EDITED_AT, newSplitId: () => newIds.shift()! }
    );
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const reads = watchSplitReads();

    await pushChanges('u');

    expect(reads.pages).toBe(0);
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
  });

  it('N4: a split written after the push read its parent survives the refresh, and the next push sends it', async () => {
    // t9 was created before the last pull began and is pushed only now: the
    // push INSERTS it, so it keeps its own creation stamp, which is below the
    // cursor with no skew at all, and the refresh reads its (empty) set. Its
    // split lands as useCreateTransaction writes one, after the parent, here
    // after the push has checked t9's splits: the race the adoption comment
    // in pushChanges names. Only this device's synced rows are the server's
    // to replace.
    ctx.meta.set('last_txn_pull_at:u', CURSOR);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalTxn(ctx.adapter, {
      id: 't9',
      created_at: '2026-06-14T23:59:00Z',
      updated_at: '2026-06-14T23:59:00Z',
      _sync_status: 'pending',
    });
    ctx.installSupabase({ serverNow: SERVER_AFTER });
    const fired = afterFirst('getFirstAsync', /SELECT EXISTS/, () => {
      ctx.adapter._sqlite
        .prepare(
          "INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status) VALUES ('s9', 't9', -5, NULL, ?, 'pending')"
        )
        .run('2026-06-14T23:59:00Z');
    });

    await pushChanges('u');

    expect(fired()).toBe(true);
    expect(localTxn('t9')?.status).toBe('synced');
    expect(localSplits('t9')).toEqual(['s9:pending']);

    // The adoption re-queues t9 with its split, which the next push uploads.
    await pushChanges('u');
    expect(serverSplitIds('t9')).toEqual(['s9']);
    expect(localSplits('t9')).toEqual(['s9:synced']);
  });
});

describe('a refresh stopped after its mark leaves the drift the reconcile heals (#128)', () => {
  // The refresh used to adopt the server's stamp in its mark-synced, before
  // it replaced the parent's splits. Stopped in between, by a kill or a
  // statement that threw, it left the parent synced under the server's
  // stamp over its stale splits, part of the server's set, or none: the pull
  // does not list a stamp below the cursor, and the reconcile finds nothing
  // to heal where the stamps are equal. Each test stops the refresh at one
  // statement, and fails on that code. Since #140 the pull after the stop
  // runs that reconcile without help: the push cleared its key before the
  // mark.
  it("K1: stopped at the first split insert, the parent is left synced with its OWN stamp and no splits, and the next pull's reconcile heals both", async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const killed = throwAt(SPLIT_INSERT, 1, 'killed at a split insert');

    expect(await rejection(pushChanges('u'))).toMatch(
      /killed at a split insert/
    );

    expect(killed()).toBe(true);
    // The edit is on the server, and the DELETE has taken the local splits.
    expect(serverTxn('t1').updated_at).toBe(SERVER_BEHIND);
    expect(localSplits('t1')).toEqual([]);
    // Synced, so nothing is uploaded again and a reset does not refuse, but
    // with its own stamp: the drift the reconcile looks for.
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(unsyncedRows()).toBe(0);

    // The push cleared the reconcile key before the mark (#140), so the next
    // pull reconciles.
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('K1b: through requestPush the stop is reported and the lock released, with nothing left pending', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    throwAt(SPLIT_INSERT, 1, 'killed at a split insert');

    await requestPush('u');

    expect(getSyncSnapshot().lastError).toMatch(/killed at a split insert/);
    expect(getSyncSnapshot().isSyncing).toBe(false);
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(unsyncedRows()).toBe(0);
  });

  it("K2: stopped at the DELETE, the parent keeps its OWN stamp over its stale splits, and the next pull's reconcile replaces them", async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    throwAt(SYNCED_SPLITS_DELETE, 1, 'killed at the split delete');

    expect(await rejection(pushChanges('u'))).toMatch(
      /killed at the split delete/
    );

    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(unsyncedRows()).toBe(0);

    // The key was cleared before the mark (#140).
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("K3a: two parents set aside, stopped at the second one's DELETE: the first is complete, the second keeps its own stamp, and nothing is pending", async () => {
    await seedEdited('t1', ['s3'], ['s1']);
    await seedEdited('t2', ['s6'], ['s5']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    throwAt(SYNCED_SPLITS_DELETE, 2, 'killed at the second split delete');

    expect(await rejection(pushChanges('u'))).toMatch(
      /killed at the second split delete/
    );

    // t1 went all the way: its splits, then the server's stamp.
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced']);
    // t2 was marked synced and stopped there.
    expect(localSplits('t2')).toEqual(['s5:synced']);
    expect(localTxn('t2')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(unsyncedRows()).toBe(0);

    // t1's complete refresh did not put the key back: only a whole refresh
    // that read everything does (#140).
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t2')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t2')).toEqual(['s6:synced']);
    expect(localSplits('t1')).toEqual(['s3:synced']);
  });

  it('E1: the echo of the upload, arriving while the parent is set aside, is refused, so a stop after the DELETE still leaves the drift', async () => {
    // Edited offline: the echo of the upload carries a stamp newer than the
    // edit's, which the realtime handler would take onto a SYNCED parent. A
    // parent marked synced before this read (the variant #128 rejected: the
    // mark in the loop) takes it there, and a stop further on then leaves it
    // equal to the server's over no splits. Pending, the parent refuses the
    // echo, and realtime never delivers it again. The assertion on the echo
    // is a pin (it holds before #128 too, and fails on the mark in the loop);
    // the rest is the regression.
    await seedEditedT1(['s3', 's4'], ['s1', 's2'], OFFLINE_EDIT_AT);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    let atEcho: ReturnType<typeof localTxn> = undefined;
    const echoed = duringSplitRead(async () => {
      await realtimeUpdate('t1');
      atEcho = localTxn('t1');
    });
    throwAt(SPLIT_INSERT, 1, 'killed at a split insert');

    expect(await rejection(pushChanges('u'))).toMatch(
      /killed at a split insert/
    );

    expect(echoed()).toBe(true);
    expect(atEcho).toEqual({ status: 'pending', updated_at: OFFLINE_EDIT_AT });
    expect(localSplits('t1')).toEqual([]);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: OFFLINE_EDIT_AT,
    });
    expect(unsyncedRows()).toBe(0);

    // The key was cleared before the mark (#140).
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });
});

describe('pins: what the refresh leaves pending, and what lands between its statements (#128)', () => {
  it('K5: the set-aside parent is still pending while the refresh reads its splits', async () => {
    // What keeps a realtime write off it until the refresh writes (E1).
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    let atRead: ReturnType<typeof localTxn> = undefined;
    const read = duringSplitRead(() => {
      atRead = localTxn('t1');
    });

    await pushChanges('u');

    expect(read()).toBe(true);
    expect(atRead).toEqual({ status: 'pending', updated_at: EDITED_AT });
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("K3b: stopped at the first parent's split insert, the second parent is never reached and stays pending for its next push", async () => {
    // Deliberately not fixed: marking every set-aside parent synced in the
    // loop would spare it the re-upload, at the price E1 describes. Only the
    // t1 half fails before #128, where t1 took the server's stamp first.
    await seedEdited('t1', ['s3'], ['s1']);
    await seedEdited('t2', ['s6'], ['s5']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    throwAt(SPLIT_INSERT, 1, 'killed at a split insert');

    expect(await rejection(pushChanges('u'))).toMatch(
      /killed at a split insert/
    );

    expect(localTxn('t2')).toEqual({
      status: 'pending',
      updated_at: EDITED_AT,
    });
    expect(localSplits('t2')).toEqual(['s5:synced']);
    expect(localSplits('t1')).toEqual([]);
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });

    // The next push uploads t2 again, alone, and refreshes it ...
    await pushChanges('u');
    expect(localTxn('t2')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t2')).toEqual(['s6:synced']);

    // ... and the next pull's reconcile heals t1. The stopped push cleared
    // the key (#140); this one, whose refresh read everything, found it
    // cleared and left it so: it puts back only what it found.
    expect(await pullChanges('u')).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced']);
  });

  it('G1: a field edit landing during the split read leaves the parent pending with its own synced splits, and its next push refreshes them', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const read = duringSplitRead(() => editPayeeSync('t1'));

    await pushChanges('u');

    // The mark asks for the stamp the loop read, and matches nothing.
    expect(read()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: REDIRTIED_AT,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);

    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("G1b: a field edit landing right after the refresh's mark leaves the parent pending with its own splits and its edit's stamp, and its next push refreshes them", async () => {
    // The DELETE, the inserts and the adopt all ask for a parent that is
    // still synced, so all three pass over it. W4f in syncSplitGuard.test.ts
    // (#125) lands its edit at the same point.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const fired = afterFirst('runAsync', REFRESH_MARK, () =>
      editPayeeSync('t1')
    );

    await pushChanges('u');

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: REDIRTIED_AT,
    });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(serverSplitIds('t1')).toEqual(['s3', 's4']);

    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("R1: another device's write arriving during the split read is refused on the pending parent, which takes its own upload's stamp; the reconcile brings the newer one", async () => {
    // Edited offline, so the write is later than the parent's own stamp: on
    // a parent marked synced in the loop the handler would take it, and the
    // refresh would leave the parent under the write's stamp, not its own
    // upload's.
    await seedEditedT1(['s3', 's4'], ['s1', 's2'], OFFLINE_EDIT_AT);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const read = duringSplitRead(async () => {
      Object.assign(serverTxn('t1'), {
        updated_at: ELSEWHERE_AT,
        payee: 'Elsewhere',
      });
      await realtimeUpdate('t1');
    });

    await pushChanges('u');

    // Refused while pending, and never delivered again.
    expect(read()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(unsyncedRows()).toBe(0);

    // The write is short of the cursor, so no incremental pull lists it; the
    // reconcile, forced here (this refresh read everything, so the push put
    // the key back, #140), sees the stamps differ.
    ctx.meta.delete('last_txn_reconcile_at:u');
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: ELSEWHERE_AT,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("R1b: another device's write taken between the refresh's mark and its adopt keeps its stamp: the set as read lands, the adopt matches nothing, and nothing is duplicated", async () => {
    // Edited offline, so the write, later than the upload, is later than the
    // parent's own stamp too, and the handler takes it onto the parent the
    // mark has just made synced. Guarding the DELETE on the stamp instead of
    // on "still synced" would skip it here while the inserts run: the stale
    // splits beside the server's, all synced under a stamp equal to the
    // server's, which nothing heals.
    await seedEditedT1(['s3', 's4'], ['s1', 's2'], OFFLINE_EDIT_AT);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const fired = afterFirst('runAsync', REFRESH_MARK, async () => {
      Object.assign(serverTxn('t1'), {
        updated_at: ELSEWHERE_AT,
        payee: 'Elsewhere',
      });
      await realtimeUpdate('t1');
    });

    await pushChanges('u');

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: ELSEWHERE_AT,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(unsyncedRows()).toBe(0);

    // Local and server agree: the reconcile, forced here as in R1, has
    // nothing to do.
    ctx.meta.delete('last_txn_reconcile_at:u');
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: ELSEWHERE_AT,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it("PS2: a field edit landing between two of the refresh's split inserts leaves the parent pending over the part written, under its edit's stamp; its next push refreshes the whole set", async () => {
    // #125's trade (upsertRemoteSplit's docblock): the second insert asks for
    // a synced parent and passes over it, and so does the adopt.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const fired = afterFirst('runAsync', SPLIT_INSERT, () =>
      editPayeeSync('t1')
    );

    await pushChanges('u');

    expect(fired()).toBe(true);
    expect(localTxn('t1')).toEqual({
      status: 'pending',
      updated_at: REDIRTIED_AT,
    });
    expect(localSplits('t1')).toEqual(['s3:synced']);

    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });
});

describe('the reconcile key: cleared before the refresh, put back only after one that read everything (#140)', () => {
  // A failed read, or a push stopped after a parent's mark, leaves that
  // parent synced with its own stamp over splits that may be stale or
  // missing: a drift only the reconcile heals, which waited up to a day
  // behind a banked key. The push now clears the key before the refresh's
  // first mark and puts it back only after a refresh that read everything.
  // The six earlier tests that fail or stop the refresh and then pull prove
  // the heal at the next pull; these cover the paths around it.
  it('C3: a refresh that throws inside fullSync fails that sync before its pull, and the next fullSync heals the parent', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const threw = throwAt(SPLIT_INSERT, 1, 'killed at a split insert');

    await fullSync('u');

    // The push threw, so this sync never pulled: the error is the thrown
    // message (a raw SQLite one on a device), and no pull stamped anything.
    expect(threw()).toBe(true);
    expect(getSyncSnapshot().lastError).toMatch(/killed at a split insert/);
    expect(ctx.meta.get('last_pull_attempt_at:u')).toBeUndefined();
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(localSplits('t1')).toEqual([]);

    // The next sync, whatever starts it: nothing to push, and its pull's
    // reconcile heals t1.
    await fullSync('u');

    expect(getSyncSnapshot().lastError).toBeNull();
    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('C4 (pin): a refresh that read everything leaves the key exactly as it found it', async () => {
    // P8's refresh: complete, so there is nothing for a reconcile to heal.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    const banked = bankedAnHourAgo();
    ctx.meta.set('last_txn_reconcile_at:u', banked);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });

    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBe(banked);
  });

  it('C5 (pin): with nothing set aside the push writes nothing to sync_meta', async () => {
    // Clocks in step: t1 is uploaded and marked in the loop, not set aside.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    const banked = bankedAnHourAgo();
    ctx.meta.set('last_txn_reconcile_at:u', banked);
    ctx.installSupabase({ serverNow: SERVER_AFTER });
    const metaWrites = runsOf(/\bsync_meta\b/);

    await pushChanges('u');

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_AFTER,
    });
    expect(metaWrites).toEqual([]);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBe(banked);
  });

  it('C6: a process killed at the first split insert runs nothing after it, and the pull at the next launch still heals the parent', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const kill = killAt(SPLIT_INSERT, 1);

    expect(await rejection(pushChanges('u'))).toMatch(/process killed/);
    expect(kill.fired()).toBe(true);

    kill.revive();
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(localSplits('t1')).toEqual([]);
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('C6b: a process killed right after the first mark, the earliest stop that leaves the drift, still leaves the next pull to heal it: the key was cleared before that mark', async () => {
    // The mark ran and nothing after it: synced with its own stamp over the
    // stale set, which only a reconcile heals.
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const kill = killAt(REFRESH_MARK, 1, { after: true });

    expect(await rejection(pushChanges('u'))).toMatch(/process killed/);
    expect(kill.fired()).toBe(true);

    kill.revive();
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });
    expect(localSplits('t1')).toEqual(['s1:synced', 's2:synced']);
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('C7: a pull whose reconcile cannot complete leaves the key cleared, and the pull after it heals the parent', async () => {
    await seedEditedT1(['s3', 's4'], ['s1', 's2']);
    ctx.installSupabase({
      serverNow: SERVER_BEHIND,
      errorReadsOn: new Set(['transaction_splits']),
    });
    await pushChanges('u');
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });

    // Every transaction read fails, the enumeration included: the pass does
    // not complete, so it heals nothing and banks nothing.
    ctx.installSupabase({
      serverNow: SERVER_BEHIND,
      errorReadsOn: new Set(['transactions']),
    });
    expect(await pullChanges('u')).toBe(false);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeUndefined();
    expect(localTxn('t1')).toEqual({ status: 'synced', updated_at: EDITED_AT });

    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t1')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t1')).toEqual(['s3:synced', 's4:synced']);
  });

  it('C8: a read that failed in one batch keeps the key cleared though a later batch reads', async () => {
    // 201 parents set aside: the first batch of 200 fails its read, the
    // second, t200 alone, reads and completes.
    const ids = Array.from(
      { length: 201 },
      (_, i) => `t${String(i).padStart(3, '0')}`
    );
    for (const id of ids) {
      await seedEdited(id, [`${id}-server`], [`${id}-stale`]);
    }
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const failed = failFirstSplitRead();

    await pushChanges('u');

    expect(failed()).toBe(true);
    expect(localTxn('t200')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t200')).toEqual(['t200-server:synced']);
    expect(localTxn('t000')).toEqual({
      status: 'synced',
      updated_at: EDITED_AT,
    });
    expect(localSplits('t000')).toEqual(['t000-stale:synced']);

    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t000')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t000')).toEqual(['t000-server:synced']);
    expect(localSplits('t199')).toEqual(['t199-server:synced']);
  });

  it('C8b: a read that fails in the last batch keeps the key cleared though an earlier batch completed', async () => {
    // C8 the other way round: the first batch of 200 reads and completes,
    // the second, t200 alone, fails its read. A key put back after the first
    // batch would leave t200 behind it for up to a day.
    const ids = Array.from(
      { length: 201 },
      (_, i) => `t${String(i).padStart(3, '0')}`
    );
    for (const id of ids) {
      await seedEdited(id, [`${id}-server`], [`${id}-stale`]);
    }
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    const failed = failSplitReadListing('t200');

    await pushChanges('u');

    expect(failed()).toBe(true);
    expect(localTxn('t000')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t000')).toEqual(['t000-server:synced']);
    expect(localTxn('t200')).toEqual({
      status: 'synced',
      updated_at: EDITED_AT,
    });
    expect(localSplits('t200')).toEqual(['t200-stale:synced']);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeUndefined();

    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    expect(await pullChanges('u')).toBe(true);

    expect(localTxn('t200')).toEqual({
      status: 'synced',
      updated_at: SERVER_BEHIND,
    });
    expect(localSplits('t200')).toEqual(['t200-server:synced']);
  });
});

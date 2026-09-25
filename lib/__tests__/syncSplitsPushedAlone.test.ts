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
// itself, after its loop. A failed read marks the parent synced WITHOUT the
// server's stamp, so the reconcile sees a drift and heals parent and splits
// together.
//
// Regression tests fail on the code before #112; the pins (N1-N4, F2) pass
// there too, and exist to fail on the wrong fix: a refresh on every push, one
// without a cursor, one that replaces a set this device changed, one that
// drops a split no push has sent, or one that overrides a local edit made
// mid-flight.
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

import { supabase } from '../supabase';
import { pullChanges, pushChanges } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalSplit,
  insertLocalTxn,
  remoteTxn,
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
async function edit(input: Omit<UpdateTransactionInput, 'accountId'>) {
  await applyTransactionUpdate(
    ctx.adapter as any,
    { accountId: 'a1', ...input },
    { now: EDITED_AT, newSplitId: () => 'unused' }
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
 * without touching its splits, so the push uploads it alone. The cursor is
 * CURSOR, and the reconcile was banked just now, so a pull is incremental
 * unless a test clears that key.
 */
async function seedEdited(id: string, serverSplits: string[], stale: string[]) {
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
  await edit({ id, payee: 'Edited' });
}

const seedEditedT1 = (serverSplits: string[], stale: string[]) =>
  seedEdited('t1', serverSplits, stale);

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
 * resolves: a known point inside the push.
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
    // cursor, so the pull does not list it, and the reconcile, due here, finds
    // the local and server stamps equal.
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

  it('F1: a failed split read marks the parent synced with its OWN stamp, and the next reconcile heals parent and splits together', async () => {
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

    // The reads work again, the server's clock still behind; the reconcile is
    // due.
    ctx.installSupabase({ serverNow: SERVER_BEHIND });
    ctx.meta.delete('last_txn_reconcile_at:u');
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

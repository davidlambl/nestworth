// refreshSplitsFromServer (#21): what realtime does once a split event names
// a parent -- read the parent's whole set from the server again and write it
// in place of this device's synced copy, under the pull's rules and one more
// (never over the reconcile's placeholder stamp). Driven through the
// fixture's real SQLite adapter and fake PostgREST, with the read's round
// trip opened up (duringSplitRead) to land the writes that can race it:
// a local edit, the reconcile's placeholder, a tombstone, an account switch,
// this device's own push.
//
// A new export, so nothing here loads on 112b060: the red proofs are
// mutants of the production code (the pull request's mutant table).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { supabase } from '../supabase';
import {
  fullSync,
  initialPull,
  pullChanges,
  pushChanges,
  refreshSplitsFromServer,
  wipeLocalData,
} from '../sync';
import { deleteLocalTransactionIfSynced } from '../tombstones';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

let f: ReturnType<typeof wireSyncMocks>;
let splitReads: number;

beforeEach(() => {
  f = wireSyncMocks();
  // This device has pulled before: a split refresh waits for its first
  // download otherwise (S19).
  f.meta.set('last_pull_at:u', '2026-10-20T00:00:00.000Z');
  splitReads = 0;
  countSplitReads();
});

afterEach(() => {
  jest.restoreAllMocks();
  f.adapter._sqlite.close();
});

const AT = '2026-10-20T10:00:00.000000+00:00';

const serverSplit = (s: any) => ({
  id: s.id,
  transaction_id: s.transaction_id ?? 't1',
  category_id: null,
  amount: s.amount ?? 0,
  memo: s.memo ?? null,
  updated_at: s.updated_at ?? AT,
});

const splits = () =>
  (
    f.adapter._sqlite
      .prepare(
        'SELECT id, transaction_id, amount, _sync_status FROM transaction_splits ORDER BY id'
      )
      .all() as any[]
  ).map((s) => `${s.id}@${s.transaction_id}:${s.amount}:${s._sync_status}`);

/** Counts the split reads that reach the fake (`.range()` calls). */
function countSplitReads() {
  const from = (supabase as any).from;
  (supabase as any).from = (table: string) => {
    const builder = from(table);
    if (table === 'transaction_splits') {
      const range = builder.range;
      builder.range = (a: number, b: number) => {
        splitReads++;
        return range(a, b);
      };
    }
    return builder;
  };
}

/**
 * Runs `during` once, inside the first split read's round trip: after the
 * server has taken its snapshot (the fake computes the page when `.range()`
 * is called), before the answer reaches the client.
 */
function duringSplitRead(during: () => unknown) {
  const from = (supabase as any).from;
  let ran = false;
  (supabase as any).from = (table: string) => {
    const builder = from(table);
    if (table === 'transaction_splits') {
      const range = builder.range;
      builder.range = async (a: number, b: number) => {
        const answer = await range(a, b);
        if (!ran) {
          ran = true;
          await during();
        }
        return answer;
      };
    }
    return builder;
  };
}

/** t1, synced here at AT with s1; on the server, re-split into s2 and s3. */
async function seedResplit() {
  await insertLocalTxn(f.adapter, { id: 't1', updated_at: AT });
  await insertLocalSplit(f.adapter, {
    id: 's1',
    transaction_id: 't1',
    amount: -10,
    updated_at: AT,
  });
  f.store.transactions.push(remoteTxn({ id: 't1', updated_at: AT }));
  f.store.transaction_splits.push(
    serverSplit({ id: 's2', amount: -4 }),
    serverSplit({ id: 's3', amount: -6 })
  );
}

describe('refreshSplitsFromServer (#21)', () => {
  it("S1: writes another device's set in place of this device's, and reports the parent", async () => {
    await seedResplit();

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ splits: splits(), result }).toEqual({
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      result: { changed: [{ id: 't1', accountId: 'a1' }], error: null },
    });
  });

  it('S1b: a split the server kept is rewritten with its new values, not deleted', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      amount: -10,
      updated_at: AT,
    });
    f.store.transaction_splits.push(
      serverSplit({ id: 's1', amount: -7 }),
      serverSplit({ id: 's2', amount: -3 })
    );

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect(splits()).toEqual(['s1@t1:-7:synced', 's2@t1:-3:synced']);
  });

  // sameSplitSet compares each field: three parents, each differing from
  // the server in one field of one split only (same ids throughout).
  it('S1c: a set that differs only in an amount, a memo or a split stamp is rewritten', async () => {
    for (const t of ['t1', 't2', 't3']) {
      await insertLocalTxn(f.adapter, { id: t, updated_at: AT });
    }
    await insertLocalSplit(f.adapter, {
      id: 'a1s',
      transaction_id: 't1',
      amount: -10,
      updated_at: AT,
    });
    await insertLocalSplit(f.adapter, {
      id: 'm2s',
      transaction_id: 't2',
      amount: -5,
      memo: 'old',
      updated_at: AT,
    });
    // A split the local migration 2 could not stamp (#20).
    await insertLocalSplit(f.adapter, {
      id: 'u3s',
      transaction_id: 't3',
      amount: -1,
      updated_at: null,
    });
    f.store.transaction_splits.push(
      serverSplit({ id: 'a1s', transaction_id: 't1', amount: -9 }),
      serverSplit({ id: 'm2s', transaction_id: 't2', amount: -5, memo: 'new' }),
      serverSplit({ id: 'u3s', transaction_id: 't3', amount: -1 })
    );

    const result = await refreshSplitsFromServer(f.adapter, 'u', [
      't1',
      't2',
      't3',
    ]);

    expect({
      rows: f.adapter._sqlite
        .prepare(
          'SELECT id, amount, memo, updated_at FROM transaction_splits ORDER BY id'
        )
        .all(),
      changed: result.changed.map((c) => c.id),
    }).toEqual({
      rows: [
        { id: 'a1s', amount: -9, memo: null, updated_at: AT },
        { id: 'm2s', amount: -5, memo: 'new', updated_at: AT },
        { id: 'u3s', amount: -1, memo: null, updated_at: AT },
      ],
      changed: ['t1', 't2', 't3'],
    });
  });

  it("S2: the echo of this device's own split push writes nothing", async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: AT });
    for (const s of [
      { id: 's2', amount: -4 },
      { id: 's3', amount: -6, memo: 'tip' },
    ]) {
      await insertLocalSplit(f.adapter, {
        ...s,
        transaction_id: 't1',
        updated_at: AT,
      });
      f.store.transaction_splits.push(serverSplit(s));
    }
    const writes: string[] = [];
    const run = f.adapter.runAsync;
    f.adapter.runAsync = async (sql: string, params?: any[]) => {
      writes.push(sql);
      return run(sql, params);
    };

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ writes, result, splits: splits() }).toEqual({
      writes: [],
      result: { changed: [], error: null },
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
    });
  });

  it('S3: a parent pending here (its own edit) is not read, and keeps its splits', async () => {
    await insertLocalTxn(f.adapter, {
      id: 't1',
      updated_at: AT,
      _sync_status: 'pending',
    });
    await insertLocalSplit(f.adapter, {
      id: 's9',
      transaction_id: 't1',
      _sync_status: 'pending',
    });
    f.store.transaction_splits.push(serverSplit({ id: 's2' }));

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ reads: splitReads, splits: splits(), result }).toEqual({
      reads: 0,
      splits: ['s9@t1:0:pending'],
      result: { changed: [], error: null },
    });
  });

  it("S4: a parent at the reconcile's placeholder is not read", async () => {
    await seedResplit();
    f.adapter._sqlite
      .prepare("UPDATE transactions SET updated_at = '' WHERE id = 't1'")
      .run();

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ reads: splitReads, splits: splits() }).toEqual({
      reads: 0,
      splits: ['s1@t1:-10:synced'],
    });
  });

  // The reconcile is not held off by realtime, nor realtime by the lock: the
  // reconcile's fields write can put the parent at the placeholder while the
  // refresh's read is out (#136). The statements refuse it themselves.
  it("S5: the reconcile's placeholder landing during the read refuses every write", async () => {
    await seedResplit();
    duringSplitRead(() =>
      f.adapter._sqlite
        .prepare("UPDATE transactions SET updated_at = '' WHERE id = 't1'")
        .run()
    );

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ splits: splits(), result }).toEqual({
      splits: ['s1@t1:-10:synced'],
      result: { changed: [], error: null },
    });
  });

  // #125's in-statement guard, met by realtime: a re-split made here while
  // the read is out keeps only its own set.
  it('S6: a local re-split landing during the read keeps its own set', async () => {
    await seedResplit();
    duringSplitRead(async () => {
      f.adapter._sqlite
        .prepare(
          "UPDATE transactions SET _sync_status = 'pending', updated_at = '2026-10-21T00:00:00Z' WHERE id = 't1'"
        )
        .run();
      f.adapter._sqlite
        .prepare(
          "UPDATE transaction_splits SET _sync_status = 'deleted' WHERE transaction_id = 't1'"
        )
        .run();
      await insertLocalSplit(f.adapter, {
        id: 's8',
        transaction_id: 't1',
        amount: -10,
        _sync_status: 'pending',
      });
    });

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect(splits()).toEqual(['s1@t1:-10:deleted', 's8@t1:-10:pending']);
  });

  it("S7: a parent this device does not hold, or holds as another account's, is not read", async () => {
    await insertLocalTxn(f.adapter, {
      id: 'tx',
      user_id: 'other',
      updated_at: AT,
    });
    f.store.transaction_splits.push(
      serverSplit({ id: 's2', transaction_id: 'nowhere' }),
      serverSplit({ id: 's3', transaction_id: 'tx' })
    );

    const result = await refreshSplitsFromServer(f.adapter, 'u', [
      'nowhere',
      'tx',
    ]);

    expect({ reads: splitReads, splits: splits(), result }).toEqual({
      reads: 0,
      splits: [],
      result: { changed: [], error: null },
    });
  });

  it('S8: a failed read writes nothing, is warned, and is returned', async () => {
    await seedResplit();
    f.installSupabase({ errorReadsOn: new Set(['transaction_splits']) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({
      splits: splits(),
      changed: result.changed,
      error: result.error?.message,
      warned: warn.mock.calls.map((c) => String(c[0])),
    }).toEqual({
      splits: ['s1@t1:-10:synced'],
      changed: [],
      error: 'network unreachable',
      warned: [
        '[realtime] split refresh failed for 1 transaction(s); the next pull reads them:',
      ],
    });
  });

  // #111's third rule, met by realtime: the read is out when another account
  // signs in on the device. Its next page is answered as the new account's
  // -- empty -- and fails, so the previous account's sets are never emptied.
  it('S9: an account switched during the read writes nothing', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      amount: -10,
      updated_at: AT,
    });
    // The server holds no split for t1 any more: the read's first page is
    // the empty one, which asks the session who it is.
    duringSplitRead(() => f.installSupabase({ sessionUserId: 'v' }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ splits: splits(), error: String(result.error) }).toEqual({
      splits: ['s1@t1:-10:synced'],
      error: 'NoSessionError: your sign-in belongs to a different account',
    });
  });

  it('S10: a parent whose splits were all removed on the server loses its synced ones, never an unsynced one', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      updated_at: AT,
    });
    await insertLocalSplit(f.adapter, {
      id: 's7',
      transaction_id: 't1',
      _sync_status: 'pending',
    });

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ splits: splits(), changed: result.changed }).toEqual({
      splits: ['s7@t1:0:pending'],
      changed: [{ id: 't1', accountId: 'a1' }],
    });
  });

  // The tombstone consumer is realtime too, and nothing orders the two: a
  // delete made elsewhere, consumed while the read is out, leaves no split
  // behind (the INSERTs need a synced parent, and there is none).
  it('S11: a tombstone consumed during the read leaves no orphan split', async () => {
    await seedResplit();
    duringSplitRead(() => deleteLocalTransactionIfSynced(f.adapter, 't1'));

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({
      splits: splits(),
      parents: f.adapter._sqlite.prepare('SELECT id FROM transactions').all(),
    }).toEqual({ splits: [], parents: [] });
  });

  it('S12: a synced parent with no stamp at all is still refreshed (IS NOT is NULL-safe)', async () => {
    await seedResplit();
    f.adapter._sqlite
      .prepare("UPDATE transactions SET updated_at = NULL WHERE id = 't1'")
      .run();

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect(splits()).toEqual(['s2@t1:-4:synced', 's3@t1:-6:synced']);
  });

  it('S13: of two parents named together, a pending one is left to its push', async () => {
    await seedResplit();
    await insertLocalTxn(f.adapter, {
      id: 't2',
      updated_at: AT,
      _sync_status: 'pending',
    });
    f.store.transaction_splits.push(
      serverSplit({ id: 's5', transaction_id: 't2' })
    );

    const result = await refreshSplitsFromServer(f.adapter, 'u', [
      't1',
      't2',
      't1',
    ]);

    expect({
      splits: splits(),
      changed: result.changed,
      reads: splitReads,
    }).toEqual({
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      changed: [{ id: 't1', accountId: 'a1' }],
      // One page with rows, then the empty page that ends the read.
      reads: 2,
    });
  });

  // This device re-splits t1 and pushes it while a refresh's read, answered
  // with the server's set from before that push, is still out. With only
  // the pull's condition (the parent synced) the read's set lands over the
  // pushed one -- the parent is synced again once the push has marked it --
  // and only a later read, the push's own INSERT echo, puts it back
  // (measured on the first draft). The stamp the parent held before the
  // read refuses it: the push's mark adopted the server's, so nothing of
  // the old set is written, and the parent, still synced at another stamp,
  // is read again in the same call.
  it("S14: a read answered before this device's own split push never writes over the pushed set", async () => {
    await seedResplit();
    const inserted: string[] = [];
    duringSplitRead(async () => {
      // The local re-split (transactionUpdate's shape), then its push.
      f.adapter._sqlite
        .prepare(
          "UPDATE transactions SET _sync_status = 'pending', updated_at = '2026-10-21T00:00:00.000Z' WHERE id = 't1'"
        )
        .run();
      f.adapter._sqlite
        .prepare(
          "UPDATE transaction_splits SET _sync_status = 'deleted', updated_at = '2026-10-21T00:00:00.000Z' WHERE transaction_id = 't1'"
        )
        .run();
      await insertLocalSplit(f.adapter, {
        id: 's8',
        transaction_id: 't1',
        amount: -10,
        updated_at: '2026-10-21T00:00:00.000Z',
        _sync_status: 'pending',
      });
      await pushChanges('u');
      // From here on, record the split rows the refresh actually writes (an
      // INSERT it attempts and the guard refuses changes nothing).
      const run = f.adapter.runAsync;
      f.adapter.runAsync = async (sql: string, params: any[] = []) => {
        const res = await run(sql, params);
        if (/^\s*INSERT INTO transaction_splits/.test(sql) && res.changes) {
          inserted.push(params[0]);
        }
        return res;
      };
    });

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({
      server: f.store.transaction_splits.map((s) => s.id),
      local: splits(),
      inserted,
      changed: result.changed,
      reads: splitReads,
    }).toEqual({
      server: ['s8'],
      local: ['s8@t1:-10:synced'],
      inserted: [],
      changed: [],
      // The stale read (a page, the empty page), then the second read, of
      // the pushed set, which is already this device's (a page, the empty).
      reads: 4,
    });
  });

  it('S15: a parent that keeps changing under its read is read three times, then left to the pull', async () => {
    await seedResplit();
    let n = 0;
    // Every read is answered while the parent takes a newer stamp (a pull's
    // upsert, another event): each set read is refused.
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const answer = await range(a, b);
          n++;
          f.adapter._sqlite
            .prepare('UPDATE transactions SET updated_at = ? WHERE id = ?')
            .run(`2026-10-21T00:00:0${n}.000Z`, 't1');
          return answer;
        };
      }
      return builder;
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({
      reads: n,
      local: splits(),
      changed: result.changed,
      error: result.error,
      warned: warn.mock.calls.map((c) => String(c[0])),
    }).toEqual({
      // Three reads, each a page with the rows and the empty page ending it.
      reads: 6,
      local: ['s1@t1:-10:synced'],
      changed: [],
      error: null,
      warned: [
        '[realtime] 1 transaction(s) kept changing during their split refresh; the next pull reads them',
      ],
    });
  });

  // The cap's other end (the killer of the moved-on check without its
  // placeholder test): a parent that moved on under its first two reads and
  // is at the reconcile's placeholder after its third is the reconcile's to
  // write, not "kept changing": nothing is warned, and no fourth read is
  // made.
  it('S15b: a parent at the placeholder after its last read is left to the reconcile, unwarned', async () => {
    await seedResplit();
    let n = 0;
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const answer = await range(a, b);
          if (a === 0) {
            n++;
            f.adapter._sqlite
              .prepare('UPDATE transactions SET updated_at = ? WHERE id = ?')
              .run(n < 3 ? `2026-10-21T00:00:0${n}.000Z` : '', 't1');
          }
          return answer;
        };
      }
      return builder;
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({
      reads: n,
      local: splits(),
      warned: warn.mock.calls.length,
    }).toEqual({
      reads: 3,
      local: ['s1@t1:-10:synced'],
      warned: 0,
    });
  });

  // The parent changes between the refresh's own statements: its synced
  // splits are deleted, then a newer version of it (realtime's parent
  // upsert) lands, and the INSERTs refuse the set read before it. The
  // parent is read again, and its set written whole.
  it('S16: a parent that changes between the DELETE and the INSERTs is read again and written whole', async () => {
    await seedResplit();
    const run = f.adapter.runAsync;
    let landed = false;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (!landed && /^\s*DELETE FROM transaction_splits/.test(sql)) {
        landed = true;
        await run('UPDATE transactions SET updated_at = ? WHERE id = ?', [
          '2026-10-22T00:00:00+00:00',
          't1',
        ]);
      }
      return res;
    };

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ local: splits(), changed: result.changed }).toEqual({
      local: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      changed: [{ id: 't1', accountId: 'a1' }],
    });
  });
  // PIN of the wipe and its re-download as they stand on main (the split is
  // written with insertLocalSplit; the refresh is never called, so this is
  // green before #21 too). A synced split landing between the wipe's split
  // DELETE and its transactions DELETE, under a parent still synced there,
  // outlives the parent (the wipe's split DELETE has run), and the
  // re-download's split refresh replaces it once the parent is back (its
  // DELETE takes every synced split of the parent); were the re-download to
  // fail, the launch sweep takes it (sweepOrphanSyncedSplits, #137).
  // Realtime's own refresh cannot land there: the reset holds the sync lock,
  // which the refresh waits for (S23, S24).
  it('S17: a synced split left by the wipe under its parent is replaced by the re-download', async () => {
    await insertLocalAccount(f.adapter, { id: 'a1', updated_at: AT });
    await seedResplit();
    f.store.accounts.push(remoteAccount({ id: 'a1', updated_at: AT }));
    const run = f.adapter.runAsync;
    let landed = false;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (
        !landed &&
        /^\s*DELETE FROM transaction_splits\s+WHERE _sync_status = 'synced'/.test(
          sql
        )
      ) {
        landed = true;
        // A server split written under t1, still synced: one of a set the
        // server has replaced since (sz is not in s2, s3).
        await insertLocalSplit(f.adapter, {
          id: 'sz',
          transaction_id: 't1',
          amount: -1,
          updated_at: AT,
        });
      }
      return res;
    };

    await wipeLocalData(f.adapter, 'u');
    const afterWipe = {
      parents: f.adapter._sqlite.prepare('SELECT id FROM transactions').all(),
      splits: splits(),
    };
    f.adapter.runAsync = run;
    await pullChanges('u');

    expect({ afterWipe, afterPull: splits() }).toEqual({
      afterWipe: { parents: [], splits: ['sz@t1:-1:synced'] },
      afterPull: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
    });
  });
  // PIN (#137's third statement, now also for realtime's own refresh): the
  // refresh and the tombstone consumer both run on realtime, unordered. A
  // split the refresh writes between the consumer's split DELETE and its
  // parent DELETE (the parent is still synced, at the stamp the refresh
  // read) is deleted by the consumer's third statement. Red with that
  // statement removed.
  it("S18: a split the refresh writes between the tombstone consumer's two DELETEs does not outlive the parent", async () => {
    await seedResplit();
    const run = f.adapter.runAsync;
    let landed = false;
    let midway: string[] = [];
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (
        !landed &&
        /^\s*DELETE FROM transaction_splits WHERE transaction_id = \?\s+AND EXISTS \(SELECT 1 FROM transactions\s+WHERE id = \? AND _sync_status = 'synced'\)/.test(
          sql
        )
      ) {
        landed = true;
        await refreshSplitsFromServer(f.adapter, 'u', ['t1']);
        midway = splits();
      }
      return res;
    };

    await deleteLocalTransactionIfSynced(f.adapter, 't1');

    expect({
      midway,
      splits: splits(),
      parents: f.adapter._sqlite.prepare('SELECT id FROM transactions').all(),
    }).toEqual({
      midway: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      splits: [],
      parents: [],
    });
  });
  // initialPull's loop writes the server's splits without deleting first:
  // it is written for an empty store (#96, #113). A set realtime wrote under
  // a parent the loop had already read would stay beside the loop's older
  // one. So realtime writes no split until this device's first download
  // has stamped its keys.
  it('S19: nothing is read or written while this device has never pulled', async () => {
    await seedResplit();
    f.meta.clear();

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);

    expect({ reads: splitReads, splits: splits(), result }).toEqual({
      reads: 0,
      splits: ['s1@t1:-10:synced'],
      result: { changed: [], error: null },
    });
  });
  // S19's reason, measured through initialPull. A first download has read
  // t1's splits (s1); before it writes them, another device re-splits t1
  // (s2, s3) and realtime's refresh starts. Had it written s2 and s3 then,
  // the loop's s1 would land beside them, a duplicate set: measured on the
  // draft without the check, which left s1, s2 and s3. The download holds
  // the sync lock, so the refresh waits for it, then reads and writes the
  // set the re-split left.
  it("S20: a re-split made elsewhere during this device's first download never doubles the set", async () => {
    f.meta.clear();
    f.store.accounts.push(remoteAccount({ id: 'a1', updated_at: AT }));
    f.store.transactions.push(remoteTxn({ id: 't1', updated_at: AT }));
    f.store.transaction_splits.push(serverSplit({ id: 's1', amount: -10 }));
    const run = f.adapter.runAsync;
    let landed = false;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      if (!landed && /^\s*INSERT INTO transaction_splits/.test(sql)) {
        landed = true;
        // The re-split, as the other device's push leaves the server, then
        // the refresh its events start.
        const later = '2099-01-01T00:00:00.000000+00:00';
        f.store.transactions[0] = {
          ...f.store.transactions[0],
          updated_at: later,
        };
        f.store.transaction_splits.splice(
          0,
          1,
          serverSplit({ id: 's2', amount: -4, updated_at: later }),
          serverSplit({ id: 's3', amount: -6, updated_at: later })
        );
        // Not awaited: the download waits for nothing of realtime's.
        refreshed = refreshSplitsFromServer(f.adapter, 'u', ['t1']);
      }
      return run(sql, params);
    };
    let refreshed: Promise<any> | null = null;

    await initialPull('u');
    const result = await refreshed;
    const afterRefresh = splits();
    f.adapter.runAsync = run;
    await pullChanges('u');

    expect({ landed, result, afterRefresh, afterPull: splits() }).toEqual({
      landed: true,
      result: { changed: [{ id: 't1', accountId: 'a1' }], error: null },
      afterRefresh: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      afterPull: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
    });
  });
  // P6 (sync-engine.md, #110): the refresh's statements are plain, so they
  // join whatever transaction a hook has open on the shared connection, and
  // SQLite abandoning that transaction on a storage failure (a full disk, an
  // I/O error) undoes what joined it. Modelled here by a hook transaction
  // that throws right after the refresh's DELETE joined it: the DELETE is
  // rolled back, the INSERTs after it commit on their own, and t1 holds its
  // old split beside the server's set at the stamp its own event gave it.
  // Measured, not closed: the next pull lists t1 when another device's
  // write stamped it after this device's previous pull began, and its
  // refresh replaces the set; a refresh by realtime does too, on t1's next
  // split event.
  it('S21: a storage failure undoing the refresh DELETE leaves the old split beside the new set, which the next pull replaces', async () => {
    await seedResplit();
    f.store.transactions[0] = {
      ...f.store.transactions[0],
      updated_at: '2099-01-01T00:00:00.000000+00:00',
    };
    f.meta.set('last_txn_pull_at:u', '2026-10-20T00:00:00.000Z');
    let fail: () => void = () => {};
    const failed = new Promise<void>((resolve) => (fail = resolve));
    const hook = f.adapter
      .withTransactionAsync(async () => {
        await failed;
        throw new Error('disk I/O error');
      })
      .catch(() => {});
    const run = f.adapter.runAsync;
    let rolledBack = false;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (!rolledBack && /^\s*DELETE FROM transaction_splits/.test(sql)) {
        rolledBack = true;
        fail();
        await hook;
      }
      return res;
    };

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);
    const afterRollback = splits();
    f.adapter.runAsync = run;
    await pullChanges('u');

    expect({ afterRollback, afterPull: splits() }).toEqual({
      afterRollback: ['s1@t1:-10:synced', 's2@t1:-4:synced', 's3@t1:-6:synced'],
      afterPull: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
    });
  });
  // The stamp guard's own residue, measured: a parent whose stamp changes
  // between the refresh's DELETE and its INSERTs on every one of its three
  // reads is left with no synced split (each DELETE ran, each set of INSERTs
  // was refused), warned, for the next pull -- which lists it when its newest
  // stamp is later than the pull's cursor (here: yes) and writes its set.
  // Each window is a few local statements wide; three in a row is not a
  // pattern any writer produces, but the state it leaves is stated.
  it('S22: a parent changing inside every one of its three DELETE-then-INSERT windows is left split-less for the next pull', async () => {
    await seedResplit();
    f.store.transactions[0] = {
      ...f.store.transactions[0],
      updated_at: '2099-01-01T00:00:00.000000+00:00',
    };
    f.meta.set('last_txn_pull_at:u', '2026-10-20T00:00:00.000Z');
    const run = f.adapter.runAsync;
    let n = 0;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (/^\s*DELETE FROM transaction_splits/.test(sql)) {
        n++;
        await run('UPDATE transactions SET updated_at = ? WHERE id = ?', [
          `2026-10-2${n}T00:00:00+00:00`,
          't1',
        ]);
      }
      return res;
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSplitsFromServer(f.adapter, 'u', ['t1']);
    const afterRefresh = splits();
    f.adapter.runAsync = run;
    await pullChanges('u');

    expect({
      deletes: n,
      afterRefresh,
      warned: warn.mock.calls.length,
      afterPull: splits(),
    }).toEqual({
      deletes: 3,
      afterRefresh: [],
      warned: 1,
      afterPull: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
    });
  });

  // Found by the sync attack on the design: two replacers with different reads
  // interleave into the union of both sets. Here the refresh's read (s1,
  // answered after the other device's parent upsert, before its split DELETE)
  // comes back while the pull's step 3, which read the re-split set (s2, s3),
  // is between its DELETE and its INSERTs. The refresh, not taking the lock,
  // wrote s1 into that window: s1, s2 and s3. It never writes beside a sync: it
  // reads t1 again once the sync is done, and finds the set step 3 wrote.
  it('S23: a refresh whose read comes back during a sync never writes beside it', async () => {
    await insertLocalAccount(f.adapter, { id: 'a1', updated_at: AT });
    f.store.accounts.push(remoteAccount({ id: 'a1', updated_at: AT }));
    const X1 = '2026-10-21T10:00:00.000000+00:00';
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: X1 });
    await insertLocalSplit(f.adapter, {
      id: 's0',
      transaction_id: 't1',
      amount: -10,
      updated_at: AT,
    });
    f.store.transactions.push(remoteTxn({ id: 't1', updated_at: X1 }));
    f.store.transaction_splits.push(serverSplit({ id: 's1', amount: -10 }));
    // Step 1 lists t1 (its stamp is later than the cursor); no reconcile.
    f.meta.set('last_txn_pull_at:u', '2026-10-21T00:00:00.000Z');
    f.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    // The refresh's read: its page is computed when it is sent, and its
    // answer held until step 3 has deleted t1's splits.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let sent: () => void = () => {};
    const readSent = new Promise<void>((r) => (sent = r));
    const from = (supabase as any).from;
    let gated = false;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits' && !gated) {
        gated = true;
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const answer = await range(a, b);
          sent();
          await held;
          return answer;
        };
      }
      return builder;
    };
    const run = f.adapter.runAsync;
    let settled = false;
    f.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (
        params.length === 1 &&
        /^\s*DELETE FROM transaction_splits WHERE transaction_id = \? AND _sync_status = 'synced'/.test(
          sql
        )
      ) {
        release();
        // Room for the refresh to write here, as it did before the lock.
        for (let i = 0; i < 50 && !settled; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return res;
    };

    const refreshed = refreshSplitsFromServer(f.adapter, 'u', ['t1']).then(
      (r) => {
        settled = true;
        return r;
      }
    );
    await readSent;
    // The other device's split DELETE and INSERT; then this device's sync.
    f.store.transaction_splits.splice(
      0,
      1,
      serverSplit({ id: 's2', amount: -4, updated_at: X1 }),
      serverSplit({ id: 's3', amount: -6, updated_at: X1 })
    );
    await fullSync('u');
    const result = await refreshed;

    expect({ splits: splits(), changed: result.changed }).toEqual({
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      changed: [],
    });
  });

  // The lock wait itself: a refresh deferred because a sync took
  // the lock during its read reads again only once that sync is done, so a
  // long sync does not use up its reads. Here the sync does not list t1
  // (its stamp is older than the cursor): only the refresh can write the
  // set another device left.
  it('S24: a refresh deferred by a sync reads again once the sync is done', async () => {
    await seedResplit();
    f.meta.set('last_txn_pull_at:u', '2026-10-21T00:00:00.000Z');
    f.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    let releaseRead: () => void = () => {};
    const readHeld = new Promise<void>((r) => (releaseRead = r));
    let sent: () => void = () => {};
    const readSent = new Promise<void>((r) => (sent = r));
    let releaseSync: () => void = () => {};
    const syncHeld = new Promise<void>((r) => (releaseSync = r));
    const from = (supabase as any).from;
    let gated = false;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits' && !gated) {
        gated = true;
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const answer = await range(a, b);
          sent();
          await readHeld;
          return answer;
        };
      }
      if (table === 'accounts') {
        // The sync's pull, held at its first read: the lock stays taken.
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          await syncHeld;
          return range(a, b);
        };
      }
      return builder;
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const refreshed = refreshSplitsFromServer(f.adapter, 'u', ['t1']);
    await readSent;
    const sync = fullSync('u');
    releaseRead();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const whileSyncing = splits();
    releaseSync();
    await sync;
    const result = await refreshed;

    expect({
      whileSyncing,
      splits: splits(),
      changed: result.changed,
      warned: warn.mock.calls.map((c) => String(c[0])),
    }).toEqual({
      whileSyncing: ['s1@t1:-10:synced'],
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      changed: [{ id: 't1', accountId: 'a1' }],
      warned: [],
    });
  });

  /**
   * Starts a sync inside each of the first `syncs` split reads (after the
   * server has answered, before the answer reaches the refresh), none of
   * them listing t1: its stamp is older than the cursor, and no reconcile is
   * due. Returns the count of reads (first pages) and the syncs started.
   */
  function syncDuringReads(syncs: number) {
    f.meta.set('last_txn_pull_at:u', '2026-10-21T00:00:00.000Z');
    f.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    const seen = { reads: 0, syncs: [] as Promise<void>[] };
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const answer = await range(a, b);
          if (a === 0 && ++seen.reads <= syncs) {
            seen.syncs.push(fullSync('u'));
          }
          return answer;
        };
      }
      return builder;
    };
    return seen;
  }

  const realtimeWarnings = (warn: jest.SpyInstance) =>
    warn.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.startsWith('[realtime]'));

  // A sync starting during a read is no change to the parent, and the read
  // made once that sync is done is not one of the parent's three. Found by
  // the review of the lock wait: three syncs, each starting inside a read,
  // used up the three reads, warned "kept changing" of a parent that never
  // changed, and left the set another device made, which the syncs' pulls do
  // not list. Here the fourth read writes it.
  it("S25: reads a sync began during are not counted among a parent's three", async () => {
    await seedResplit();
    const seen = syncDuringReads(3);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);
    await Promise.all(seen.syncs);

    expect({
      reads: seen.reads,
      splits: splits(),
      changed: result.changed,
      warned: realtimeWarnings(warn),
    }).toEqual({
      reads: 4,
      splits: ['s2@t1:-4:synced', 's3@t1:-6:synced'],
      changed: [{ id: 't1', accountId: 'a1' }],
      warned: [],
    });
  });

  // Their bound: a parent whose every read a sync began during is left after
  // ten of them (REALTIME_SPLIT_DEFERRALS), and warned as such.
  it('S26: a parent whose every read a sync began during is left after ten reads, and warned', async () => {
    await seedResplit();
    const seen = syncDuringReads(10);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ['t1']);
    await Promise.all(seen.syncs);

    expect({
      reads: seen.reads,
      splits: splits(),
      changed: result.changed,
      warned: realtimeWarnings(warn),
    }).toEqual({
      reads: 10,
      splits: ['s1@t1:-10:synced'],
      changed: [],
      warned: [
        '[realtime] 1 transaction(s) left unrefreshed: a sync kept starting during their split reads; the next pull that lists them reads them',
      ],
    });
  });

  // PIN (green before S25's fix too, which counted reads by round): the
  // counts are per parent. A sync beginning during one read of many parents
  // costs each of them one read, not the batch's ten.
  it('S27: a sync beginning during one read of ten parents costs each of them one read', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
    for (const id of ids) {
      await insertLocalTxn(f.adapter, { id, updated_at: AT });
      await insertLocalSplit(f.adapter, {
        id: `s-${id}`,
        transaction_id: id,
        amount: -10,
        updated_at: AT,
      });
      f.store.transactions.push(remoteTxn({ id, updated_at: AT }));
      f.store.transaction_splits.push(
        serverSplit({ id: `r-${id}`, transaction_id: id, amount: -4 })
      );
    }
    const seen = syncDuringReads(1);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshSplitsFromServer(f.adapter, 'u', ids);
    await Promise.all(seen.syncs);

    expect({
      reads: seen.reads,
      changed: result.changed.length,
      left: splits().filter((s) => s.startsWith('s-')),
      written: splits().filter((s) => s.startsWith('r-')).length,
      warned: realtimeWarnings(warn),
    }).toEqual({ reads: 2, changed: 10, left: [], written: 10, warned: [] });
  });
});

// Push-path split sync (#20).
//
// Splits are uploaded delete-then-reinsert and then marked 'synced'. That last
// step used to be `WHERE transaction_id = ?` and nothing else, because splits
// had no per-row timestamp to compare — so it could not tell the rows it had
// just uploaded from rows an edit had put in their place, and a split edit that
// landed during the round trip was marked 'synced' unsent and never replayed.
// These tests pin the guard that closes it, the read-back that feeds it, and
// the error path that says so when the server has not been migrated.
//
// Mocks must be declared before importing '../sync' (and before the fixture,
// which imports the same two modules) so their top-level
// `import { supabase } from './supabase'` / `import { getDb } from './db'`
// resolve to these stubs (and never pull native expo-sqlite / the real client).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { supabase } from '../supabase';
import { fullSync, pushChanges } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
  remoteTxn,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

/** What the server's BEFORE UPDATE trigger stamps, in PostgREST's rendering. */
const SERVER_NOW = '2026-06-01T12:00:00+00:00';
/** The local timestamp on the rows this push uploads. */
const LOCAL_AT = '2026-05-01T00:00:00Z';
/** A later local edit, landing mid-push. */
const EDITED_AT = '2026-05-02T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let installSupabase: ReturnType<typeof wireSyncMocks>['installSupabase'];

beforeEach(() => {
  ({ adapter, store, installSupabase } = wireSyncMocks());
  // The error channel is module-level state shared by every suite in this
  // worker; a stale value would make the missing-migration test pass for free.
  setLastError(null);
});

afterEach(() => {
  adapter._sqlite.close();
  setLastError(null);
});

const localSplits = async (txnId: string) =>
  (await adapter.getAllAsync(
    'SELECT * FROM transaction_splits WHERE transaction_id = ? ORDER BY id',
    [txnId]
  )) as any[];

/** A pending transaction with one pending split, both already on the server. */
async function seedPendingTxnWithSplit(splitUpdatedAt: string | null) {
  store.transactions = [remoteTxn({ id: 'T1', updated_at: LOCAL_AT })];
  store.transaction_splits = [];
  await insertLocalTxn(adapter, {
    id: 'T1',
    updated_at: LOCAL_AT,
    _sync_status: 'pending',
  });
  await insertLocalSplit(adapter, {
    id: 's1',
    transaction_id: 'T1',
    amount: -20,
    memo: 'Half',
    updated_at: splitUpdatedAt,
    _sync_status: 'pending',
  });
}

/**
 * Runs `mutate` once, after the server has accepted the split INSERT but before
 * `pushChanges` sees the reply — i.e. exactly the window a local split edit has
 * to land in. Wraps the fake's builder by hand (precedent:
 * syncPushTombstones.test.ts) rather than adding another fixture option.
 *
 * Both the `.select()` reply and the bare thenable are wrapped, because the
 * caller awaits one or the other. That matters for the proof rather than for
 * the fix: hooking only `.select()` would make this test red against a build
 * that does not read the rows back for the trivial reason that the hook never
 * fired, instead of showing what such a build does to the edit.
 */
function onSplitInsert(
  fake: { from: (t: string) => any },
  mutate: () => Promise<void>
) {
  let fired = false;
  const once = async () => {
    if (fired) return;
    fired = true;
    await mutate();
  };
  const afterSettling = (thenable: any) => {
    const settle = thenable.then;
    thenable.then = (resolve: any, reject: any) =>
      new Promise((res, rej) => settle(res, rej))
        .then(async (r: any) => {
          await once();
          return r;
        })
        .then(resolve, reject);
    return thenable;
  };

  (supabase as any).from = (table: string) => {
    const builder = fake.from(table);
    if (table !== 'transaction_splits') return builder;
    const insert = builder.insert;
    builder.insert = (rows: any) => {
      const ins = insert(rows);
      const select = ins.select;
      ins.select = (cols?: string) => afterSettling(select(cols));
      return afterSettling(ins);
    };
    return builder;
  };
}

describe('pushChanges — transaction splits', () => {
  it('refuses to mark a split synced when a local split edit lands mid-push', async () => {
    await seedPendingTxnWithSplit(LOCAL_AT);

    const fake = installSupabase({ serverNow: SERVER_NOW });
    // The edit the user makes while the upload is in flight, exactly as
    // applyTransactionUpdate writes it: the old splits go, replacements arrive
    // under fresh ids with a later timestamp, marked 'pending'.
    onSplitInsert(fake, async () => {
      await adapter.runAsync(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
        ['T1']
      );
      await adapter.runAsync(
        `INSERT INTO transaction_splits
           (id, transaction_id, amount, memo, updated_at, _sync_status)
         VALUES ('s2', 'T1', -35, 'Corrected', ?, 'pending')`,
        [EDITED_AT]
      );
      await adapter.runAsync(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?",
        [EDITED_AT, 'T1']
      );
    });

    await pushChanges('u');

    // The replacement is untouched: the push's mark-synced was guarded on the
    // id and timestamp it uploaded, and 's2' is neither. 'pending' is the
    // load-bearing part — the pull's split refresh deletes local splits scoped
    // to `_sync_status = 'synced'`, so a split wrongly marked synced here is
    // replaced by the server's stale copy the next time the parent is pulled,
    // and the edit is gone for good.
    const after = await localSplits('T1');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: 's2',
      amount: -35,
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });

    // And because it is still pending, the next push actually sends it.
    installSupabase({ serverNow: SERVER_NOW });
    await pushChanges('u');

    expect(store.transaction_splits.map((s) => s.id)).toEqual(['s2']);
    expect(store.transaction_splits[0]).toMatchObject({
      amount: -35,
      memo: 'Corrected',
    });
    expect((await localSplits('T1'))[0]._sync_status).toBe('synced');
  });

  it('does not duplicate the superseded split when the sync pulls afterwards', async () => {
    // The trap the per-id guard opens if the pull is left alone. Our own push
    // bumps the parent's server updated_at, so the very next incremental pull
    // reads it back and lists it in `pulledTxnIds` — even though
    // upsertRemoteTransaction is a guarded no-op for a locally 'pending' row.
    // The split refresh would then fetch the server's copy of the SUPERSEDED
    // split, whose id no longer exists locally, delete only the 'synced' local
    // splits (sparing the pending replacement) and insert it alongside. The
    // next push sends every local split for the parent regardless of status, so
    // both end up on the server: the edit is no longer lost, it is permanently
    // duplicated, and the splits no longer sum to the transaction.
    //
    // Same scenario as the test above, driven through fullSync (push + pull)
    // twice, which is what the app actually runs.
    await seedPendingTxnWithSplit(LOCAL_AT);

    const fake = installSupabase({ serverNow: SERVER_NOW });
    onSplitInsert(fake, async () => {
      await adapter.runAsync(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
        ['T1']
      );
      await adapter.runAsync(
        `INSERT INTO transaction_splits
           (id, transaction_id, amount, memo, updated_at, _sync_status)
         VALUES ('s2', 'T1', -35, 'Corrected', ?, 'pending')`,
        [EDITED_AT]
      );
      await adapter.runAsync(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?",
        [EDITED_AT, 'T1']
      );
    });

    await fullSync('u');
    installSupabase({ serverNow: SERVER_NOW });
    await fullSync('u');

    // Exactly one split survives, on both sides, and it is the edit.
    const after = await localSplits('T1');
    expect(after.map((r) => r.id)).toEqual(['s2']);
    expect(after[0]).toMatchObject({ amount: -35, _sync_status: 'synced' });
    expect(store.transaction_splits.map((r) => r.id)).toEqual(['s2']);
    expect(store.transaction_splits[0]).toMatchObject({ amount: -35 });
  });

  it('marks an untouched split synced and adopts the timestamp read back', async () => {
    // The happy path the guard must not break — and the reason the push selects
    // `updated_at` back at all: PostgREST re-renders timestamptz ('...Z' comes
    // home as '...+00:00'), so a row that kept the client's own value still
    // disagrees with the server unless the rendering is adopted.
    await seedPendingTxnWithSplit(LOCAL_AT);

    installSupabase({ serverNow: SERVER_NOW });
    await pushChanges('u');

    const after = await localSplits('T1');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: 's1',
      _sync_status: 'synced',
      updated_at: '2026-05-01T00:00:00+00:00',
    });
    expect(store.transaction_splits).toHaveLength(1);
  });

  it('heals a split that has no local updated_at yet', async () => {
    // A row the migration-2 backfill could not reach, or one pulled from a
    // server without 006: locally NULL. The payload must OMIT the column (the
    // server's is `not null default now()`, so an explicit null is rejected and
    // would strand the parent 'pending' forever), and the stamp the server
    // chose comes back and is adopted.
    await seedPendingTxnWithSplit(null);

    installSupabase({ serverNow: SERVER_NOW });
    await pushChanges('u');

    expect(store.transaction_splits).toHaveLength(1);
    expect(store.transaction_splits[0].updated_at).toBe(SERVER_NOW);
    const after = await localSplits('T1');
    expect(after[0]).toMatchObject({
      _sync_status: 'synced',
      updated_at: SERVER_NOW,
    });
    // The parent went synced too — nothing was left behind by the NULL.
    const txn: any = await adapter.getFirstAsync(
      'SELECT _sync_status FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(txn._sync_status).toBe('synced');
  });

  it('reports the missing migration when the split insert is rejected', async () => {
    // Deploying this client against a database without
    // 006_split_updated_at.sql: PostgREST answers PGRST204 for the unknown
    // column. Push swallows per-row errors by design, so without this the UI
    // says "1 pending change" forever and never says why — and it is worse than
    // for a normal row, because a failed split upload leaves the PARENT
    // transaction pending too.
    await seedPendingTxnWithSplit(LOCAL_AT);

    const fake = installSupabase({ serverNow: SERVER_NOW });
    (supabase as any).from = (table: string) => {
      const builder = fake.from(table);
      if (table !== 'transaction_splits') return builder;
      const rejection = {
        data: null,
        error: {
          code: 'PGRST204',
          message:
            "Could not find the 'updated_at' column of 'transaction_splits' in the schema cache",
        },
      };
      builder.insert = () => ({
        select: () => ({
          then: (resolve: any, reject: any) =>
            Promise.resolve(rejection).then(resolve, reject),
        }),
        then: (resolve: any, reject: any) =>
          Promise.resolve(rejection).then(resolve, reject),
      });
      return builder;
    };

    await pushChanges('u');

    expect(getSyncSnapshot().lastError).toMatch(/006_split_updated_at\.sql/);
    // Nothing was marked synced on the strength of a failed upload.
    expect((await localSplits('T1'))[0]._sync_status).toBe('pending');
    const txn: any = await adapter.getFirstAsync(
      'SELECT _sync_status FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(txn._sync_status).toBe('pending');
  });
});

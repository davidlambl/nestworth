// #98: delete wins over a concurrent edit after the tombstone is purged too.
//
// purge_tombstones() reclaims a tombstone 30 to 37 days after the delete. Until
// 008, an edit pushed after that re-inserted the row as live -- the push
// upserts on id, and no server row was left to keep a tombstone on -- and every
// other device pulled it back. A reorder made that common: it rewrites every
// active account, so one tap on a device that had been away re-inserted every
// account deleted elsewhere since. 008_purged_ids.sql makes the purge record
// the id of every account, transaction and rule it removes, and a BEFORE
// INSERT trigger refuses a re-insert of one with 23503 and `hint: 'purged'`.
// The push takes that answer the way it takes a read-back tombstone: it drops
// the local copy under the same guard, splits included, and says nothing.
//
// Both halves of the predicate are the contract with 008. A 23503 without the
// hint is a row the server never held -- 005's born-dead refusal, or the plain
// foreign key that a child created offline under a purged account meets -- and
// dropping it would destroy what the user typed.
//
// The fixture's `purgedIds` plays the trigger (lib/testing/syncFixture.ts).
// Own file: `lastError` and the sync lock are module state, so each test
// starts from a cleared error and afterEach asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { pushChanges, resetLocalData } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

/** What the server's BEFORE UPDATE trigger stamps, in PostgREST's rendering. */
const SERVER_NOW = '2026-06-01T12:00:00+00:00';
/** The server's copy of a row nobody has touched since. */
const OLD = '2026-05-01T00:00:00Z';
/** The local edit the push uploads (for accounts, a reorder). */
const EDIT = '2026-05-02T00:00:00Z';
/** A keystroke that lands while the refused upsert is in flight. */
const LATER = '2026-05-03T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let meta: Map<string, string>;
let installSupabase: ReturnType<typeof wireSyncMocks>['installSupabase'];
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ({ adapter, store, meta, installSupabase } = wireSyncMocks({
    serverNow: SERVER_NOW,
  }));
  setLastError(null);
  // The purged path warns by design, and so does a refused push.
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  adapter._sqlite.close();
});

const lastError = () => getSyncSnapshot().lastError;

const localRow = (table: string, id: string): Promise<any> =>
  adapter.getFirstAsync(`SELECT * FROM ${table} WHERE id = ?`, [id]);

const localSplits = (txnId: string): Promise<any[]> =>
  adapter.getAllAsync(
    'SELECT * FROM transaction_splits WHERE transaction_id = ?',
    [txnId]
  );

const localIds = (table: string): string[] =>
  adapter._sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((r: any) => r.id);

/** A pending transaction T1 with one pending split, as an edit leaves them. */
async function seedPendingT1() {
  await insertLocalTxn(adapter, {
    id: 'T1',
    updated_at: EDIT,
    _sync_status: 'pending',
  });
  await insertLocalSplit(adapter, {
    id: 's1',
    transaction_id: 'T1',
    updated_at: EDIT,
    _sync_status: 'pending',
  });
}

describe('pushChanges when the server refuses a row as purged', () => {
  it('drops a reordered account whose tombstone was purged, and still pushes the rest', async () => {
    // The #98 headline. A3 was deleted on another device and its tombstone
    // purged, so the server holds no A3 at all; the reorder made it pending
    // here with the other two. It goes up FIRST (insertion order), so A1 and
    // A2 prove the refusal does not end the push.
    installSupabase({ serverNow: SERVER_NOW, purgedIds: new Set(['A3']) });
    store.accounts = [
      remoteAccount({ id: 'A1', sort_order: 0, updated_at: OLD }),
      remoteAccount({ id: 'A2', sort_order: 1, updated_at: OLD }),
    ];
    for (const [id, sort_order] of [
      ['A3', 0],
      ['A1', 1],
      ['A2', 2],
    ] as const) {
      await insertLocalAccount(adapter, {
        id,
        sort_order,
        updated_at: EDIT,
        _sync_status: 'pending',
      });
    }

    await pushChanges('u');

    expect(await localRow('accounts', 'A3')).toBeNull();
    for (const id of ['A1', 'A2']) {
      expect(await localRow('accounts', id)).toMatchObject({
        _sync_status: 'synced',
        updated_at: SERVER_NOW,
      });
    }
    // Not re-inserted: the whole point of the guard.
    expect(store.accounts.map((r) => r.id)).toEqual(['A1', 'A2']);
    // Silent, as a read-back tombstone is: delete won, and the sync is fine.
    expect(lastError()).toBeNull();
  });

  it('drops a purged transaction with its splits and uploads nothing for it', async () => {
    installSupabase({ serverNow: SERVER_NOW, purgedIds: new Set(['T1']) });
    await seedPendingT1();

    await pushChanges('u');

    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localSplits('T1')).toEqual([]);
    // The split upload sits below the drop, so nothing went up under a parent
    // the server refused.
    expect(store.transactions).toEqual([]);
    expect(store.transaction_splits).toEqual([]);
    expect(lastError()).toBeNull();
  });

  it('drops an adopted parent whose id was purged, with its orphaned split (#97)', async () => {
    // #97 re-queues a SYNCED parent that carries an unsynced split, so the
    // split can travel with it. Were that parent deleted elsewhere and its
    // tombstone purged, the re-queue would re-insert it. 008 refuses the id,
    // and the push drops the parent and the split here instead.
    installSupabase({ serverNow: SERVER_NOW, purgedIds: new Set(['T1']) });
    await insertLocalTxn(adapter, { id: 'T1', updated_at: OLD });
    await insertLocalSplit(adapter, {
      id: 's1',
      transaction_id: 'T1',
      updated_at: EDIT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localSplits('T1')).toEqual([]);
    expect(store.transactions).toEqual([]);
    expect(store.transaction_splits).toEqual([]);
    expect(lastError()).toBeNull();
  });

  it('drops a purged recurring rule', async () => {
    installSupabase({ serverNow: SERVER_NOW, purgedIds: new Set(['R1']) });
    await insertLocalRule(adapter, {
      id: 'R1',
      updated_at: EDIT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect(await localRow('recurring_rules', 'R1')).toBeNull();
    expect(store.recurring_rules).toEqual([]);
  });

  it('keeps a NEWER mid-flight edit to a purged row pending, splits included', async () => {
    // The drop is guarded like mark-synced: id + the updated_at we read +
    // still 'pending'. A keystroke that landed during the round trip bumped
    // updated_at, so the guard matches nothing and the edit survives to meet
    // the refusal again on the next push. Its splits belong to it, so they
    // stay too.
    installSupabase({
      serverNow: SERVER_NOW,
      purgedIds: new Set(['T1']),
      onAfterUpsert: async (table) => {
        if (table !== 'transactions') return;
        await adapter.runAsync(
          `UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          [LATER, 'T1']
        );
      },
    });
    await seedPendingT1();

    await pushChanges('u');

    expect(await localRow('transactions', 'T1')).toMatchObject({
      _sync_status: 'pending',
      updated_at: LATER,
    });
    expect(await localSplits('T1')).toHaveLength(1);
    expect(store.transactions).toEqual([]);
    expect(store.transaction_splits).toEqual([]);
  });

  it.each([
    [
      "005's born-dead refusal (23503, no hint)",
      {
        code: '23503',
        message: 'account a1 is deleted',
        details: null,
        hint: null,
      },
    ],
    [
      'the foreign key, for a child of a purged account (23503, no hint)',
      {
        code: '23503',
        message:
          'insert or update on table "transactions" violates foreign key constraint "transactions_account_id_fkey"',
        // As the app's session sees it: RLS on transactions makes Postgres
        // leave the key values out of the DETAIL.
        details: 'Key is not present in table "accounts".',
        hint: null,
      },
    ],
    [
      'the hint without the 23503',
      {
        code: '',
        message: 'TypeError: Failed to fetch',
        details: '',
        hint: 'purged',
      },
    ],
  ])(
    'leaves any other refusal pending, splits included: %s',
    async (_shape, writeError) => {
      // The first two are a row the server has never held, created offline
      // under an account deleted elsewhere. The code alone cannot tell it
      // from a purged row; the hint can. Dropping it would be the data loss
      // 005 refuses. The third is no real answer -- nothing sends the hint
      // without 008's code -- and it is here to pin the code half.
      installSupabase({
        serverNow: SERVER_NOW,
        failWritesOn: new Set(['transactions']),
        writeError,
      });
      await seedPendingT1();

      await pushChanges('u');

      expect(await localRow('transactions', 'T1')).toMatchObject({
        _sync_status: 'pending',
        updated_at: EDIT,
      });
      expect(await localSplits('T1')).toHaveLength(1);
      expect(store.transactions).toEqual([]);
      expect(store.transaction_splits).toEqual([]);
      expect(lastError()).toBeNull();
    }
  );

  it('no longer blocks "Reset & re-download" on a purged pending row', async () => {
    // The reset refuses to wipe while any of the user's rows is still pending
    // after its own push, so an upload it could not make is not thrown away.
    // A purged row the push kept pending forever therefore held every reset
    // hostage ("Couldn't upload 1 unsynced change(s)"). Dropped in the push,
    // it is gone before the count.
    installSupabase({ serverNow: SERVER_NOW, purgedIds: new Set(['A3']) });
    store.accounts = [remoteAccount({ id: 'A1', updated_at: OLD })];
    store.transactions = [
      remoteTxn({ id: 'T1', account_id: 'A1', updated_at: OLD }),
    ];
    await insertLocalAccount(adapter, {
      id: 'A3',
      updated_at: EDIT,
      _sync_status: 'pending',
    });
    await insertLocalAccount(adapter, { id: 'A1', updated_at: OLD });
    await insertLocalTxn(adapter, {
      id: 'T1',
      account_id: 'A1',
      updated_at: OLD,
    });

    // String(err), never rejects.toThrow(): these suites are realm-sensitive.
    const failure = await resetLocalData('u').then(
      () => null,
      (e) => String(e)
    );

    expect(failure).toBeNull();
    expect(localIds('accounts')).toEqual(['A1']);
    expect(localIds('transactions')).toEqual(['T1']);
    expect(meta.get('last_pull_at:u')).toBeTruthy();
  });
});

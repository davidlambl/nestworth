// Push-path tombstones (backlog #18).
//
// These tests pin the push half of the tombstone contract: a remote delete is
// an UPDATE stamping `deleted_at`, not a DELETE. Everything asserted here is a
// failure mode that is invisible to a happy-path test — a re-broadcast dead
// row, a delete stranded in the local queue forever, a mid-flight edit thrown
// away, a parent left alive with its splits gone.
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
import { pushChanges } from '../sync';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
  remoteAccount,
  remoteRule,
  remoteTxn,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

/** What the server's BEFORE UPDATE trigger stamps, in PostgREST's rendering. */
const SERVER_NOW = '2026-06-01T12:00:00+00:00';
/** A tombstone another device wrote earlier, well before SERVER_NOW. */
const EARLIER_TOMBSTONE = '2026-05-20T08:00:00+00:00';
/** An updated_at old enough that any restamp is unmistakable. */
const OLD = '2026-05-01T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let installSupabase: ReturnType<typeof wireSyncMocks>['installSupabase'];

beforeEach(() => {
  ({ adapter, store, installSupabase } = wireSyncMocks({
    serverNow: SERVER_NOW,
  }));
});

afterEach(() => {
  adapter._sqlite.close();
});

const localRow = (table: string, id: string): Promise<any> =>
  adapter.getFirstAsync(`SELECT * FROM ${table} WHERE id = ?`, [id]);

const localSplits = (txnId: string): Promise<any[]> =>
  adapter.getAllAsync(
    'SELECT * FROM transaction_splits WHERE transaction_id = ?',
    [txnId]
  );

describe('pushChanges tombstones deleted rows', () => {
  it('tombstones a deleted transaction instead of hard-deleting it', async () => {
    // The point of the whole change: the remote row must SURVIVE as a
    // tombstone. A hard delete is invisible to the other devices' cheap
    // `updated_at > cursor` pull, which is why every sync used to have to
    // enumerate the entire remote table just to notice it.
    store.transactions = [remoteTxn({ id: 'T1', updated_at: OLD })];
    store.transaction_splits = [{ id: 's1', transaction_id: 'T1', amount: 5 }];
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    await pushChanges('u');

    expect(store.transactions).toHaveLength(1);
    expect(store.transactions[0].deleted_at).toEqual(expect.any(String));
    // The updated_at bump is the delivery mechanism: without it the tombstone
    // sits below every other device's cursor and is never pulled.
    expect(store.transactions[0].updated_at).toBe(SERVER_NOW);
    // Splits have no tombstone of their own — they ride the parent.
    expect(store.transaction_splits).toEqual([]);

    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localSplits('T1')).toEqual([]);
  });

  it('tombstones deleted accounts and rules via pushTable', async () => {
    // The rule hangs off a DIFFERENT account, so what is asserted here is the
    // rule's own push and not the server's cascade trigger firing on A1.
    store.accounts = [remoteAccount({ id: 'A1', updated_at: OLD })];
    store.recurring_rules = [
      remoteRule({ id: 'R1', account_id: 'A2', updated_at: OLD }),
    ];
    await insertLocalAccount(adapter, {
      id: 'A1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalRule(adapter, {
      id: 'R1',
      account_id: 'A2',
      updated_at: OLD,
      _sync_status: 'deleted',
    });

    await pushChanges('u');

    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0].deleted_at).toEqual(expect.any(String));
    expect(store.accounts[0].updated_at).toBe(SERVER_NOW);
    expect(store.recurring_rules).toHaveLength(1);
    expect(store.recurring_rules[0].deleted_at).toEqual(expect.any(String));
    expect(store.recurring_rules[0].updated_at).toBe(SERVER_NOW);

    expect(await localRow('accounts', 'A1')).toBeNull();
    expect(await localRow('recurring_rules', 'R1')).toBeNull();
  });

  it('pushes child tombstones itself, without the server cascade trigger', async () => {
    // `cascadeTombstones: false` models a server whose accounts_tombstone_
    // children trigger has not been installed. The client must still leave the
    // child dead server-side: it pushes the child tombstone itself and only
    // treats the trigger as a possible head start.
    installSupabase({ serverNow: SERVER_NOW, cascadeTombstones: false });
    store.accounts = [remoteAccount({ id: 'A1', updated_at: OLD })];
    store.transactions = [
      remoteTxn({ id: 'T1', account_id: 'A1', updated_at: OLD }),
    ];
    await insertLocalAccount(adapter, {
      id: 'A1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalTxn(adapter, {
      id: 'T1',
      account_id: 'A1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });

    await pushChanges('u');

    expect(store.accounts[0].deleted_at).toEqual(expect.any(String));
    expect(store.transactions[0].deleted_at).toEqual(expect.any(String));
    expect(await localRow('accounts', 'A1')).toBeNull();
    expect(await localRow('transactions', 'T1')).toBeNull();
  });

  it('treats a zero-row tombstone update as success', async () => {
    // The row was never pushed (or was already purged), so the UPDATE matches
    // nothing. That is SUCCESS and must still hard-delete locally. If the code
    // ever chains .single() here, PostgREST answers PGRST116 on zero rows, the
    // local row stays 'deleted' forever, and every future sync retries it.
    await insertLocalTxn(adapter, {
      id: 'T9',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalAccount(adapter, {
      id: 'A9',
      updated_at: OLD,
      _sync_status: 'deleted',
    });

    await pushChanges('u');

    expect(await localRow('transactions', 'T9')).toBeNull();
    expect(await localRow('accounts', 'A9')).toBeNull();
    expect(store.transactions).toEqual([]);
    expect(store.accounts).toEqual([]);
  });

  it('does not re-stamp a row that is already tombstoned', async () => {
    // Idempotency, enforced by `.is('deleted_at', null)`. Without that filter a
    // retried push — or a row the account cascade already stamped — gets
    // re-stamped, which re-fires the updated_at trigger and re-broadcasts the
    // same dead row to every other device on every single sync.
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: OLD, deleted_at: EARLIER_TOMBSTONE }),
    ];
    store.accounts = [
      remoteAccount({
        id: 'A1',
        updated_at: OLD,
        deleted_at: EARLIER_TOMBSTONE,
      }),
    ];
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalAccount(adapter, {
      id: 'A1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });

    await pushChanges('u');

    expect(store.transactions[0].updated_at).toBe(OLD);
    expect(store.transactions[0].deleted_at).toBe(EARLIER_TOMBSTONE);
    expect(store.accounts[0].updated_at).toBe(OLD);
    expect(store.accounts[0].deleted_at).toBe(EARLIER_TOMBSTONE);
    // Matching nothing is still success, so the local rows still go.
    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localRow('accounts', 'A1')).toBeNull();
  });

  it('tombstones the parent even when the remote split delete fails', async () => {
    // Order matters. The old code deleted the splits FIRST, so a failing parent
    // write left a live parent stripped of its splits — and nothing ever
    // refetched it, because the parent's updated_at never moved. Parent first
    // means the worst case is a dead parent whose splits linger until the purge
    // cascades them out.
    installSupabase({
      serverNow: SERVER_NOW,
      failWritesOn: new Set(['transaction_splits']),
    });
    store.transactions = [remoteTxn({ id: 'T1', updated_at: OLD })];
    store.transaction_splits = [{ id: 's1', transaction_id: 'T1', amount: 5 }];
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    await pushChanges('u');

    expect(store.transactions[0].deleted_at).toEqual(expect.any(String));
    // The split delete really did fail; the orphan is tolerated on purpose.
    expect(store.transaction_splits).toHaveLength(1);
    // The local delete still completes — the parent is dead to every device.
    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localSplits('T1')).toEqual([]);
  });

  it('keeps a row re-dirtied mid-push, and keeps its splits with it', async () => {
    // The local hard delete is scoped `AND _sync_status = 'deleted'`, so a row
    // that went back to 'pending' while the tombstone UPDATE was in flight (an
    // undo, a re-import of the same id) is not dropped with its edit unsent.
    // The split delete is scoped to orphans for the same reason: a parent the
    // guard spared still needs its splits, and deleting them by id alone would
    // mangle exactly the row the guard exists to protect.
    store.transactions = [remoteTxn({ id: 'T1', updated_at: OLD })];
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: OLD,
      _sync_status: 'deleted',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    // The fixture hooks the upsert round trip, not the update one, so the
    // re-dirty is driven by wrapping the tombstone UPDATE's own thenable.
    const fake = installSupabase({ serverNow: SERVER_NOW });
    (supabase as any).from = (table: string) => {
      const builder = fake.from(table);
      if (table !== 'transactions') return builder;
      const update = builder.update;
      builder.update = (patch: any) => {
        const upd = update(patch);
        const settle = upd.then;
        upd.then = (resolve: any, reject: any) =>
          adapter
            .runAsync(
              `UPDATE transactions SET _sync_status = 'pending' WHERE id = ?`,
              ['T1']
            )
            .then(() => settle(resolve, reject));
        return upd;
      };
      return builder;
    };

    await pushChanges('u');

    // The tombstone still went out — the server is not left holding a live row.
    expect(store.transactions[0].deleted_at).toEqual(expect.any(String));
    const row = await localRow('transactions', 'T1');
    expect(row).not.toBeNull();
    expect(row._sync_status).toBe('pending');
    expect(await localSplits('T1')).toHaveLength(1);
  });

  it('batches transaction tombstones instead of one round trip per row', async () => {
    // A tombstone does not cascade at the FK level the way a hard delete did,
    // so deleting a busy account now queues a real UPDATE per child. At one
    // request each that is thousands of sequential round trips.
    const ids = Array.from(
      { length: 450 },
      (_, i) => `T${String(i).padStart(3, '0')}`
    );
    store.transactions = ids.map((id) => remoteTxn({ id, updated_at: OLD }));
    for (const id of ids) {
      await insertLocalTxn(adapter, {
        id,
        updated_at: OLD,
        _sync_status: 'deleted',
      });
    }

    const batchSizes: number[] = [];
    const fake = installSupabase({ serverNow: SERVER_NOW });
    (supabase as any).from = (table: string) => {
      const builder = fake.from(table);
      if (table !== 'transactions') return builder;
      const update = builder.update;
      builder.update = (patch: any) => {
        const upd = update(patch);
        const inFilter = upd.in;
        upd.in = (col: string, vals: any[]) => {
          batchSizes.push(vals.length);
          return inFilter(col, vals);
        };
        return upd;
      };
      return builder;
    };

    await pushChanges('u');

    expect(batchSizes).toEqual([200, 200, 50]);
    expect(store.transactions).toHaveLength(450);
    expect(
      store.transactions.every((r) => typeof r.deleted_at === 'string')
    ).toBe(true);
    const left: any = await adapter.getFirstAsync(
      'SELECT COUNT(*) AS n FROM transactions'
    );
    expect(left.n).toBe(0);
  });
});

describe('pushChanges when a pending edit lands on a tombstone', () => {
  it('drops the transaction locally — delete wins over a concurrent edit', async () => {
    // Another device deleted T1 while this one was editing it. PostgREST writes
    // only the keys the payload carries and an edit never carries deleted_at,
    // so the tombstone survives our upsert: the row is dead server-side no
    // matter what we do locally. Marking it 'synced' would leave a row on
    // screen that no longer exists anywhere else.
    //
    // This is strictly better than the behaviour it replaces: against hard
    // deletes the same race RESURRECTED the row server-side and every other
    // device pulled the zombie back down.
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: OLD, deleted_at: EARLIER_TOMBSTONE }),
    ];
    store.transaction_splits = [];
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    await pushChanges('u');

    expect(await localRow('transactions', 'T1')).toBeNull();
    expect(await localSplits('T1')).toEqual([]);
    // Delete won: the row is still a tombstone, not resurrected.
    expect(store.transactions[0].deleted_at).toBe(EARLIER_TOMBSTONE);
    // The split upload was skipped, so nothing was re-populated under a parent
    // that is dead server-side.
    expect(store.transaction_splits).toEqual([]);
  });

  it('keeps a NEWER mid-flight edit pending rather than destroying it', async () => {
    // The local delete is guarded on the updated_at we READ, exactly like
    // mark-synced. A keystroke that landed during the network round trip bumped
    // updated_at, so the guard matches nothing: the edit survives, stays
    // pending, and meets the tombstone again on the next push. Deleting
    // unguarded here would throw away work the user did after the read.
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: OLD, deleted_at: EARLIER_TOMBSTONE }),
    ];
    installSupabase({
      serverNow: SERVER_NOW,
      onAfterUpsert: async (table) => {
        if (table !== 'transactions') return;
        await adapter.runAsync(
          `UPDATE transactions SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          ['2026-05-03T00:00:00Z', 'T1']
        );
      },
    });
    await insertLocalTxn(adapter, {
      id: 'T1',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    await pushChanges('u');

    const row = await localRow('transactions', 'T1');
    expect(row).not.toBeNull();
    expect(row._sync_status).toBe('pending');
    expect(row.updated_at).toBe('2026-05-03T00:00:00Z');
    // The splits belong to that surviving edit: dropping them unconditionally
    // would mangle the very row the guard just refused to touch.
    expect(await localSplits('T1')).toHaveLength(1);
  });

  it('drops the account locally when its pending edit lands on a tombstone', async () => {
    // Same rule on the pushTable path, which accounts and rules share.
    store.accounts = [
      remoteAccount({
        id: 'A1',
        updated_at: OLD,
        deleted_at: EARLIER_TOMBSTONE,
      }),
    ];
    await insertLocalAccount(adapter, {
      id: 'A1',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect(await localRow('accounts', 'A1')).toBeNull();
    expect(store.accounts[0].deleted_at).toBe(EARLIER_TOMBSTONE);
  });

  it('keeps a NEWER mid-flight account edit pending', async () => {
    store.accounts = [
      remoteAccount({
        id: 'A1',
        updated_at: OLD,
        deleted_at: EARLIER_TOMBSTONE,
      }),
    ];
    installSupabase({
      serverNow: SERVER_NOW,
      onAfterUpsert: async (table) => {
        if (table !== 'accounts') return;
        await adapter.runAsync(
          `UPDATE accounts SET updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
          ['2026-05-03T00:00:00Z', 'A1']
        );
      },
    });
    await insertLocalAccount(adapter, {
      id: 'A1',
      updated_at: '2026-05-02T00:00:00Z',
      _sync_status: 'pending',
    });

    await pushChanges('u');

    const row = await localRow('accounts', 'A1');
    expect(row).not.toBeNull();
    expect(row._sync_status).toBe('pending');
    expect(row.updated_at).toBe('2026-05-03T00:00:00Z');
  });
});

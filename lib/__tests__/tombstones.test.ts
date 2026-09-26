// Tombstone helpers (#18). These run against a real in-memory SQLite so the
// actual scoped DELETE statements execute — the whole value of these helpers is
// the `_sync_status = 'synced'` scope, which only a real WHERE clause can prove.
//
// The fixture imports '../supabase' and '../db' at module scope, so the same
// mocks sync.test.ts declares are required here.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  isTombstone,
  deleteLocalAccountIfSynced,
  deleteLocalRuleIfSynced,
  deleteLocalTransactionIfSynced,
  sweepOrphanSyncedSplits,
} from '../tombstones';
import {
  forceUpsertRemoteAccount,
  forceUpsertRemoteTransaction,
  upsertRemoteAccount,
  upsertRemoteTransaction,
} from '../sync';
import {
  makeAdapter,
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
} from '../testing/syncFixture';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

const count = async (sql: string, params: any[] = []) =>
  ((await adapter.getFirstAsync(sql, params)) as any).c as number;

describe('isTombstone', () => {
  it('is true only when deleted_at carries a value', () => {
    expect(isTombstone({ id: 'T', deleted_at: '2026-06-01T00:00:00Z' })).toBe(
      true
    );
    expect(isTombstone({ id: 'T', deleted_at: null })).toBe(false);
    // A narrowed PostgREST select omits the column entirely; that means "live",
    // not "deleted" — reading a missing key as a tombstone would delete every
    // row a `.select('id, updated_at')` read returned.
    expect(isTombstone({ id: 'T' })).toBe(false);
  });

  it('tolerates a missing record, as realtime payloads have', () => {
    // A DELETE event carries `old` but no `new`; the handler asks about both.
    expect(isTombstone(undefined)).toBe(false);
    expect(isTombstone(null)).toBe(false);
  });
});

describe('deleteLocalTransactionIfSynced', () => {
  it('removes a synced row and its splits', async () => {
    await insertLocalTxn(adapter, { id: 'T1' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    expect(await deleteLocalTransactionIfSynced(adapter, 'T1')).toBe(true);

    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM transaction_splits')).toBe(0);
  });

  it('leaves a pending row AND its splits intact', async () => {
    // The regression this scope exists to prevent: a tombstone arriving while a
    // local edit is still queued must not destroy the edit. Deleting the splits
    // regardless of the parent's status would be just as destructive — it
    // would silently strip the edit's splits off the row it just spared.
    await insertLocalTxn(adapter, { id: 'T1', _sync_status: 'pending' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });

    expect(await deleteLocalTransactionIfSynced(adapter, 'T1')).toBe(false);

    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM transaction_splits')).toBe(1);
  });

  it('leaves a locally deleted row for push to resolve', async () => {
    // 'deleted' is a local delete still queued for push. Dropping it here would
    // lose the queue entry, so the server would never hear about the delete.
    await insertLocalTxn(adapter, { id: 'T1', _sync_status: 'deleted' });

    expect(await deleteLocalTransactionIfSynced(adapter, 'T1')).toBe(false);
    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(1);
  });

  it('is a no-op for an id that was never stored locally', async () => {
    // Tombstones arrive for rows this device may never have seen (another
    // account, or one purged before the first pull). That must not throw.
    expect(await deleteLocalTransactionIfSynced(adapter, 'ghost')).toBe(false);
  });

  it('does not touch another transaction’s splits', async () => {
    await insertLocalTxn(adapter, { id: 'T1' });
    await insertLocalTxn(adapter, { id: 'T2' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 'T1' });
    await insertLocalSplit(adapter, { id: 's2', transaction_id: 'T2' });

    await deleteLocalTransactionIfSynced(adapter, 'T1');

    const splits = await adapter.getAllAsync(
      'SELECT id FROM transaction_splits',
      []
    );
    expect(splits).toEqual([{ id: 's2' }]);
  });
});

describe('sweepOrphanSyncedSplits (#137)', () => {
  /** Every local split's id, sorted. */
  const splitIds = async () =>
    (
      (await adapter.getAllAsync(
        'SELECT id FROM transaction_splits ORDER BY id',
        []
      )) as { id: string }[]
    ).map((r) => r.id);

  it('L1: deletes only a synced split whose transaction row is gone, and returns how many it deleted', async () => {
    // A split under a row that is still here stays, whatever that row's
    // status. A parentless split stays unless it is synced: a pending or
    // deleted one is what the reset's wipe leaves on purpose until the
    // re-download restores its parent, and a NULL status (no writer makes
    // one) is left alone, as the wipe leaves it.
    await insertLocalTxn(adapter, { id: 't1', _sync_status: 'pending' });
    await insertLocalSplit(adapter, { id: 'par', transaction_id: 't1' });
    await insertLocalSplit(adapter, { id: 'orph', transaction_id: 'gone' });
    await insertLocalSplit(adapter, {
      id: 'orph_p',
      transaction_id: 'gone',
      _sync_status: 'pending',
    });
    await insertLocalSplit(adapter, {
      id: 'orph_d',
      transaction_id: 'gone',
      _sync_status: 'deleted',
    });
    // insertLocalSplit turns a null status into 'synced'.
    adapter._sqlite
      .prepare(
        "INSERT INTO transaction_splits (id, transaction_id, amount, _sync_status) VALUES ('orph_n', 'gone', -1, NULL)"
      )
      .run();

    expect(await sweepOrphanSyncedSplits(adapter)).toBe(1);
    expect(await splitIds()).toEqual(['orph_d', 'orph_n', 'orph_p', 'par']);
  });

  it('L1n: still finds the orphan when a transactions row has a NULL id', async () => {
    // transactions.id is TEXT PRIMARY KEY without NOT NULL, so SQLite accepts
    // a NULL id (no writer makes one). Against it `transaction_id NOT IN
    // (SELECT id FROM transactions)` is NULL for every split, and a sweep
    // written that way deletes nothing at all: why the sweep is a NOT EXISTS.
    await insertLocalTxn(adapter, { id: 't1' });
    adapter._sqlite
      .prepare(
        "INSERT INTO transactions (id, user_id, account_id) VALUES (NULL, 'u', 'a1')"
      )
      .run();
    await insertLocalSplit(adapter, { id: 'par', transaction_id: 't1' });
    await insertLocalSplit(adapter, { id: 'orph', transaction_id: 'gone' });

    expect(await sweepOrphanSyncedSplits(adapter)).toBe(1);
    expect(await splitIds()).toEqual(['par']);
  });
});

describe('deleteLocalAccountIfSynced', () => {
  it('removes a synced account', async () => {
    await insertLocalAccount(adapter, { id: 'a1' });

    expect(await deleteLocalAccountIfSynced(adapter, 'a1')).toBe(true);
    expect(await count('SELECT COUNT(*) AS c FROM accounts')).toBe(0);
  });

  it('leaves an unsynced account alone', async () => {
    await insertLocalAccount(adapter, { id: 'a1', _sync_status: 'pending' });

    expect(await deleteLocalAccountIfSynced(adapter, 'a1')).toBe(false);
    expect(await count('SELECT COUNT(*) AS c FROM accounts')).toBe(1);
  });

  it('does not cascade to children locally', async () => {
    // Each child arrives as its own tombstone (the server trigger stamps them),
    // so it gets its own scoped delete. Cascading here would destroy a child
    // carrying a pending local edit as collateral damage.
    await insertLocalAccount(adapter, { id: 'a1' });
    await insertLocalTxn(adapter, { id: 'T1', account_id: 'a1' });

    await deleteLocalAccountIfSynced(adapter, 'a1');

    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(1);
  });
});

describe('deleteLocalRuleIfSynced', () => {
  it('removes a synced rule', async () => {
    await insertLocalRule(adapter, { id: 'r1' });

    expect(await deleteLocalRuleIfSynced(adapter, 'r1')).toBe(true);
    expect(await count('SELECT COUNT(*) AS c FROM recurring_rules')).toBe(0);
  });

  it('leaves an unsynced rule alone', async () => {
    await insertLocalRule(adapter, { id: 'r1', _sync_status: 'pending' });

    expect(await deleteLocalRuleIfSynced(adapter, 'r1')).toBe(false);
    expect(await count('SELECT COUNT(*) AS c FROM recurring_rules')).toBe(1);
  });
});

describe('upsert guards refuse tombstones', () => {
  // The resurrection bug these guards close: the device that deleted the row
  // receives its OWN tombstone straight back as a realtime UPDATE, and the
  // ON CONFLICT statements have no guard on their INSERT branch — so the echo
  // re-creates the row the user just deleted, and it stays on screen until the
  // next pull. Each case below is "row is absent locally", which is exactly the
  // state the deleting device is in when the echo arrives.
  const TOMBSTONE = '2026-06-01T12:00:00Z';

  it('upsertRemoteTransaction does not insert a tombstoned row', async () => {
    await upsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T1', deleted_at: TOMBSTONE })
    );
    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(0);
  });

  it('forceUpsertRemoteTransaction does not insert a tombstoned row', async () => {
    // The reconcile pass uses the force variant, so it needs the same guard;
    // "authoritative" must not mean "resurrects deletes".
    await forceUpsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T1', deleted_at: TOMBSTONE })
    );
    expect(await count('SELECT COUNT(*) AS c FROM transactions')).toBe(0);
  });

  it('leaves an existing synced row alone rather than half-applying the tombstone', async () => {
    // The guard returns BEFORE the UPDATE branch too. Writing the tombstone's
    // column values over a live local row would leave it visible but wrong;
    // removing it is deleteLocalTransactionIfSynced's job, not the upsert's.
    await insertLocalTxn(adapter, { id: 'T1', payee: 'Kept', amount: 12 });

    await upsertRemoteTransaction(
      adapter,
      remoteTxn({ id: 'T1', payee: 'Dead', amount: 99, deleted_at: TOMBSTONE })
    );

    const row: any = await adapter.getFirstAsync(
      'SELECT payee, amount FROM transactions WHERE id = ?',
      ['T1']
    );
    expect(row).toEqual({ payee: 'Kept', amount: 12 });
  });

  it('upsertRemoteAccount and forceUpsertRemoteAccount do not insert a tombstoned row', async () => {
    await upsertRemoteAccount(
      adapter,
      remoteAccount({ id: 'a1', deleted_at: TOMBSTONE })
    );
    await forceUpsertRemoteAccount(
      adapter,
      remoteAccount({ id: 'a2', deleted_at: TOMBSTONE })
    );
    expect(await count('SELECT COUNT(*) AS c FROM accounts')).toBe(0);
  });
});

import Database from 'better-sqlite3';
import { applyTransactionUpdate, type TxnDb } from '../transactionUpdate';

// Adapts better-sqlite3's synchronous API to the small async surface the
// real expo-sqlite database exposes for this code path. withTransactionAsync
// mirrors expo-sqlite's behavior: BEGIN, run the task, COMMIT on success,
// ROLLBACK on throw.
function adapt(db: Database.Database): TxnDb {
  return {
    runAsync: async (sql, params) => db.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, params: any[]) =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
    withTransactionAsync: async (task) => {
      db.prepare('BEGIN').run();
      try {
        await task();
        db.prepare('COMMIT').run();
      } catch (e) {
        db.prepare('ROLLBACK').run();
        throw e;
      }
    },
  };
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      txn_date TEXT NOT NULL,
      payee TEXT NOT NULL,
      amount REAL NOT NULL,
      check_number TEXT,
      memo TEXT,
      status TEXT NOT NULL,
      transfer_link_id TEXT,
      receipt_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      _sync_status TEXT NOT NULL
    );
    CREATE TABLE transaction_splits (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      amount REAL NOT NULL,
      memo TEXT,
      _sync_status TEXT NOT NULL
    );
  `);
  return db;
}

function seedTransferPair(db: Database.Database, linkId: string) {
  const insert = db.prepare(`
    INSERT INTO transactions
      (id, user_id, account_id, txn_date, payee, amount, memo, status,
       transfer_link_id, created_at, updated_at, _sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, 'synced')
  `);
  insert.run(
    'from-txn',
    'user-1',
    'acc-pnc',
    '2026-05-10',
    'Transfer to Chase',
    -66.76,
    'Transfer',
    linkId,
    '2026-05-10T00:00:00Z',
    '2026-05-10T00:00:00Z'
  );
  insert.run(
    'to-txn',
    'user-1',
    'acc-chase',
    '2026-05-10',
    'Transfer from PNC',
    66.76,
    'Transfer',
    linkId,
    '2026-05-10T00:00:00Z',
    '2026-05-10T00:00:00Z'
  );
}

describe('applyTransactionUpdate (transfer pair sync)', () => {
  it('mirrors a corrected amount onto the paired transaction', async () => {
    const db = freshDb();
    seedTransferPair(db, 'link-abc');

    const result = await applyTransactionUpdate(
      adapt(db),
      {
        id: 'from-txn',
        accountId: 'acc-pnc',
        amount: -63.43,
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    expect(result.linkedTransactionId).toBe('to-txn');
    expect(result.linkedAccountId).toBe('acc-chase');

    const rows = db
      .prepare(
        'SELECT id, amount, _sync_status, updated_at FROM transactions ORDER BY id'
      )
      .all() as Array<{
      id: string;
      amount: number;
      _sync_status: string;
      updated_at: string;
    }>;

    const fromRow = rows.find((r) => r.id === 'from-txn')!;
    const toRow = rows.find((r) => r.id === 'to-txn')!;

    expect(fromRow.amount).toBe(-63.43);
    expect(toRow.amount).toBe(63.43);
    expect(fromRow._sync_status).toBe('pending');
    expect(toRow._sync_status).toBe('pending');
    expect(fromRow.updated_at).toBe('2026-05-13T10:00:00Z');
    expect(toRow.updated_at).toBe('2026-05-13T10:00:00Z');
  });

  it('propagates date, memo, and status changes to the linked side', async () => {
    const db = freshDb();
    seedTransferPair(db, 'link-abc');

    await applyTransactionUpdate(
      adapt(db),
      {
        id: 'from-txn',
        accountId: 'acc-pnc',
        txnDate: '2026-05-12',
        memo: 'Updated memo',
        status: 'reconciled',
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    const toRow = db
      .prepare(
        'SELECT txn_date, memo, status, _sync_status FROM transactions WHERE id = ?'
      )
      .get('to-txn') as {
      txn_date: string;
      memo: string;
      status: string;
      _sync_status: string;
    };

    expect(toRow.txn_date).toBe('2026-05-12');
    expect(toRow.memo).toBe('Updated memo');
    expect(toRow.status).toBe('reconciled');
    expect(toRow._sync_status).toBe('pending');
  });

  it('does not propagate payee or check_number to the linked side', async () => {
    const db = freshDb();
    seedTransferPair(db, 'link-abc');

    await applyTransactionUpdate(
      adapt(db),
      {
        id: 'from-txn',
        accountId: 'acc-pnc',
        payee: 'RENAMED ON FROM SIDE',
        checkNumber: '9999',
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    const toRow = db
      .prepare('SELECT payee, check_number FROM transactions WHERE id = ?')
      .get('to-txn') as { payee: string; check_number: string | null };

    expect(toRow.payee).toBe('Transfer from PNC');
    expect(toRow.check_number).toBeNull();
  });

  it('skips the linked deleted row and leaves linkedTransactionId null', async () => {
    const db = freshDb();
    seedTransferPair(db, 'link-abc');
    db.prepare(
      "UPDATE transactions SET _sync_status = 'deleted' WHERE id = 'to-txn'"
    ).run();

    const result = await applyTransactionUpdate(
      adapt(db),
      {
        id: 'from-txn',
        accountId: 'acc-pnc',
        amount: -10,
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    expect(result.linkedTransactionId).toBeNull();
    expect(result.linkedAccountId).toBeNull();

    const toRow = db
      .prepare('SELECT amount, _sync_status FROM transactions WHERE id = ?')
      .get('to-txn') as { amount: number; _sync_status: string };
    expect(toRow.amount).toBe(66.76);
    expect(toRow._sync_status).toBe('deleted');
  });

  it('rolls back the primary update when the linked update fails', async () => {
    const db = freshDb();
    seedTransferPair(db, 'link-abc');

    const base = adapt(db);
    // Fail only on the second (linked) UPDATE; the first one (primary) succeeds.
    let updateCalls = 0;
    const flaky: TxnDb = {
      ...base,
      runAsync: async (sql, params) => {
        if (sql.startsWith('UPDATE transactions SET ')) {
          updateCalls++;
          if (updateCalls === 2) {
            throw new Error('simulated linked-update failure');
          }
        }
        return base.runAsync(sql, params);
      },
    };

    await expect(
      applyTransactionUpdate(
        flaky,
        { id: 'from-txn', accountId: 'acc-pnc', amount: -63.43 },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
      )
    ).rejects.toThrow('simulated linked-update failure');

    // Both rows must retain their pre-edit values — neither side committed.
    const rows = db
      .prepare(
        'SELECT id, amount, _sync_status, updated_at FROM transactions ORDER BY id'
      )
      .all() as Array<{
      id: string;
      amount: number;
      _sync_status: string;
      updated_at: string;
    }>;

    const fromRow = rows.find((r) => r.id === 'from-txn')!;
    const toRow = rows.find((r) => r.id === 'to-txn')!;

    expect(fromRow.amount).toBe(-66.76);
    expect(toRow.amount).toBe(66.76);
    expect(fromRow._sync_status).toBe('synced');
    expect(toRow._sync_status).toBe('synced');
    expect(fromRow.updated_at).toBe('2026-05-10T00:00:00Z');
    expect(toRow.updated_at).toBe('2026-05-10T00:00:00Z');
  });

  it('is a no-op for non-transfer transactions', async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, txn_date, payee, amount, memo, status,
          transfer_link_id, created_at, updated_at, _sync_status)
       VALUES ('solo', 'user-1', 'acc-pnc', '2026-05-10', 'Coffee', -4.5, NULL,
         'cleared', NULL, '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z', 'synced')`
    ).run();

    const result = await applyTransactionUpdate(
      adapt(db),
      { id: 'solo', accountId: 'acc-pnc', amount: -5 },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    expect(result.linkedTransactionId).toBeNull();
    expect(result.linkedAccountId).toBeNull();

    const row = db
      .prepare('SELECT amount, _sync_status FROM transactions WHERE id = ?')
      .get('solo') as { amount: number; _sync_status: string };
    expect(row.amount).toBe(-5);
    expect(row._sync_status).toBe('pending');
  });
});

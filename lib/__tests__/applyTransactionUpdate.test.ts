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
      updated_at TEXT,
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

  it('stamps the rewritten splits so the push can guard on them, and marks the replaced ones deleted', async () => {
    // #20: an edit replaces the splits wholesale (new ids, 'pending'), and each
    // replacement must carry the same `now` as its parent. Without a timestamp
    // the push cannot tell the rows it uploaded from the rows an edit like this
    // one put in their place, and marks the replacement 'synced' unsent.
    //
    // #97: the replaced row is marked 'deleted', not dropped. The push replaces
    // the server's split set only for a parent carrying an unsynced split row,
    // and leaves a 'deleted' one out of the upload.
    const db = freshDb();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, txn_date, payee, amount, memo, status,
          transfer_link_id, created_at, updated_at, _sync_status)
       VALUES ('solo', 'user-1', 'acc-pnc', '2026-05-10', 'Costco', -120, NULL,
         'cleared', NULL, '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z', 'synced')`
    ).run();
    db.prepare(
      `INSERT INTO transaction_splits
         (id, transaction_id, amount, memo, updated_at, _sync_status)
       VALUES ('old-split', 'solo', -120, 'Everything', '2026-05-10T00:00:00Z', 'synced')`
    ).run();

    let n = 0;
    await applyTransactionUpdate(
      adapt(db),
      {
        id: 'solo',
        accountId: 'acc-pnc',
        splits: [
          { amount: -80, memo: 'Groceries' },
          { amount: -40, memo: 'Household' },
        ],
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => `new-${++n}` }
    );

    const splits = db
      .prepare('SELECT * FROM transaction_splits ORDER BY id')
      .all() as {
      id: string;
      amount: number;
      memo: string | null;
      updated_at: string | null;
      _sync_status: string;
    }[];

    expect(splits).toEqual([
      {
        id: 'new-1',
        transaction_id: 'solo',
        amount: -80,
        memo: 'Groceries',
        updated_at: '2026-05-13T10:00:00Z',
        _sync_status: 'pending',
      },
      {
        id: 'new-2',
        transaction_id: 'solo',
        amount: -40,
        memo: 'Household',
        updated_at: '2026-05-13T10:00:00Z',
        _sync_status: 'pending',
      },
      {
        id: 'old-split',
        transaction_id: 'solo',
        amount: -120,
        memo: 'Everything',
        updated_at: '2026-05-13T10:00:00Z',
        _sync_status: 'deleted',
      },
    ]);
  });

  it('marks every split deleted when they are all removed, one never pushed included', async () => {
    // #97: `splits: []` must leave something for the push to act on. Dropping
    // the rows left the parent with no unsynced split, so the push uploaded it
    // alone and the server kept the splits the user had removed.
    const db = freshDb();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, txn_date, payee, amount, memo, status,
          transfer_link_id, created_at, updated_at, _sync_status)
       VALUES ('solo', 'user-1', 'acc-pnc', '2026-05-10', 'Costco', -120, NULL,
         'cleared', NULL, '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z', 'synced')`
    ).run();
    const insertSplit = db.prepare(
      `INSERT INTO transaction_splits
         (id, transaction_id, amount, memo, updated_at, _sync_status)
       VALUES (?, 'solo', -60, NULL, ?, ?)`
    );
    insertSplit.run('synced-split', '2026-05-10T00:00:00Z', 'synced');
    // An earlier edit's split that has not reached the server yet.
    insertSplit.run('unpushed-split', '2026-05-12T00:00:00Z', 'pending');

    await applyTransactionUpdate(
      adapt(db),
      { id: 'solo', accountId: 'acc-pnc', splits: [] },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    const splits = db
      .prepare(
        'SELECT id, _sync_status, updated_at FROM transaction_splits ORDER BY id'
      )
      .all();
    expect(splits).toEqual([
      {
        id: 'synced-split',
        _sync_status: 'deleted',
        updated_at: '2026-05-13T10:00:00Z',
      },
      {
        id: 'unpushed-split',
        _sync_status: 'deleted',
        updated_at: '2026-05-13T10:00:00Z',
      },
    ]);
    const parent = db
      .prepare('SELECT _sync_status FROM transactions WHERE id = ?')
      .get('solo') as { _sync_status: string };
    expect(parent._sync_status).toBe('pending');
  });

  it('leaves the splits alone when the edit does not touch them', async () => {
    // The push relies on it (#97): a parent edited without touching its splits
    // carries no unsynced split row, so it is uploaded alone and the server
    // keeps the set it has, which this device's copy may not match.
    const db = freshDb();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, txn_date, payee, amount, memo, status,
          transfer_link_id, created_at, updated_at, _sync_status)
       VALUES ('solo', 'user-1', 'acc-pnc', '2026-05-10', 'Costco', -120, NULL,
         'cleared', NULL, '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z', 'synced')`
    ).run();
    db.prepare(
      `INSERT INTO transaction_splits
         (id, transaction_id, amount, memo, updated_at, _sync_status)
       VALUES ('kept', 'solo', -120, NULL, '2026-05-10T00:00:00Z', 'synced')`
    ).run();

    await applyTransactionUpdate(
      adapt(db),
      { id: 'solo', accountId: 'acc-pnc', payee: 'Costco Wholesale' },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    expect(
      db
        .prepare(
          'SELECT id, _sync_status, updated_at FROM transaction_splits ORDER BY id'
        )
        .all()
    ).toEqual([
      {
        id: 'kept',
        _sync_status: 'synced',
        updated_at: '2026-05-10T00:00:00Z',
      },
    ]);
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

/**
 * The text an update rejected with, or null when it resolved. Compared as a
 * string with the state it left, in one assertion, so a failing run shows
 * the error and the rows together.
 */
async function rejection(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return String(e);
  }
}

function seedSolo(db: Database.Database) {
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, txn_date, payee, amount, memo, status,
        transfer_link_id, created_at, updated_at, _sync_status)
     VALUES ('solo', 'user-1', 'acc-pnc', '2026-05-10', 'Costco', -120, NULL,
       'cleared', NULL, '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z', 'synced')`
  ).run();
}

// #127. An update can meet no row: one queued behind the reset's wipe runs
// over the emptied store (#110 orders it after the wipe), and one that a
// tombstone delete beat to its transaction finds the row gone. The labels
// continue U1-U3, which PR #106 gave the tests above.
describe('applyTransactionUpdate over a transaction that no longer exists (#127)', () => {
  it('U7 (pin): a normal update still returns the mapped row and its linked leg', async () => {
    // Green before #127 too: the success path through the new check.
    const db = freshDb();
    seedTransferPair(db, 'link-abc');

    const result = await applyTransactionUpdate(
      adapt(db),
      { id: 'from-txn', accountId: 'acc-pnc', amount: -63.43 },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
    );

    expect(result).toEqual({
      txn: expect.objectContaining({
        id: 'from-txn',
        accountId: 'acc-pnc',
        amount: -63.43,
        updatedAt: '2026-05-13T10:00:00Z',
      }),
      linkedAccountId: 'acc-chase',
      linkedTransactionId: 'to-txn',
    });
  });

  it('U10 (pin): splitting a transaction that has no splits yet writes them, since the check is on the transaction, not its splits', async () => {
    // Green before #127 too. A check on the split-mark UPDATE instead of the
    // transaction's would refuse this edit: the mark matches no row when there
    // is nothing to replace, exactly as it does when the transaction is gone.
    const db = freshDb();
    seedSolo(db);
    let n = 0;

    const result = await applyTransactionUpdate(
      adapt(db),
      {
        id: 'solo',
        accountId: 'acc-pnc',
        splits: [
          { amount: -80, memo: 'Groceries' },
          { amount: -40, memo: 'Household' },
        ],
      },
      { now: '2026-05-13T10:00:00Z', newSplitId: () => `new-${++n}` }
    );

    expect(result.txn.id).toBe('solo');
    expect(
      db
        .prepare(
          'SELECT id, amount, _sync_status FROM transaction_splits ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'new-1', amount: -80, _sync_status: 'pending' },
      { id: 'new-2', amount: -40, _sync_status: 'pending' },
    ]);
  });

  it('U4: an update of a transaction that no longer exists rejects with the readable error and leaves no split rows behind', async () => {
    // Before #127: "TypeError: Cannot read properties of null (reading
    // 'id')", from mapTransaction after the COMMIT, which had already written
    // new-1 and new-2 as pending splits of a transaction that is not here.
    const db = freshDb();
    let n = 0;

    const err = await rejection(
      applyTransactionUpdate(
        adapt(db),
        {
          id: 'gone',
          accountId: 'acc-pnc',
          amount: -10,
          splits: [
            { amount: -4, memo: null },
            { amount: -6, memo: null },
          ],
        },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => `new-${++n}` }
      )
    );

    expect({
      err,
      splits: db
        .prepare(
          "SELECT id, _sync_status FROM transaction_splits WHERE transaction_id = 'gone' ORDER BY id"
        )
        .all(),
      open: db.inTransaction,
    }).toEqual({
      err: expect.stringMatching(/no longer exists/),
      splits: [],
      open: false,
    });
  });

  it('U5: an update of a transaction that no longer exists, without splits (the only shape a caller passes today), rejects with the readable error and writes nothing', async () => {
    // Before #127: the TypeError, which Settings showed as "Sync issue: Save
    // failed: Cannot read properties of null (reading 'id')".
    const db = freshDb();

    const err = await rejection(
      applyTransactionUpdate(
        adapt(db),
        { id: 'gone', accountId: 'acc-pnc', amount: -10 },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
      )
    );

    expect({
      err,
      transactions: db.prepare('SELECT id FROM transactions').all(),
      splits: db.prepare('SELECT id FROM transaction_splits').all(),
      open: db.inTransaction,
    }).toEqual({
      err: expect.stringMatching(/no longer exists/),
      transactions: [],
      splits: [],
      open: false,
    });
  });

  it('U9: the row vanishing between its UPDATE and the final read rejects with the readable error, not a TypeError', async () => {
    // Not expected: once the UPDATE has made the row pending, only the push's
    // read-back drop could delete it, and only after a whole upload round
    // trip between two of the update's statements. The raw DELETE stands in
    // for it. Before #127: the TypeError.
    const db = freshDb();
    seedSolo(db);
    const base = adapt(db);
    let vanished = false;
    const vanishing: TxnDb = {
      ...base,
      getFirstAsync: async <T>(sql: string, params: any[]) => {
        if (sql.startsWith('SELECT * FROM transactions WHERE id')) {
          db.prepare('DELETE FROM transactions WHERE id = ?').run('solo');
          vanished = true;
        }
        return base.getFirstAsync<T>(sql, params);
      },
    };

    const err = await rejection(
      applyTransactionUpdate(
        vanishing,
        { id: 'solo', accountId: 'acc-pnc', payee: 'Costco Wholesale' },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
      )
    );

    expect({ vanished, err, open: db.inTransaction }).toEqual({
      vanished: true,
      err: expect.stringMatching(/no longer exists/),
      open: false,
    });
  });
});

// #139. A transaction this device has deleted is still a row, marked
// 'deleted' until the push uploads the delete, and the parent UPDATE matched
// it: the edit set it back to 'pending' and the delete was lost. Offline, a
// Delete then a Save on the edit screen both wait, and run in that order on
// reconnect; a status toggle from a register that has not refetched since a
// delete does the same online. The labels continue U10 above.
describe('applyTransactionUpdate over a transaction this device has deleted (#139)', () => {
  /** When the delete marked solo and its splits. */
  const DELETED_AT = '2026-05-12T09:00:00Z';

  /**
   * solo with two synced splits, then the two marks applyTransactionDelete
   * makes (lib/transactionDelete.ts): the splits, then the transaction.
   */
  function seedDeletedSolo(db: Database.Database) {
    seedSolo(db);
    const split = db.prepare(
      `INSERT INTO transaction_splits
         (id, transaction_id, amount, memo, updated_at, _sync_status)
       VALUES (?, 'solo', ?, NULL, '2026-05-10T00:00:00Z', 'synced')`
    );
    split.run('old-1', -70);
    split.run('old-2', -50);
    db.prepare(
      "UPDATE transaction_splits SET _sync_status = 'deleted', updated_at = ? WHERE transaction_id = 'solo'"
    ).run(DELETED_AT);
    db.prepare(
      "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = 'solo'"
    ).run(DELETED_AT);
  }

  it('U11: an edit with splits of a transaction this device deleted rejects with its own error and writes nothing, the delete left as it was', async () => {
    // Before #139: the edit resolved. solo went back to 'pending' at the
    // edit's stamp, with new-1 and new-2 pending under it.
    const db = freshDb();
    seedDeletedSolo(db);
    let n = 0;

    const err = await rejection(
      applyTransactionUpdate(
        adapt(db),
        {
          id: 'solo',
          accountId: 'acc-pnc',
          splits: [
            { amount: -80, memo: 'Groceries' },
            { amount: -40, memo: 'Household' },
          ],
        },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => `new-${++n}` }
      )
    );

    expect({
      err,
      solo: db
        .prepare(
          'SELECT updated_at, _sync_status FROM transactions WHERE id = ?'
        )
        .get('solo'),
      splits: db
        .prepare(
          'SELECT id, updated_at, _sync_status FROM transaction_splits ORDER BY id'
        )
        .all(),
      open: db.inTransaction,
    }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      solo: { updated_at: DELETED_AT, _sync_status: 'deleted' },
      splits: [
        { id: 'old-1', updated_at: DELETED_AT, _sync_status: 'deleted' },
        { id: 'old-2', updated_at: DELETED_AT, _sync_status: 'deleted' },
      ],
      open: false,
    });
  });

  it("U12: the register's status toggle over a transaction this device deleted is refused the same way", async () => {
    // Before #139: solo went back to 'pending', its status toggled, at the
    // toggle's stamp. This is the shape the register's checkbox passes
    // (toggleStatus in app/account/[id].tsx), and a list that has not
    // refetched since the delete still shows the row.
    const db = freshDb();
    seedDeletedSolo(db);

    const err = await rejection(
      applyTransactionUpdate(
        adapt(db),
        { id: 'solo', accountId: 'acc-pnc', status: 'pending' },
        { now: '2026-05-13T10:00:00Z', newSplitId: () => 'unused' }
      )
    );

    expect({
      err,
      solo: db
        .prepare(
          'SELECT status, updated_at, _sync_status FROM transactions WHERE id = ?'
        )
        .get('solo'),
      open: db.inTransaction,
    }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      solo: {
        status: 'cleared',
        updated_at: DELETED_AT,
        _sync_status: 'deleted',
      },
      open: false,
    });
  });
});

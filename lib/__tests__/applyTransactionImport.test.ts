// applyTransactionImport (#163): the CSV import's write, moved out of
// app/import.tsx so it can be tested. It refuses an account this device has
// deleted or no longer has, writes all the rows or none, and keeps the
// screen's dedup. A new module: its tests cannot load on the code before
// #163, so their red proofs are the named mutants (the unit's mutant table).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyAccountDelete } from '../accountDelete';
import {
  applyTransactionImport,
  IMPORT_INSERT_SQL,
} from '../transactionImport';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const NOW = '2026-10-15T12:00:00.000Z';
const DELETED_AT = '2026-10-15T11:00:00.000Z';

const DELETED_HERE =
  'Error: This account was deleted on this device, so nothing was imported.';
const GONE =
  'Error: This account no longer exists on this device, so nothing was imported.';

let adapter: ReturnType<typeof makeAdapter>;

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

beforeEach(async () => {
  adapter = makeAdapter();
  await insertLocalAccount(adapter, { id: 'a1' });
  // An existing row of a1: a later CSV row like it is a duplicate.
  await insertLocalTxn(adapter, {
    id: 't1',
    account_id: 'a1',
    txn_date: '2026-10-01',
    payee: 'Rent',
    amount: -1500,
  });
});

afterEach(() => {
  adapter._sqlite.close();
});

const ROWS = [
  { date: '2026-10-01', payee: 'Rent', amount: -1500, memo: '' },
  { date: '2026-10-02', payee: 'Grocer', amount: -42.5, memo: 'weekly' },
  { date: '2026-10-02', payee: 'Grocer', amount: -42.5, memo: 'again' },
  { date: '2026-10-03', payee: '', amount: 100, memo: '' },
];

function input(accountId = 'a1', rows = ROWS) {
  return { userId: 'u', accountId, rows };
}

/** `id:account:payee:amount:status:_sync_status` for every row but t1. */
function imported(): string[] {
  return (
    adapter._sqlite
      .prepare(
        "SELECT id, account_id, payee, amount, memo, status, _sync_status FROM transactions WHERE id != 't1' ORDER BY id"
      )
      .all() as any[]
  ).map(
    (r) =>
      `${r.id}:${r.account_id}:${r.payee}:${r.amount}:${r.memo}:${r.status}:${r._sync_status}`
  );
}

/** Rejection as a string: never rejects.toThrow() beside better-sqlite3. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await p);
  } catch (e) {
    return String(e);
  }
}

describe('applyTransactionImport (#163)', () => {
  it('M1: refuses an account this device has deleted, and imports nothing', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input(), { now: NOW, newId: ids() })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: DELETED_HERE,
      imported: [],
    });
  });

  it('M2: refuses an account no longer on this device, and imports nothing', async () => {
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input(), { now: NOW, newId: ids() })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: GONE,
      imported: [],
    });
  });

  it('M3 (pin): a live account takes the new rows, cleared and pending, skipping duplicates', async () => {
    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input(), { now: NOW, newId: ids() })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 2, skipped: 2 }),
      imported: [
        'id-1:a1:Grocer:-42.5:weekly:cleared:pending',
        'id-2:a1:(imported):100:null:cleared:pending',
      ],
    });
  });

  // One transaction: an INSERT that fails part-way leaves none of the batch
  // behind. The screen's loop of plain INSERTs left the rows before it.
  it('M4: a failed INSERT part-way imports nothing', async () => {
    let inserts = 0;
    const flaky = {
      ...adapter,
      runAsync: async (sql: string, params: any[] = []) => {
        if (sql === IMPORT_INSERT_SQL && ++inserts === 2) {
          throw new Error('simulated failure on the second row');
        }
        return adapter.runAsync(sql, params);
      },
    };

    const outcome = await outcomeOf(
      applyTransactionImport(flaky, input(), { now: NOW, newId: ids() })
    );

    expect({ outcome, inserts, imported: imported() }).toEqual({
      outcome: 'Error: simulated failure on the second row',
      inserts: 2,
      imported: [],
    });
  });

  // Return-then-throw: the refusal is thrown after the COMMIT, so a plain
  // statement that joined the transaction -- a pull's tombstone DELETE of
  // another row, landing while the account read runs -- stays committed.
  it('M5: a plain write that joins the refused transaction stays committed', async () => {
    await insertLocalAccount(adapter, { id: 'a2' });
    await insertLocalTxn(adapter, { id: 't-other', account_id: 'a2' });
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();
    let joined = false;
    const joining = {
      ...adapter,
      getAllAsync: async (sql: string, params: any[] = []) => {
        if (!joined && /FROM accounts/.test(sql)) {
          joined = true;
          await adapter.runAsync(
            "DELETE FROM transactions WHERE id = 't-other' AND _sync_status = 'synced'",
            []
          );
        }
        return adapter.getAllAsync(sql, params);
      },
    };

    const outcome = await outcomeOf(
      applyTransactionImport(joining, input(), { now: NOW, newId: ids() })
    );

    expect({
      joined,
      outcome,
      other: adapter._sqlite
        .prepare("SELECT id FROM transactions WHERE id = 't-other'")
        .get(),
      open: adapter._sqlite.inTransaction,
    }).toEqual({ joined: true, outcome: GONE, other: undefined, open: false });
  });

  // The account read is inside the transaction: an account delete started
  // the moment it answers queues behind the batch, then marks the imported
  // rows deleted with the account. Read before the transaction, the delete
  // would run first and the rows would land after it, pending under a
  // deleted account.
  it('M6: an account delete started during the import cannot land between its check and its rows', async () => {
    let fired = false;
    let deleting: Promise<void> | null = null;
    const racing = {
      ...adapter,
      getAllAsync: async (sql: string, params: any[] = []) => {
        const out = await adapter.getAllAsync(sql, params);
        if (!fired && /FROM accounts/.test(sql)) {
          fired = true;
          deleting = applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
        }
        return out;
      },
    };

    const outcome = await outcomeOf(
      applyTransactionImport(racing, input(), { now: NOW, newId: ids() })
    );
    await deleting;

    expect({
      fired,
      outcome,
      pendingUnderDeleted: adapter._sqlite
        .prepare(
          "SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t._sync_status = 'pending' AND a._sync_status = 'deleted'"
        )
        .all(),
    }).toEqual({
      fired: true,
      outcome: JSON.stringify({ imported: 2, skipped: 2 }),
      pendingUnderDeleted: [],
    });
  });

  it.each([
    ['NULL', null],
    ['pending', 'pending'],
  ])(
    'M7 (pin): an account whose status is %s takes the rows',
    async (_label, status) => {
      adapter._sqlite
        .prepare("UPDATE accounts SET _sync_status = ? WHERE id = 'a1'")
        .run(status);

      const outcome = await outcomeOf(
        applyTransactionImport(adapter, input(), { now: NOW, newId: ids() })
      );

      expect(outcome).toBe(JSON.stringify({ imported: 2, skipped: 2 }));
    }
  );

  // The dedup reads live rows only, as the screen did: a row this device
  // deleted does not make its re-import a duplicate.
  it('M8 (pin): a deleted row of the account is not a duplicate', async () => {
    adapter._sqlite
      .prepare(
        "UPDATE transactions SET _sync_status = 'deleted' WHERE id = 't1'"
      )
      .run();

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input('a1', [ROWS[0]]), {
        now: NOW,
        newId: ids(),
      })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 1, skipped: 0 }),
      imported: ['id-1:a1:Rent:-1500:null:cleared:pending'],
    });
  });
});

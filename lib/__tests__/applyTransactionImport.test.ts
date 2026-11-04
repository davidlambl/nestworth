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
import { parseCSV } from '../csvImport';
import {
  applyTransactionImport,
  IMPORT_DEDUP_SQL,
  IMPORT_INSERT_SQL,
  importDedupWindow,
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
  {
    date: '2026-10-01',
    rawDate: '2026-10-01',
    payee: 'Rent',
    amount: -1500,
    memo: '',
  },
  {
    date: '2026-10-02',
    rawDate: '2026-10-02',
    payee: 'Grocer',
    amount: -42.5,
    memo: 'weekly',
  },
  {
    date: '2026-10-02',
    rawDate: '2026-10-02',
    payee: 'Grocer',
    amount: -42.5,
    memo: 'again',
  },
  {
    date: '2026-10-03',
    rawDate: '2026-10-03',
    payee: '',
    amount: 100,
    memo: '',
  },
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

// The dedup compares dates as stored, and the server stores a date as
// YYYY-MM-DD whatever form the file wrote it in. A row imported from
// "10/1/26" came back from the server as 2026-10-01, and importing the same
// file again added it a second time: the import stored "10/1/26" as written
// (#36).
describe('a file imported again is skipped whatever form its dates take (#36)', () => {
  it('D11: a two-digit-year row matches the stored row it became', async () => {
    const csv = `Date,Title,Amount
10/1/26,Rent,-1500.00`;

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input('a1', parseCSV(csv).rows), {
        now: NOW,
        newId: ids(),
      })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 0, skipped: 1 }),
      imported: [],
    });
  });
});

// The import keeps only a date's day (#36), so two lines of one day are told
// apart by the date as the file wrote it, and a stored row of that day covers
// one line, not every one. Matched on the day alone, a payment app's two
// subway fares of one day were one transaction, the second "a duplicate".
describe('the lines of one day stay apart when their times differ (#36)', () => {
  const FARES = `Date,Description,Amount
2026-01-15T08:10:00,MTA Subway,-2.90
2026-01-15T18:40:00,MTA Subway,-2.90
1/15/2026 9:00 AM,Coffee,-4.50
1/15/2026 3:00 PM,Coffee,-4.50`;

  it('D12: two fares of one day at different times are both imported', async () => {
    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input('a1', parseCSV(FARES).rows), {
        now: NOW,
        newId: ids(),
      })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 4, skipped: 0 }),
      imported: [
        'id-1:a1:MTA Subway:-2.9:null:cleared:pending',
        'id-2:a1:MTA Subway:-2.9:null:cleared:pending',
        'id-3:a1:Coffee:-4.5:null:cleared:pending',
        'id-4:a1:Coffee:-4.5:null:cleared:pending',
      ],
    });
  });

  // The morning fare came in with an earlier export, made before the evening
  // one, and a pull has since written it back as the server stores it.
  it('D13: a stored row of that day covers one of its lines, not each of them', async () => {
    await insertLocalTxn(adapter, {
      id: 't2',
      account_id: 'a1',
      txn_date: '2026-01-15',
      payee: 'MTA Subway',
      amount: -2.9,
    });
    const csv = `Date,Description,Amount
2026-01-15T08:10:00,MTA Subway,-2.90
2026-01-15T18:40:00,MTA Subway,-2.90`;

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input('a1', parseCSV(csv).rows), {
        now: NOW,
        newId: ids(),
      })
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 1, skipped: 1 }),
      imported: [
        'id-1:a1:MTA Subway:-2.9:null:cleared:pending',
        't2:a1:MTA Subway:-2.9:null:cleared:synced',
      ],
    });
  });

  it('D14 (pin): the same file imported again adds nothing', async () => {
    const newId = ids();
    const rows = parseCSV(FARES).rows;
    await applyTransactionImport(adapter, input('a1', rows), {
      now: NOW,
      newId,
    });

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input('a1', rows), { now: NOW, newId })
    );

    expect(outcome).toBe(JSON.stringify({ imported: 0, skipped: 4 }));
  });

  // A row skipped as stored still counts as read: its repeat later in the
  // file is a repeat, not a second row the stored one did not cover.
  it('D15 (pin): a file with a repeated row adds nothing when imported again', async () => {
    const newId = ids();
    await applyTransactionImport(adapter, input(), { now: NOW, newId });

    const outcome = await outcomeOf(
      applyTransactionImport(adapter, input(), { now: NOW, newId })
    );

    expect(outcome).toBe(JSON.stringify({ imported: 0, skipped: 4 }));
  });
});

// #30: the dedup used to read the account's whole history on every import --
// every live transaction of the account held in memory to build the counts.
// A stored transaction can match a row only on the row's own day (the date
// is the first part of the key), so the read now takes the days from the
// batch's earliest date to its latest, and nothing else. The rule is the
// same: B7 holds the import to it over random histories and files.
describe('importDedupWindow (#30)', () => {
  const row = (date: string, rawDate = date) => ({ date, rawDate });

  it.each([
    ['no rows', [], null],
    ['one row', [row('2026-03-14')], { from: '2026-03-14', to: '2026-03-14' }],
    [
      'rows of one day',
      [
        row('2026-03-14', '2026-03-14T08:10:00'),
        row('2026-03-14', '2026-03-14T18:40:00'),
      ],
      { from: '2026-03-14', to: '2026-03-14' },
    ],
    [
      'rows out of order, the first line neither end',
      [
        row('2026-03-15'),
        row('2026-03-31'),
        row('2026-02-28'),
        row('2026-03-01'),
      ],
      { from: '2026-02-28', to: '2026-03-31' },
    ],
    [
      'the parsed day, never the date as the file wrote it',
      [row('2026-01-15', '1/15/2026 9:00 AM'), row('2025-12-31', '12/31/2025')],
      { from: '2025-12-31', to: '2026-01-15' },
    ],
  ])('W: %s', (_label, rows, expected) => {
    expect(importDedupWindow(rows)).toStrictEqual(expected);
  });
});

describe('the dedup reads only the days the file covers (#30)', () => {
  /**
   * The adapter, with every row its reads of the transactions table return
   * recorded. Matched on the table, not on the statement's text, so a
   * reformatted SELECT is still seen.
   */
  function recording() {
    const read: { txn_date: string }[] = [];
    let reads = 0;
    const db = {
      ...adapter,
      getAllAsync: async (sql: string, params: any[] = []) => {
        const rows = await adapter.getAllAsync(sql, params);
        if (/\bfrom\s+transactions\b/i.test(sql)) {
          reads++;
          for (const r of rows as { txn_date: string }[]) {
            read.push(r);
          }
        }
        return rows;
      },
    };
    return { db, read, reads: () => reads };
  }

  /** The first and the last txn_date read, in text order. */
  function span(read: { txn_date: string }[]): string[] {
    const days = read.map((r) => r.txn_date).sort();
    return days.length ? [days[0], days[days.length - 1]] : [];
  }

  /** A row the file would hand on: parseCSV's shape. */
  function line(date: string, payee: string, amount: number, rawDate = date) {
    return { date, rawDate, payee, amount, memo: '' };
  }

  it('B1: a ten-year history is read only on the days the file covers', async () => {
    // 10,000 live rows of a1 from 2016-01-01 to 2025-12-31, beside t1.
    const insert = adapter._sqlite.prepare(
      "INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, _sync_status) VALUES (?, 'u', 'a1', ?, ?, ?, 'cleared', 'synced')"
    );
    const day0 = Date.UTC(2016, 0, 1);
    adapter._sqlite.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const day = new Date(
          day0 + Math.floor((i * 3653) / 10_000) * 86_400_000
        );
        insert.run(
          `h${i}`,
          day.toISOString().slice(0, 10),
          `Payee ${i % 50}`,
          -((i % 500) + 1) / 100
        );
      }
    })();
    const on = (date: string) =>
      adapter._sqlite
        .prepare(
          "SELECT txn_date, payee, amount FROM transactions WHERE account_id = 'a1' AND txn_date = ? ORDER BY id LIMIT 1"
        )
        .get(date) as { txn_date: string; payee: string; amount: number };
    const first = on('2025-06-10');
    const last = on('2025-06-20');
    // A payee and amount stored on other days, never on 2025-06-12: the
    // file's line on that day is not a duplicate, the date being in the key.
    const elsewhere = on('2019-03-05');
    const rows = [
      line(first.txn_date, first.payee, first.amount),
      line('2025-06-12', elsewhere.payee, elsewhere.amount),
      line(last.txn_date, last.payee, last.amount),
      line(first.txn_date, first.payee, first.amount),
    ];
    const inSpan = (
      adapter._sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'a1' AND _sync_status != 'deleted' AND txn_date BETWEEN '2025-06-10' AND '2025-06-20'"
        )
        .get() as { n: number }
    ).n;
    const { db, read } = recording();

    const outcome = await outcomeOf(
      applyTransactionImport(db, input('a1', rows), { now: NOW, newId: ids() })
    );

    expect({ outcome, rowsRead: read.length, daysRead: span(read) }).toEqual({
      outcome: JSON.stringify({ imported: 1, skipped: 3 }),
      rowsRead: inSpan,
      daysRead: ['2025-06-10', '2025-06-20'],
    });
    expect(inSpan).toBeLessThan(50);
  });

  it('B2: a file of one day reads that day alone', async () => {
    for (const [id, date, payee] of [
      ['d13', '2026-03-13', 'Coffee'],
      ['d14', '2026-03-14', 'Coffee'],
      ['d14b', '2026-03-14', 'Lunch'],
      ['d15', '2026-03-15', 'Coffee'],
    ]) {
      await insertLocalTxn(adapter, {
        id,
        account_id: 'a1',
        txn_date: date,
        payee,
        amount: -4.5,
      });
    }
    const { db, read } = recording();

    const outcome = await outcomeOf(
      applyTransactionImport(
        db,
        input('a1', [
          line('2026-03-14', 'Coffee', -4.5, '2026-03-14T08:10:00'),
          line('2026-03-14', 'Tea', -3, '2026-03-14T15:00:00'),
        ]),
        { now: NOW, newId: ids() }
      )
    );

    expect({ outcome, daysRead: read.map((r) => r.txn_date) }).toEqual({
      outcome: JSON.stringify({ imported: 1, skipped: 1 }),
      daysRead: ['2026-03-14', '2026-03-14'],
    });
  });

  it('B3 (pin): a stored row on the first day of the file and one on its last day are both duplicates', async () => {
    await insertLocalTxn(adapter, {
      id: 'mar1',
      account_id: 'a1',
      txn_date: '2026-03-01',
      payee: 'Gym',
      amount: -40,
    });
    await insertLocalTxn(adapter, {
      id: 'mar31',
      account_id: 'a1',
      txn_date: '2026-03-31',
      payee: 'Rent',
      amount: -1500,
    });

    // Out of order, as an export may be: the last day first.
    const outcome = await outcomeOf(
      applyTransactionImport(
        adapter,
        input('a1', [
          line('2026-03-31', 'Rent', -1500),
          line('2026-03-15', 'Grocer', -42.5),
          line('2026-03-01', 'Gym', -40),
        ]),
        { now: NOW, newId: ids() }
      )
    );

    expect({ outcome, imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 1, skipped: 2 }),
      imported: [
        'id-1:a1:Grocer:-42.5:null:cleared:pending',
        'mar1:a1:Gym:-40:null:cleared:synced',
        'mar31:a1:Rent:-1500:null:cleared:synced',
      ],
    });
  });

  it('B4: a batch with no rows reads nothing and imports nothing', async () => {
    const { db, reads } = recording();

    const outcome = await outcomeOf(
      applyTransactionImport(db, input('a1', []), { now: NOW, newId: ids() })
    );

    expect({ outcome, reads: reads(), imported: imported() }).toEqual({
      outcome: JSON.stringify({ imported: 0, skipped: 0 }),
      reads: 0,
      imported: [],
    });
  });

  it.each([
    ['no rows', []],
    ['four rows', ROWS],
  ])(
    'B5 (pin): a batch with %s into an account deleted here is refused before the dedup reads a transaction',
    async (_label, rows) => {
      await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      const { db, reads } = recording();

      const outcome = await outcomeOf(
        applyTransactionImport(db, input('a1', rows), {
          now: NOW,
          newId: ids(),
        })
      );

      expect({ outcome, reads: reads() }).toEqual({
        outcome: DELETED_HERE,
        reads: 0,
      });
    }
  );

  it('B6 (pin): a stored row of the same payee and amount on the day before or after is not a duplicate', async () => {
    for (const [id, date] of [
      ['before', '2026-03-13'],
      ['after', '2026-03-15'],
    ]) {
      await insertLocalTxn(adapter, {
        id,
        account_id: 'a1',
        txn_date: date,
        payee: 'Coffee',
        amount: -4.5,
      });
    }

    const outcome = await outcomeOf(
      applyTransactionImport(
        adapter,
        input('a1', [line('2026-03-14', 'Coffee', -4.5)]),
        { now: NOW, newId: ids() }
      )
    );

    expect(outcome).toBe(JSON.stringify({ imported: 1, skipped: 0 }));
  });

  // The dedup's read is inside the import's transaction, with the INSERTs it
  // guards: a second import waits in the queue (#110) for the first to commit,
  // then reads its rows. Read before the transaction, both would find nothing
  // stored and both would write the file.
  it('B8 (pin): two imports of one file started together write it once', async () => {
    const rows = [
      line('2026-03-14', 'Coffee', -4.5),
      line('2026-03-15', 'Lunch', -12),
    ];
    const newId = ids();

    const outcomes = await Promise.all([
      outcomeOf(
        applyTransactionImport(adapter, input('a1', rows), { now: NOW, newId })
      ),
      outcomeOf(
        applyTransactionImport(adapter, input('a1', rows), { now: NOW, newId })
      ),
    ]);

    expect({ outcomes, imported: imported() }).toEqual({
      outcomes: [
        JSON.stringify({ imported: 2, skipped: 0 }),
        JSON.stringify({ imported: 0, skipped: 2 }),
      ],
      imported: [
        'id-1:a1:Coffee:-4.5:null:cleared:pending',
        'id-2:a1:Lunch:-12:null:cleared:pending',
      ],
    });
  });

  // A stored date holding the key's separator, as an import before #36 could
  // store one: "2026-01-31|x" with the payee "y" reads in the key as a line
  // of 2026-01-31 with the payee "x|y", which the import has always skipped
  // as that row's duplicate. Read only up to the last day itself, the row was
  // left out when the file ended on that day, and the line's answer turned on
  // the file's other lines.
  it.each([
    [
      'ends on that day',
      [line('2026-01-31', 'x|y', 5)],
      { imported: 0, skipped: 1 },
    ],
    [
      'runs a day past it',
      [line('2026-01-31', 'x|y', 5), line('2026-02-01', 'z', 1)],
      { imported: 1, skipped: 1 },
    ],
    [
      'starts a day before it',
      [line('2026-01-30', 'z', 1), line('2026-01-31', 'x|y', 5)],
      { imported: 1, skipped: 1 },
    ],
  ])(
    "B9 (pin): a stored date holding the key's separator is a duplicate as before when the file %s",
    async (_label, rows, expected) => {
      await insertLocalTxn(adapter, {
        id: 'pipe',
        account_id: 'a1',
        txn_date: '2026-01-31|x',
        payee: 'y',
        amount: 5,
      });

      const outcome = await outcomeOf(
        applyTransactionImport(adapter, input('a1', rows), {
          now: NOW,
          newId: ids(),
        })
      );

      expect(outcome).toBe(JSON.stringify(expected));
    }
  );

  // With an index led by (account_id, txn_date), as the one the register
  // reads its pages from (#28), the read is a range of that index rather than
  // a walk of every row of the account: its bounds are on the column itself,
  // never on a function of it.
  it('B10: the read is a range of an index led by (account_id, txn_date)', () => {
    adapter._sqlite.exec(
      'CREATE INDEX idx_test_account_date ON transactions(account_id, txn_date)'
    );

    const plan = (
      adapter._sqlite
        .prepare(`EXPLAIN QUERY PLAN ${IMPORT_DEDUP_SQL}`)
        .all('a1', '2026-03-01', '2026-03-31') as { detail: string }[]
    ).map((r) => r.detail);

    expect(plan).toEqual([
      expect.stringMatching(
        /USING INDEX idx_test_account_date \(account_id=\? AND txn_date>\? AND txn_date<\?\)/
      ),
    ]);
  });

  // The rule as the import applied it before #30, over every live row of the
  // account: the counts of stored (date, payee, amount), each covering one
  // row, and the repeats within the batch by the date as the file wrote it.
  function ruleOverWholeHistory(
    db: ReturnType<typeof makeAdapter>,
    rows: {
      date: string;
      rawDate: string;
      payee: string;
      amount: number;
      memo: string;
    }[]
  ) {
    const stored = new Map<string, number>();
    for (const e of db._sqlite
      .prepare(
        "SELECT txn_date, payee, amount FROM transactions WHERE account_id = 'a1' AND _sync_status != 'deleted'"
      )
      .all() as { txn_date: string; payee: string; amount: number }[]) {
      const key = `${e.txn_date}|${e.payee}|${e.amount}`;
      stored.set(key, (stored.get(key) ?? 0) + 1);
    }
    const read = new Set<string>();
    const written: string[] = [];
    let skipped = 0;
    for (const r of rows) {
      const payee = r.payee || '(imported)';
      const once = `${r.rawDate}|${payee}|${r.amount}`;
      if (read.has(once)) {
        skipped++;
        continue;
      }
      read.add(once);
      const key = `${r.date}|${payee}|${r.amount}`;
      const left = stored.get(key) ?? 0;
      if (left > 0) {
        stored.set(key, left - 1);
        skipped++;
        continue;
      }
      written.push(`${r.date}|${payee}|${r.amount}|${r.memo || null}`);
    }
    return {
      outcome: JSON.stringify({ imported: written.length, skipped }),
      written,
    };
  }

  /** A seeded generator (mulberry32): the same cases on every run. */
  function generator(seed: number) {
    let t = seed >>> 0;
    const next = () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    return {
      chance: (p: number) => next() < p,
      pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
      upTo: (n: number) => Math.floor(next() * (n + 1)),
    };
  }

  // Days the file can name, and stored dates no import writes since #36: a
  // pre-#36 import stored the date as the file wrote it, and the server
  // refuses such a row, so it stays here, pending. Among them, dates holding
  // the key's separator, '|': in the key, "2026-01-31|a" with the payee "b"
  // reads as a line of 2026-01-31 with the payee "a|b" (B9).
  const DAYS = [
    '2026-01-14',
    '2026-01-15',
    '2026-01-16',
    '2026-01-31',
    '2026-02-01',
  ];
  const ODD_DATES = [
    null,
    '',
    '2026-15-01',
    '1/15/2026',
    '2026-01-15T08:10:00',
    '2026-01-15 ',
    '2026-1-15',
    '2025-12-31',
    '2026-01-31|a',
    '2026-01-16|a',
    '2026-02-01|a',
  ];
  const PAYEES = [
    'Rent',
    'MTA Subway',
    'a|b',
    'a',
    'b|1',
    '(imported)',
    '',
    'null',
    'b',
  ];
  const AMOUNTS = [-2.9, -12.3, 12.3, 0, 100, 1, -1500];
  const STORED_AMOUNTS = [...AMOUNTS, -0, null, '12.30', 'b|1', '1|-1500'];
  const STATUSES = ['synced', 'synced', 'pending', 'deleted', null];
  const RAW = (date: string, g: ReturnType<typeof generator>) => {
    const [y, m, d] = date.split('-');
    return g.pick([
      date,
      `${date}T08:10:00`,
      `${date}T18:40:00`,
      `${Number(m)}/${Number(d)}/${y}`,
    ]);
  };

  it('B7 (pin): over 400 random histories and files, the import skips and writes what the rule over the whole history does', async () => {
    const results: unknown[] = [];
    const expected: unknown[] = [];
    for (let c = 0; c < 400; c++) {
      const g = generator(3000 + c);
      const db = makeAdapter();
      try {
        await insertLocalAccount(db, { id: 'a1' });
        await insertLocalAccount(db, { id: 'a2' });
        const history: { txn_date: any; payee: any; amount: any }[] = [];
        for (let i = 0, n = g.upTo(40); i < n; i++) {
          const t = {
            id: `s${i}`,
            user_id: g.chance(0.1) ? 'v' : 'u',
            account_id: g.chance(0.25) ? 'a2' : 'a1',
            txn_date: g.chance(0.15) ? g.pick(ODD_DATES) : g.pick(DAYS),
            payee: g.chance(0.05) ? null : g.pick(PAYEES),
            amount: g.pick(STORED_AMOUNTS),
            _sync_status: g.pick(STATUSES),
          };
          history.push(t);
          db._sqlite
            .prepare(
              "INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status) VALUES (?, ?, ?, ?, ?, ?, 'cleared', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)"
            )
            .run(
              t.id,
              t.user_id,
              t.account_id,
              t.txn_date,
              t.payee,
              t.amount,
              t._sync_status
            );
        }
        const rows = [];
        for (let i = 0, n = 1 + g.upTo(11); i < n; i++) {
          const copy =
            history.length > 0 && g.chance(0.5) ? g.pick(history) : null;
          // A stored date holding the separator ("2026-01-31|a", payee "b")
          // is copied as the line its key reads as (2026-01-31, "a|b").
          const [day, payee] =
            copy !== null &&
            typeof copy.txn_date === 'string' &&
            copy.txn_date.includes('|')
              ? [
                  copy.txn_date.slice(0, 10),
                  `${copy.txn_date.slice(11)}|${copy.payee}`,
                ]
              : [copy?.txn_date, copy?.payee];
          const usable =
            copy !== null &&
            DAYS.includes(day) &&
            typeof copy.payee === 'string' &&
            typeof copy.amount === 'number';
          const date = usable ? day : g.pick(DAYS);
          rows.push({
            date,
            rawDate: RAW(date, g),
            payee: usable ? payee : g.pick(PAYEES),
            amount: usable
              ? Object.is(copy.amount, -0)
                ? 0
                : copy.amount
              : g.pick(AMOUNTS),
            memo: g.pick(['', 'm']),
          });
          if (g.chance(0.15)) {
            rows.push({ ...rows[rows.length - 1] });
          }
        }
        expected.push({ c, ...ruleOverWholeHistory(db, rows) });
        let k = 0;
        const outcome = await outcomeOf(
          applyTransactionImport(
            db,
            { userId: 'u', accountId: 'a1', rows },
            {
              now: NOW,
              newId: () => `n${String(++k).padStart(3, '0')}`,
            }
          )
        );
        const written = (
          db._sqlite
            .prepare(
              'SELECT txn_date, payee, amount, memo FROM transactions WHERE created_at = ? ORDER BY id'
            )
            .all(NOW) as any[]
        ).map((r) => `${r.txn_date}|${r.payee}|${r.amount}|${r.memo}`);
        results.push({ c, outcome, written });
      } finally {
        db._sqlite.close();
      }
    }

    expect(results).toEqual(expected);
  });
});

// The registers' reads a page at a time (#28, lib/registerRead.ts) against
// the rules they replace on screen (lib/register.ts): on a seeded register of
// ten years and 10,000 rows -- CSV imports tied on (txn_date, created_at),
// both created_at shapes, pending rows, rows deleted here, another user's
// rows filed under the account, splits, payees outside ASCII -- every page
// read in turn lists exactly the rows filterTransactions keeps of the whole
// register, in its order, and each row shows the balance
// computeRunningBalances gives it over the whole register. A new module:
// its tests cannot load on the code before #28, so their red proofs are the
// named mutants (the unit file's mutant table).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import Database from 'better-sqlite3';
import { formatCurrency } from '../format';
import { mapAccount, mapTransaction } from '../mappers';
import { runMigrations } from '../migrations';
import {
  activeAccountTransactions,
  computeAllAccountsBalanceSummary,
  computeBalanceSummary,
  computeRunningBalances,
  filterTransactions,
  allAccountsSummaryFromTotals,
  nextCheckNumber,
  runningBalances,
  summaryFromTotals,
  registerTop,
  toCents,
  totalsOf,
  uniquePayees,
  type FilterStatus,
} from '../register';
import {
  ensureRegisterIndexes,
  readAllAccountsPage,
  readRegisterPage,
  readTransactionHints,
  REGISTER_INDEXES_SQL,
  REGISTER_PAGE_SIZE,
  type RegisterFilter,
  type RegisterPage,
  type RegisterReadDb,
} from '../registerRead';
import { seedRegister } from '../testing/registerSeed';
import { insertLocalAccount, makeAdapter } from '../testing/syncFixture';
import type { DbAccount, DbTransaction, TransactionWithSplits } from '../types';

let adapter: ReturnType<typeof makeAdapter>;

/**
 * The whole register of `accountId`, as the code before #28 read it -- its
 * WHERE and its order -- with the tie it left to SQLite spelled out: rows
 * tied on day and created_at in the order they were written (P1 measures
 * that this is what that read returned).
 */
function wholeRegister(accountId: string): TransactionWithSplits[] {
  return (
    adapter._sqlite
      .prepare(
        `SELECT * FROM transactions
          WHERE account_id = ? AND user_id = ? AND _sync_status != 'deleted'
          ORDER BY txn_date DESC, created_at DESC, rowid ASC`
      )
      .all(accountId, 'u') as DbTransaction[]
  ).map((r) => ({ ...mapTransaction(r), splits: [] }));
}

/** A database built by the migration ladder, as a device's is. */
async function ladderDatabase(): Promise<Database.Database> {
  const sqlite = new Database(':memory:');
  await runMigrations({
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    getFirstAsync: async <T>(sql: string) =>
      (sqlite.prepare(sql).get() as T) ?? null,
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      await fn();
      sqlite.exec('COMMIT');
    },
  });
  return sqlite;
}

/** The ids c3f7ad3's register read returned, in its order (no tiebreak). */
function readBefore28(sqlite: Database.Database, accountId: string): string[] {
  return (
    sqlite
      .prepare(
        `SELECT id FROM transactions
          WHERE account_id = ? AND user_id = ? AND _sync_status != 'deleted'
          ORDER BY txn_date DESC, created_at DESC`
      )
      .all(accountId, 'u') as { id: string }[]
  ).map((r) => r.id);
}

/** Every page of a register, read in turn as the list scrolls. */
async function everyPage(
  read: (cursor: RegisterPage['next']) => Promise<RegisterPage>
): Promise<RegisterPage[]> {
  const pages: RegisterPage[] = [];
  let cursor: RegisterPage['next'] = null;
  for (;;) {
    const page = await read(cursor);
    pages.push(page);
    if (page.next === null) return pages;
    cursor = page.next;
  }
}

/**
 * The adapter, for one page: a read past the budget fails the test, so a page
 * loop that stopped advancing fails instead of spinning (better-sqlite3
 * answers in a microtask, so no jest timeout would ever fire). Rows are
 * budgeted too: a search's batches grow to 2,000 rows, so a stuck loop would
 * otherwise read millions of rows before its statements ran out.
 */
function db(budget = 2_000, rowBudget = 200_000): RegisterReadDb {
  let left = budget;
  let rowsLeft = rowBudget;
  return {
    getAllAsync: async (sql, params) => {
      if (--left < 0 || rowsLeft < 0) {
        throw new Error('read budget spent: the page loop is not advancing');
      }
      const rows = await adapter.getAllAsync(sql, params);
      rowsLeft -= rows.length;
      return rows;
    },
  };
}

const FILTERS: RegisterFilter[] = (
  ['all', 'pending', 'cleared'] as FilterStatus[]
).flatMap((status) =>
  [
    '',
    '   ',
    'star',
    'STAR',
    'café',
    'CAFÉ MÜLLER',
    'müller',
    'i',
    'k',
    '1001',
    ' groceries',
    'zzz',
    'İstanbul',
    '\u212a',
    'déjà',
  ].map((search) => ({ status, search }))
);

describe('an account register of 10,000 rows, a page at a time (#28)', () => {
  let initial: number;
  let whole: TransactionWithSplits[];

  beforeAll(() => {
    adapter = makeAdapter();
    seedRegister(adapter._sqlite, { userId: 'u', mainRows: 10_000 });
    // The indexes a device has (lib/db.ts); the fixture's schema has none.
    adapter._sqlite.exec(REGISTER_INDEXES_SQL);
    initial = mapAccount(
      adapter._sqlite
        .prepare("SELECT * FROM accounts WHERE id = 'acct-00'")
        .get() as DbAccount
    ).initialBalance;
    whole = wholeRegister('acct-00');
  });

  afterAll(() => {
    adapter._sqlite.close();
  });

  it("P0 (pin): the seed is what the tests claim -- 10,000-odd rows listed, ties, both created_at shapes, rows not the user's", () => {
    const ties = new Set<string>();
    const seen = new Set<string>();
    for (const t of whole) {
      const key = `${t.txnDate}|${t.createdAt}`;
      if (seen.has(key)) ties.add(key);
      seen.add(key);
    }
    const foreign = adapter._sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'acct-00' AND user_id != 'u'"
      )
      .get() as { n: number };
    expect({
      listed: whole.length > 9_500,
      tieGroups: ties.size > 1_000,
      zulu: whole.some((t) => t.createdAt.endsWith('Z')),
      offset: whole.some((t) => t.createdAt.endsWith('+00:00')),
      pending: whole.some((t) => t.status === 'pending'),
      foreignFiledHere: foreign.n > 0,
    }).toEqual({
      listed: true,
      tieGroups: true,
      zulu: true,
      offset: true,
      pending: true,
      foreignFiledHere: true,
    });
  });

  it('P1 (pin): the read before #28, on the schema the ladder builds, returned rows tied on day and created_at in the order they were written -- and with the register indexes it returns them reversed, so the order must say rowid', async () => {
    const sqlite = await ladderDatabase();
    seedRegister(sqlite, { userId: 'u', mainRows: 10_000 });
    const byRowid = (
      sqlite
        .prepare(
          `SELECT id FROM transactions
            WHERE account_id = 'acct-00' AND user_id = 'u' AND _sync_status != 'deleted'
            ORDER BY txn_date DESC, created_at DESC, rowid ASC`
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    const before = readBefore28(sqlite, 'acct-00');
    sqlite.exec(REGISTER_INDEXES_SQL);
    const withIndexes = readBefore28(sqlite, 'acct-00');
    sqlite.close();

    expect(before).toEqual(byRowid);
    expect(before).toEqual(whole.map((t) => t.id));
    expect(withIndexes).not.toEqual(byRowid);
  });

  it.each(FILTERS)(
    'P2: every page in turn lists what filterTransactions keeps of the whole register, each row with the balance computeRunningBalances gives it (status $status, search "$search")',
    async (filter) => {
      const pages = await everyPage((cursor) =>
        readRegisterPage(db(), {
          userId: 'u',
          accountId: 'acct-00',
          filter,
          cursor,
        })
      );
      const rows = pages.flatMap((p) => p.rows);
      const kept = filterTransactions(whole, filter.status, filter.search);
      const expected = computeRunningBalances(initial, whole, kept);
      const shown = runningBalances(
        registerTop(initial, pages[0].totals?.['acct-00']),
        rows
      );

      expect(rows.map((t) => t.id)).toEqual(kept.map((t) => t.id));
      expect(pages.every((p) => p.rows.length <= REGISTER_PAGE_SIZE)).toBe(
        true
      );
      // The same number, and the same text on screen, for every row.
      expect(rows.map((t) => toCents(shown.get(t.id)!))).toEqual(
        kept.map((t) => toCents(expected.get(t.id)!))
      );
      expect(rows.map((t) => formatCurrency(shown.get(t.id)!))).toEqual(
        kept.map((t) => formatCurrency(expected.get(t.id)!))
      );
    }
  );

  it('P3: the first page carries the totals the summary under the register comes from, to the cent', async () => {
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'pending', search: 'star' },
      cursor: null,
    });
    const later = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: page.next,
    });

    expect(page.totals).toEqual({ 'acct-00': totalsOf(whole) });
    expect(summaryFromTotals(initial, page.totals?.['acct-00'])).toEqual(
      computeBalanceSummary(initial, whole)
    );
    // Later pages read no totals: the first page's are the register's.
    expect(later.totals).toBeUndefined();
  });

  it('P4: the balance under every row is the SQL window over the whole register -- the account balance less every row above it (1,000 rows drawn at random)', () => {
    const top = registerTop(initial, totalsOf(whole)).cents;
    const windowed = new Map(
      (
        adapter._sqlite
          .prepare(
            `SELECT id, ? - COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)) OVER (
                 ORDER BY txn_date DESC, created_at DESC, rowid ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cents
               FROM transactions
              WHERE account_id = 'acct-00' AND user_id = 'u' AND _sync_status != 'deleted'`
          )
          .all(top) as { id: string; cents: number }[]
      ).map((r) => [r.id, r.cents])
    );
    const balances = computeRunningBalances(initial, whole, whole);
    let seed = 28;
    const drawn = Array.from({ length: 1_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return whole[seed % whole.length].id;
    });

    expect(drawn.map((id) => toCents(balances.get(id)!))).toEqual(
      drawn.map((id) => windowed.get(id))
    );
  });

  it('P5: inside a day a CSV import wrote several rows, each balance is the one below it plus its own amount', async () => {
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    const balances = runningBalances(
      registerTop(initial, page.totals?.['acct-00']),
      page.rows
    );
    const broken = page.rows
      .slice(0, -1)
      .filter(
        (t, i) =>
          toCents(balances.get(t.id)!) !==
          toCents(balances.get(page.rows[i + 1].id)!) + toCents(t.amount)
      );
    const tied = page.rows.filter(
      (t, i) =>
        i > 0 &&
        page.rows[i - 1].txnDate === t.txnDate &&
        page.rows[i - 1].createdAt === t.createdAt
    );
    expect({ tiedOnPage: tied.length > 0, broken: broken.length }).toEqual({
      tiedOnPage: true,
      broken: 0,
    });
  });

  it("P6: another user's rows filed under the account are never listed or summed (#177)", async () => {
    const pages = await everyPage((cursor) =>
      readRegisterPage(db(), {
        userId: 'u',
        accountId: 'acct-00',
        filter: { status: 'all', search: '' },
        cursor,
      })
    );
    expect(pages.flatMap((p) => p.rows).some((t) => t.userId !== 'u')).toBe(
      false
    );
    const other = await readRegisterPage(db(), {
      userId: 'u-other',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    expect(other.rows.every((t) => t.userId === 'u-other')).toBe(true);
    expect(other.totals?.['acct-00']).toEqual(
      totalsOf(other.rows.length ? other.rows : [])
    );
  });

  it('P7: a page reads at most a page of rows and binds at most a page of split ids, and each row carries its splits but the ones deleted here', async () => {
    const calls: { sql: string; rows: number; params: number }[] = [];
    const counting: RegisterReadDb = {
      getAllAsync: async (sql, params) => {
        const rows = await adapter.getAllAsync(sql, params);
        calls.push({ sql, rows: rows.length, params: params.length });
        return rows;
      },
    };
    const page = await readRegisterPage(counting, {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    const listing = calls.filter((c) => /FROM transactions t\s/.test(c.sql));
    const splits = calls.filter((c) => /FROM transaction_splits/.test(c.sql));
    // The registers draw no splits, but their rows carry them (the row type is
    // TransactionWithSplits): each row its own, never one deleted here. The
    // seed's first page holds both kinds, so neither half of that is vacuous.
    const splitsOf = (id: string, deletedToo: boolean) =>
      (
        adapter._sqlite
          .prepare(
            `SELECT id FROM transaction_splits WHERE transaction_id = ?${
              deletedToo ? '' : " AND _sync_status != 'deleted'"
            }`
          )
          .all(id) as { id: string }[]
      )
        .map((s) => s.id)
        .sort();
    const ids = page.rows.map((t) => t.id);
    expect({
      rowsRead: Math.max(...listing.map((c) => c.rows)),
      splitIds: Math.max(...splits.map((c) => c.params)),
      splits: page.rows.map((t) => t.splits.map((s) => s.id).sort()),
      seedHolds: {
        live: ids.some((id) => splitsOf(id, false).length > 0),
        deleted: ids.some(
          (id) => splitsOf(id, true).length > splitsOf(id, false).length
        ),
      },
    }).toEqual({
      rowsRead: REGISTER_PAGE_SIZE,
      splitIds: REGISTER_PAGE_SIZE,
      splits: ids.map((id) => splitsOf(id, false)),
      seedHolds: { live: true, deleted: true },
    });
  });

  it('P8: the New Transaction form is offered the payees and the next check number the whole register gives, from a row per spelling and the check numbers holding a digit', async () => {
    const returned: number[] = [];
    const counting: RegisterReadDb = {
      getAllAsync: async (sql, params) => {
        const rows = await adapter.getAllAsync(sql, params);
        returned.push(rows.length);
        return rows;
      },
    };
    const spellings = new Set(whole.map((t) => t.payee).filter((p) => p));
    const checks = new Set(
      whole.map((t) => t.checkNumber).filter((c) => c && /[0-9]/.test(c))
    );
    expect({
      hints: await readTransactionHints(counting, 'u', 'acct-00'),
      returned,
    }).toEqual({
      hints: {
        payees: uniquePayees(whole),
        nextCheckNumber: nextCheckNumber(whole),
      },
      returned: [spellings.size, checks.size],
    });
  });
});

describe('All Accounts over 50,000 rows, a page at a time (#28)', () => {
  let accounts: ReturnType<typeof mapAccount>[];
  let whole: TransactionWithSplits[];

  beforeAll(() => {
    adapter = makeAdapter();
    seedRegister(adapter._sqlite, {
      userId: 'u',
      mainRows: 10_000,
      siblings: 19,
      siblingRows: 40_000,
    });
    adapter._sqlite.exec(REGISTER_INDEXES_SQL);
    accounts = (
      adapter._sqlite
        .prepare(
          "SELECT * FROM accounts WHERE user_id = 'u' AND _sync_status != 'deleted' ORDER BY sort_order"
        )
        .all() as DbAccount[]
    ).map(mapAccount);
    whole = (
      adapter._sqlite
        .prepare(
          `SELECT * FROM transactions WHERE user_id = 'u' AND _sync_status != 'deleted'
            ORDER BY txn_date DESC, created_at DESC, rowid ASC`
        )
        .all() as DbTransaction[]
    ).map((r) => ({ ...mapTransaction(r), splits: [] }));
  });

  afterAll(() => {
    adapter._sqlite.close();
  });

  it.each([
    { status: 'all', search: '' },
    { status: 'pending', search: '' },
    { status: 'cleared', search: 'checking' },
    { status: 'all', search: 'épargne' },
    { status: 'all', search: 'CAFÉ' },
    { status: 'all', search: 'zzz' },
  ] as RegisterFilter[])(
    'A1: every page in turn lists what the whole list\'s rules keep -- active accounts\' rows, filtered with the account names (status $status, search "$search")',
    async (filter) => {
      const pages = await everyPage((cursor) =>
        readAllAccountsPage(db(), { userId: 'u', filter, cursor })
      );
      const names = new Map(accounts.map((a) => [a.id, a.name]));
      const kept = filterTransactions(
        activeAccountTransactions(accounts, whole),
        filter.status,
        filter.search,
        names
      );
      expect(pages.flatMap((p) => p.rows).map((t) => t.id)).toEqual(
        kept.map((t) => t.id)
      );
    }
  );

  it("A2: the first page carries every account's totals, and the summary from them is the whole list's, to the cent", async () => {
    const page = await readAllAccountsPage(db(), {
      userId: 'u',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    expect(allAccountsSummaryFromTotals(accounts, page.totals)).toEqual(
      computeAllAccountsBalanceSummary(accounts, whole)
    );
  });
});

describe('the search across the characters SQLite does not fold (#28)', () => {
  beforeEach(async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'a1', user_id: 'u' });
    const payees = [
      'İstanbul Kebap',
      'ISTANBUL',
      '\u212aelvin Supply',
      'KELVIN',
      'Café Müller',
      'CAFÉ MÜLLER',
      'cafe muller',
      'Ölgemälde',
      'Straße',
      'STRASSE',
      'Ångström',
      'plain',
    ];
    payees.forEach((payee, i) =>
      adapter._sqlite
        .prepare(
          `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, memo, check_number, status, created_at, updated_at)
           VALUES (?, 'u', 'a1', ?, ?, -1, ?, ?, 'cleared', ?, ?)`
        )
        .run(
          `t${i}`,
          `2026-01-${String(10 + i).padStart(2, '0')}`,
          payee,
          i % 3 === 0 ? payee.toUpperCase() : null,
          i % 4 === 0 ? `A${i}` : null,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
    );
  });

  afterEach(() => {
    adapter._sqlite.close();
  });

  it.each([
    'i',
    'is',
    'i̇',
    'istanbul',
    'k',
    'ke',
    'kelvin',
    'café',
    'müller',
    'muller',
    'ß',
    'ss',
    'ångström',
    'Å',
    'a0',
    'A0',
    'ö',
  ])(
    'S1: the read lists exactly the rows matchesSearch keeps ("%s")',
    async (search) => {
      const whole = wholeRegister('a1');
      const page = await readRegisterPage(db(), {
        userId: 'u',
        accountId: 'a1',
        filter: { status: 'all', search },
        cursor: null,
      });
      expect(page.rows.map((t) => t.id)).toEqual(
        filterTransactions(whole, 'all', search).map((t) => t.id)
      );
    }
  );
});

describe('a day tied past a page boundary (#28)', () => {
  beforeEach(async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'a1', user_id: 'u' });
    // One import of 250 rows on one day, one created_at: the order inside is
    // the order they were written.
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at)
       VALUES (?, 'u', 'a1', '2026-03-01', ?, ?, 'cleared', '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z')`
    );
    for (let i = 0; i < 250; i++) {
      insert.run(`z${String(250 - i).padStart(3, '0')}`, `Row ${i}`, i + 1);
    }
  });

  afterEach(() => {
    adapter._sqlite.close();
  });

  it('K1: three pages hold the 250 rows once each, in the order they were written, and the last page says the register ends', async () => {
    const pages = await everyPage((cursor) =>
      readRegisterPage(db(), {
        userId: 'u',
        accountId: 'a1',
        filter: { status: 'all', search: '' },
        cursor,
      })
    );
    expect({
      sizes: pages.map((p) => p.rows.length),
      payees: pages.flatMap((p) => p.rows).map((t) => t.payee),
    }).toEqual({
      sizes: [100, 100, 50],
      payees: Array.from({ length: 250 }, (_, i) => `Row ${i}`),
    });
  });
});

describe('the cents the totals and the balances are summed in (#28)', () => {
  it('C1 (pin): toCents rounds as SQLite rounds amount * 100 -- half away from zero, near-halves included', () => {
    const sqlite = new Database(':memory:');
    const amounts = [
      0.07,
      -0.07,
      0.125,
      -0.125,
      1.005,
      -1.005,
      2.675,
      -2.675,
      0.004999999999999999,
      9_999_999_999.99,
      -9_999_999_999.99,
      0.1 + 0.2,
    ];
    const round = sqlite.prepare(
      'SELECT CAST(ROUND(? * 100) AS INTEGER) AS cents'
    );
    expect(amounts.map((a) => toCents(a))).toEqual(
      amounts.map((a) => (round.get(a) as { cents: number }).cents)
    );
    sqlite.close();
  });
});

describe('the totals in whole cents (#28)', () => {
  beforeEach(async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'a1', user_id: 'u' });
  });

  afterEach(() => {
    adapter._sqlite.close();
  });

  it('C2: 10,000 rows of $0.07 and 10,000 of $1.15 -- amounts whose hundredfold is no whole number in floating point -- total whole cents', async () => {
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at)
       VALUES (?, 'u', 'a1', '2026-01-01', 'P', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    adapter._sqlite.exec('BEGIN');
    for (let i = 0; i < 10_000; i++) {
      insert.run(`c${i}`, 0.07, 'cleared');
      insert.run(`p${i}`, 1.15, 'pending');
    }
    adapter._sqlite.exec('COMMIT');
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'a1',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    // SUM(amount * 100) gives 70000.00000000001 and 1149999.9999999998 here.
    expect(page.totals).toStrictEqual({
      a1: { clearedCents: 70_000, pendingCents: 1_150_000 },
    });
  });
});

describe('the indexes the reads walk (#28)', () => {
  it('I1: once created after the ladder, a page of a register and of All Accounts is read in index order, sorting only rows tied on day and created_at', async () => {
    const sqlite = await ladderDatabase();
    const ladderDb = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
    };
    seedRegister(sqlite, {
      userId: 'u',
      mainRows: 2_000,
      siblings: 3,
      siblingRows: 3_000,
    });
    await ensureRegisterIndexes(ladderDb);
    await ensureRegisterIndexes(ladderDb);
    const plans: string[] = [];
    const explaining: RegisterReadDb = {
      getAllAsync: async (sql, params) => {
        if (/FROM transactions t\s/.test(sql) && !/GROUP BY/.test(sql)) {
          plans.push(
            (
              sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
                detail: string;
              }[]
            )
              .map((r) => r.detail)
              .join(' | ')
          );
        }
        return sqlite.prepare(sql).all(...params);
      },
    };
    const page = await readRegisterPage(explaining, {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    await readRegisterPage(explaining, {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: '' },
      cursor: page.next,
    });
    await readAllAccountsPage(explaining, {
      userId: 'u',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    sqlite.close();
    // An account's pages walk the account's index, never the user's (no
    // ANALYZE here, as on a device); All Accounts walks the user's.
    expect(plans).toEqual([
      expect.stringMatching(
        /USING INDEX idx_transactions_account_order .*USE TEMP B-TREE FOR LAST TERM OF ORDER BY$/
      ),
      expect.stringMatching(
        /USING INDEX idx_transactions_account_order .*USE TEMP B-TREE FOR LAST TERM OF ORDER BY$/
      ),
      expect.stringMatching(
        /USING INDEX idx_transactions_user_order .*USE TEMP B-TREE FOR LAST TERM OF ORDER BY$/
      ),
    ]);
  });
});

// The attack lens's findings (u28bal): BAL1 the totals past 2^63 cents, BAL3
// the keyset the index can seek, BAL4 a loosely narrowed search's batches.
describe('the totals of a row saved before the cap (#28, #165)', () => {
  afterEach(() => {
    adapter._sqlite.close();
  });

  it('OV1: an account holding a row of 1e19 dollars (its cents read "1e+21" on the edit screen) opens, as both registers, with the whole-list numbers, and every row older than it shows its exact balance', async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'big', user_id: 'u' });
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'big', ?, 'P', ?, ?, ?, ?, 'pending')`
    );
    for (const [id, day, amount, status] of [
      ['huge', '2025-01-02', 1e19, 'pending'],
      ['fare', '2025-01-03', 5, 'pending'],
      ['old', '2025-01-01', 12.34, 'cleared'],
      ['older', '2024-12-31', -0.07, 'pending'],
    ] as const) {
      const at = `${day}T00:00:00.000Z`;
      insert.run(id, day, amount, status, at, at);
    }
    const filter: RegisterFilter = { status: 'all', search: '' };
    const whole = (
      adapter._sqlite
        .prepare(
          "SELECT * FROM transactions WHERE account_id = 'big' ORDER BY txn_date DESC, created_at DESC, rowid ASC"
        )
        .all() as DbTransaction[]
    ).map((r) => ({ ...mapTransaction(r), splits: [] }));

    // Before BAL1 both reads failed: "SqliteError: integer overflow"
    // (SQLite's integer SUM), so the register showed "No transactions".
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'big',
      filter,
      cursor: null,
    });
    await expect(
      readAllAccountsPage(db(), { userId: 'u', filter, cursor: null })
    ).resolves.toMatchObject({ rows: expect.any(Array) });
    const shown = runningBalances(registerTop(0, page.totals?.big), page.rows);
    const rule = computeRunningBalances(0, whole, whole);
    expect({
      rows: page.rows.map((t) => t.id),
      balances: page.rows.map((t) => shown.get(t.id)),
      summary: summaryFromTotals(0, page.totals?.big),
    }).toEqual({
      rows: ['fare', 'huge', 'old', 'older'],
      balances: whole.map((t) => rule.get(t.id)),
      summary: computeBalanceSummary(0, whole),
    });
    // What the register before #28 showed them, summing up from the oldest
    // row. With one float sum of 1e21 cents (131,072 apart) the huge row
    // swallowed the others' cents, and these read 0.00 and -12.34.
    expect(['old', 'older'].map((id) => shown.get(id))).toEqual([12.27, -0.07]);
  });

  it('OV2: two rows beyond the cap, read on pages of two: every row below both shows its exact balance, and a chip that hides one keeps it in every balance, as the start of the list', async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'big', user_id: 'u' });
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'big', ?, 'P', ?, ?, ?, ?, 'pending')`
    );
    for (const [id, day, amount, status] of [
      ['a', '2025-03-06', 1.11, 'cleared'],
      ['h1', '2025-03-05', 1e19, 'pending'],
      ['b', '2025-03-04', -2.22, 'cleared'],
      ['h2', '2025-03-03', -123_456_789_012_345.67, 'cleared'],
      ['c', '2025-03-02', 3.33, 'pending'],
      ['d', '2025-03-01', 44.44, 'reconciled'],
    ] as const) {
      const at = `${day}T00:00:00.000Z`;
      insert.run(id, day, amount, status, at, at);
    }
    const read = (status: FilterStatus) =>
      everyPage((cursor) =>
        readRegisterPage(db(), {
          userId: 'u',
          accountId: 'big',
          filter: { status, search: '' },
          cursor,
          pageSize: 2,
        })
      );
    const balancesOf = (pages: RegisterPage[]) => {
      const rows = pages.flatMap((p) => p.rows);
      const balances = runningBalances(
        registerTop(0, pages[0].totals?.big),
        rows
      );
      return new Map(rows.map((t) => [t.id, balances.get(t.id)!]));
    };
    const all = await read('all');
    const cleared = await read('cleared');
    const shown = balancesOf(all);
    const chip = balancesOf(cleared);

    expect({
      pages: all.map((p) => p.rows.map((t) => t.id)),
      below: [shown.get('c'), shown.get('d')],
      above: ['a', 'h1', 'b', 'h2'].map(
        (id) => Math.abs(shown.get(id)!) > 1e13
      ),
      chip: [...chip.keys()],
      // h1 is pending: hidden by the chip, it stays in the top, and the
      // rows below it carry it as the rows a filter hides always were.
      chipCarries: [...chip.values()].map((b) => b > 1e18),
    }).toEqual({
      // A page that fills cannot know the register ends with it: the next
      // read finds nothing.
      pages: [['a', 'h1'], ['b', 'h2'], ['c', 'd'], []],
      below: [47.77, 44.44],
      above: [true, true, true, true],
      chip: ['a', 'b', 'h2', 'd'],
      chipCarries: [true, true, true, true],
    });
  });

  it('OV4: a row beyond the cap below zero (a typo of -1e19 dollars) is summed apart too, so the row below it shows its exact balance', async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'big', user_id: 'u' });
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'big', ?, 'P', ?, ?, ?, ?, 'pending')`
    );
    for (const [id, day, amount, status] of [
      ['a', '2025-04-03', 1, 'cleared'],
      ['neg', '2025-04-02', -1e19, 'pending'],
      ['b', '2025-04-01', 2, 'cleared'],
    ] as const) {
      const at = `${day}T00:00:00.000Z`;
      insert.run(id, day, amount, status, at, at);
    }
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'big',
      filter: { status: 'all', search: '' },
      cursor: null,
    });
    const shown = runningBalances(registerTop(0, page.totals?.big), page.rows);

    // In one float sum of -1e21 cents the 300 cents of the others were lost,
    // and b read 0.00.
    expect({
      rows: page.rows.map((t) => t.id),
      b: shown.get('b'),
      beyondCap: page.totals?.big.beyondCap?.rows,
    }).toEqual({ rows: ['a', 'neg', 'b'], b: 2, beyondCap: 1 });
  });

  it('OV3 (pin): SQLite puts apart the rows totalsOf puts apart -- the cap itself is within it, a half cent past it is not, a status of NULL is cleared there too -- and the summary counts them all', async () => {
    adapter = makeAdapter();
    await insertLocalAccount(adapter, { id: 'edge', user_id: 'u' });
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'edge', ?, 'P', ?, ?, ?, ?, 'pending')`
    );
    for (const [id, day, amount, status] of [
      ['cap', '2025-01-06', 9_999_999_999.99, 'cleared'],
      ['minus-cap', '2025-01-05', -9_999_999_999.99, 'pending'],
      ['half-past', '2025-01-04', 9_999_999_999.995, 'pending'],
      ['ten-billion', '2025-01-03', 10_000_000_000, 'reconciled'],
      ['no-status', '2025-01-02', 50_000_000_000, null],
      ['fare', '2025-01-01', 0.07, null],
    ] as const) {
      const at = `${day}T00:00:00.000Z`;
      insert.run(id, day, amount, status, at, at);
    }
    const whole = (
      adapter._sqlite
        .prepare("SELECT * FROM transactions WHERE account_id = 'edge'")
        .all() as DbTransaction[]
    ).map((r) => ({ ...mapTransaction(r), splits: [] }));
    const page = await readRegisterPage(db(), {
      userId: 'u',
      accountId: 'edge',
      filter: { status: 'all', search: '' },
      cursor: null,
    });

    expect(page.totals).toEqual({ edge: totalsOf(whole) });
    expect(summaryFromTotals(0, page.totals?.edge)).toEqual({
      cleared: 70_000_000_000.06,
      outstanding: 0.01,
      balance: 70_000_000_000.07,
    });
    expect(page.totals?.edge).toEqual({
      clearedCents: 999_999_999_999 + 7,
      pendingCents: -999_999_999_999,
      beyondCap: {
        rows: 3,
        clearedCents: 1_000_000_000_000 + 5_000_000_000_000,
        pendingCents: 1_000_000_000_000,
      },
    });
  });
});

describe('a page after the first, and a search (#28)', () => {
  let sqlite: Database.Database;
  const plans: string[] = [];
  let statements = 0;
  const explaining: RegisterReadDb = {
    getAllAsync: async (sql, params) => {
      // A budget, as db()'s: a page loop that stopped advancing fails here.
      if (++statements > 500) {
        throw new Error('read budget spent: the page loop is not advancing');
      }
      if (/FROM transactions t\s/.test(sql) && !/GROUP BY/.test(sql)) {
        plans.push(
          (
            sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
              detail: string;
            }[]
          )
            .map((r) => r.detail)
            .join(' | ')
        );
      }
      return sqlite.prepare(sql).all(...params);
    },
  };

  beforeAll(async () => {
    sqlite = await ladderDatabase();
    seedRegister(sqlite, { userId: 'u', mainRows: 10_000 });
    sqlite.exec(REGISTER_INDEXES_SQL);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    plans.length = 0;
    statements = 0;
  });

  it("KS1: seeks the index to the cursor's day -- a page deep in the register does not walk it from the top", async () => {
    const filter: RegisterFilter = { status: 'all', search: '' };
    const first = await readRegisterPage(explaining, {
      userId: 'u',
      accountId: 'acct-00',
      filter,
      cursor: null,
    });
    await readRegisterPage(explaining, {
      userId: 'u',
      accountId: 'acct-00',
      filter,
      cursor: first.next,
    });
    const all = await readAllAccountsPage(explaining, {
      userId: 'u',
      filter,
      cursor: null,
    });
    await readAllAccountsPage(explaining, {
      userId: 'u',
      filter,
      cursor: all.next,
    });
    // Before: "(account_id=?)" and "(user_id=?)" alone, so every page read
    // the index from the newest row down to the cursor (All Accounts read
    // to its end over 50,000 rows: 539 ms against 75 ms).
    expect([plans[1], plans[3]]).toEqual([
      expect.stringContaining(
        'idx_transactions_account_order (account_id=? AND txn_date<?)'
      ),
      expect.stringContaining(
        'idx_transactions_user_order (user_id=? AND txn_date<?)'
      ),
    ]);
  });

  it('SB1: a search outside ASCII that matches nothing reads the rows holding text outside ASCII in a few statements, not one per hundred rows', async () => {
    const page = await readRegisterPage(explaining, {
      userId: 'u',
      accountId: 'acct-00',
      filter: { status: 'all', search: 'ø' },
      cursor: null,
    });
    // Before: 45 statements (the totals and 44 batches of 100) over 4,330
    // rows; at 50,000 rows in All Accounts, 262 statements and ~390 ms a
    // keystroke.
    expect({ rows: page.rows.length, next: page.next, statements }).toEqual({
      rows: 0,
      next: null,
      statements: 6,
    });
  });
});

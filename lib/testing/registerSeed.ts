// A large local history for the register's tests (#28), seeded straight into
// SQLite: years of transactions in one account, more in its siblings, and the
// shapes a real device holds. A CSV import stamps every row it writes with ONE
// created_at, so a day it imported more than one row is a tie on (txn_date,
// created_at); a transfer's two legs tie across accounts; a row pushed and
// pulled back holds the server's created_at ('+00:00', its fraction trimmed)
// beside the rows still holding toISOString's 'Z'; some rows are pending,
// deleted here, another user's filed under this user's account (#177), split,
// or carry a payee, a memo or an account name outside ASCII. Deterministic:
// the same options give the same database.
//
// Self-contained on purpose (no imports): the measurement scripts load it
// with Node's own type stripping, outside jest.

/** The slice of a better-sqlite3 handle the seeder uses. */
export interface SeedSqlite {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  exec(sql: string): unknown;
}

export interface RegisterSeedOptions {
  /** The signed-in user's id. */
  userId?: string;
  /** Rows of the first account ("the long account"). */
  mainRows?: number;
  /** The accounts besides the first one. */
  siblings?: number;
  /** Rows shared out among the siblings. */
  siblingRows?: number;
  /** The last day of the history (YYYY-MM-DD); it runs back `years`. */
  lastDay?: string;
  years?: number;
  /** The PRNG's seed. */
  seed?: number;
}

export interface RegisterSeed {
  userId: string;
  /** The long account. */
  mainAccountId: string;
  /** Every account seeded for the user, the long one first. */
  accountIds: string[];
  /** Rows written to `transactions`, every kind counted. */
  rows: number;
}

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAYEES = [
  'Starbucks',
  'STARBUCKS',
  'starbucks',
  'Whole Foods',
  'Safeway Groceries',
  'Groceries R Us',
  'Shell',
  'Amazon',
  'Netflix',
  'Rent',
  'Paycheck',
  'Café Müller',
  'CAFÉ MÜLLER',
  'Ölgemälde GmbH',
  'École du Parc',
  'İstanbul Kebap',
  'Ångström Labs',
  'Électricité',
  'Zürich Insurance',
  'Pharmacy',
  '',
];

const MEMOS = [
  'morning coffee',
  'Monthly',
  'groceries',
  'déjà vu',
  'Ünterwegs',
  'reimbursed',
  'GAS',
];

const ACCOUNT_NAMES = [
  'Checking',
  'Savings',
  'Visa',
  'Épargne',
  'Café Fund',
  'Brokerage',
  'Mortgage',
  'Cash',
];

const CHECK_ODDITIES = ['ACH', 'EFT', ' 42', '12abc', '0x10', '1e5', '-5', ''];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** toISOString's shape: milliseconds, always, and 'Z'. */
function localStamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** PostgREST's shape for timestamptz: '+00:00', the fraction's trailing zeros trimmed. */
function serverStamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  const [whole, frac] = iso.slice(0, -1).split('.');
  const trimmed = frac.replace(/0+$/, '');
  return `${whole}${trimmed ? `.${trimmed}` : ''}+00:00`;
}

function dayString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

/**
 * Seeds `sqlite` (the tables already created: the ladder, or the fixture's
 * SCHEMA) in one transaction and says what it wrote.
 */
export function seedRegister(
  sqlite: SeedSqlite,
  opts: RegisterSeedOptions = {}
): RegisterSeed {
  const userId = opts.userId ?? 'u';
  const mainRows = opts.mainRows ?? 10_000;
  const siblings = opts.siblings ?? 0;
  const siblingRows = opts.siblingRows ?? 0;
  const years = opts.years ?? 10;
  const lastMs = Date.parse(`${opts.lastDay ?? '2026-11-04'}T00:00:00Z`);
  const firstMs = lastMs - Math.round(years * 365.25) * DAY_MS;
  const rand = prng(opts.seed ?? 28);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join(
      ''
    );
  const uuid = () =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;

  const insertAccount = sqlite.prepare(
    `INSERT INTO accounts (id, user_id, name, type, icon, initial_balance,
       exclude_from_total, sort_order, is_archived, created_at, updated_at,
       _sync_status)
     VALUES (?, ?, ?, 'checking', NULL, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTxn = sqlite.prepare(
    `INSERT INTO transactions (id, user_id, account_id, txn_date, payee,
       amount, check_number, memo, status, transfer_link_id, receipt_path,
       created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  );
  const insertSplit = sqlite.prepare(
    `INSERT INTO transaction_splits (id, transaction_id, amount, memo,
       updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const accountIds: string[] = [];
  let rows = 0;
  const checkNext = new Map<string, number>();

  const writeTxn = (t: {
    accountId: string;
    day: string;
    createdAt: string;
    userId?: string;
    transferLinkId?: string | null;
    amountCents?: number;
  }) => {
    const id = uuid();
    const r = rand();
    const status = r < 0.15 ? 'pending' : r < 0.7 ? 'cleared' : 'reconciled';
    const cents =
      t.amountCents ??
      (rand() < 0.75
        ? -Math.floor(rand() * 25_000 + 1)
        : Math.floor(rand() * 400_000 + 1));
    let check: string | null = null;
    const c = rand();
    if (c < 0.1) {
      const next = (checkNext.get(t.accountId) ?? 1000) + 1;
      checkNext.set(t.accountId, next);
      check = String(next);
    } else if (c < 0.13) {
      check = pick(CHECK_ODDITIES);
    }
    const s = rand();
    const sync = s < 0.02 ? 'deleted' : s < 0.07 ? 'pending' : 'synced';
    insertTxn.run(
      id,
      t.userId ?? userId,
      t.accountId,
      t.day,
      pick(PAYEES),
      cents / 100,
      check,
      rand() < 0.4 ? pick(MEMOS) : null,
      status,
      t.transferLinkId ?? null,
      t.createdAt,
      t.createdAt,
      sync
    );
    rows += 1;
    if (rand() < 0.1) {
      const first = Math.round(cents / 2);
      const parts = [first, cents - first];
      for (const part of parts) {
        insertSplit.run(
          uuid(),
          id,
          part / 100,
          rand() < 0.5 ? pick(MEMOS) : null,
          t.createdAt,
          rand() < 0.05 ? 'deleted' : 'synced'
        );
      }
    }
  };

  /** `count` rows in `accountId`: manual entries, and imports that tie. */
  const fill = (accountId: string, count: number) => {
    let left = count;
    while (left > 0) {
      const at = firstMs + Math.floor(rand() * (lastMs - firstMs));
      if (rand() < 0.3 && left > 1) {
        // One import: one created_at for every row, several on one day.
        const size = Math.min(left, 2 + Math.floor(rand() * 30));
        const stampMs = at + Math.floor(rand() * DAY_MS);
        const stamp = rand() < 0.5 ? localStamp(stampMs) : serverStamp(stampMs);
        for (let i = 0; i < size; i++) {
          const back = Math.floor(rand() * 10) * DAY_MS;
          writeTxn({
            accountId,
            day: dayString(Math.max(firstMs, at - back)),
            createdAt: stamp,
          });
        }
        left -= size;
      } else {
        const stampMs = at + Math.floor(rand() * DAY_MS);
        // A whole-second stamp now and then: the server writes no fraction.
        const ms = rand() < 0.05 ? stampMs - (stampMs % 1000) : stampMs;
        writeTxn({
          accountId,
          day: dayString(at),
          createdAt: rand() < 0.5 ? localStamp(ms) : serverStamp(ms),
        });
        left -= 1;
      }
    }
  };

  sqlite.exec('BEGIN');
  try {
    const total = 1 + siblings;
    for (let i = 0; i < total; i++) {
      const id = `acct-${pad(i)}`;
      accountIds.push(id);
      insertAccount.run(
        id,
        userId,
        `${ACCOUNT_NAMES[i % ACCOUNT_NAMES.length]} ${i}`,
        Math.floor(rand() * 500_000) / 100,
        i > 0 && i % 7 === 3 ? 1 : 0,
        i,
        i > 0 && i % 9 === 5 ? 1 : 0,
        localStamp(firstMs),
        localStamp(firstMs),
        'synced'
      );
    }
    // Another user's account, and a deleted one of this user's: neither is
    // listed, and nothing in them is counted.
    insertAccount.run(
      'acct-other',
      `${userId}-other`,
      'Other user',
      0,
      0,
      0,
      0,
      localStamp(firstMs),
      localStamp(firstMs),
      'synced'
    );
    insertAccount.run(
      'acct-gone',
      userId,
      'Deleted here',
      0,
      0,
      99,
      0,
      localStamp(firstMs),
      localStamp(firstMs),
      'deleted'
    );

    fill(accountIds[0], mainRows);
    for (let i = 1; i < total; i++) {
      const share = Math.floor(siblingRows / siblings);
      fill(
        accountIds[i],
        i === total - 1 ? siblingRows - share * (siblings - 1) : share
      );
    }
    // Transfers between the long account and a sibling: two legs, one
    // created_at, one day.
    if (siblings > 0) {
      for (let i = 0; i < Math.max(1, Math.floor(mainRows / 200)); i++) {
        const at = firstMs + Math.floor(rand() * (lastMs - firstMs));
        const stamp = localStamp(at + Math.floor(rand() * DAY_MS));
        const link = uuid();
        const cents = Math.floor(rand() * 100_000 + 1);
        const day = dayString(at);
        writeTxn({
          accountId: accountIds[0],
          day,
          createdAt: stamp,
          transferLinkId: link,
          amountCents: -cents,
        });
        writeTxn({
          accountId: accountIds[1],
          day,
          createdAt: stamp,
          transferLinkId: link,
          amountCents: cents,
        });
      }
    }
    // Another user's rows: in their own account, and filed under this
    // user's long account (#177).
    for (let i = 0; i < 50; i++) {
      const at = firstMs + Math.floor(rand() * (lastMs - firstMs));
      writeTxn({
        accountId: i % 2 === 0 ? 'acct-other' : accountIds[0],
        day: dayString(at),
        createdAt: localStamp(at),
        userId: `${userId}-other`,
      });
    }
    // This user's rows filed under the other user's account (#177): no
    // register lists them, as no account of this user's holds them.
    for (let i = 0; i < 10; i++) {
      const at = firstMs + Math.floor(rand() * (lastMs - firstMs));
      writeTxn({
        accountId: 'acct-other',
        day: dayString(at),
        createdAt: localStamp(at),
      });
    }
    // Rows left in the deleted account.
    for (let i = 0; i < 20; i++) {
      const at = firstMs + Math.floor(rand() * (lastMs - firstMs));
      writeTxn({
        accountId: 'acct-gone',
        day: dayString(at),
        createdAt: localStamp(at),
      });
    }
    sqlite.exec('COMMIT');
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }

  return { userId, mainAccountId: accountIds[0], accountIds, rows };
}

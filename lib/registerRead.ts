// The registers' reads from SQLite (#28): a page of an account's register or
// of All Accounts, the totals the summary and the running balance come from,
// and what the New Transaction form suggests. Until #28 both registers read
// every row the user had (and one `IN (?, ?, ...)` of their splits, which
// failed outright past SQLite's 32,766 bound variables) and the screen
// sorted, filtered and summed them all in JS on every change.
//
// The order is the registers' own: the later day first, then the later
// created_at, then the row written first on this device (rowid). The first
// two are what the screen always sorted by; rowid is the order SQLite
// returned rows tied on both (measured: every tie, a CSV import's one
// created_at for all its rows), so the lists do not move, and it makes the
// order total, which a page boundary needs. A page starts just after the
// last row of the page before it (keyset, not OFFSET: a row written above it
// does not shift what the next page holds).
//
// Every amount is summed in whole cents (ROUND(amount * 100), added with
// TOTAL), which lib/register.ts's toCents computes the same way, so the
// totals here and the balances there agree to the cent.
import { MAX_AMOUNT_CENTS } from './format';
import { mapTransaction, mapTransactionSplit } from './mappers';
import {
  matchesSearch,
  nextCheckNumber,
  searchQuery,
  uniquePayees,
  type FilterStatus,
  type RegisterTotals,
} from './register';
import type {
  DbTransaction,
  DbTransactionSplit,
  TransactionWithSplits,
} from './types';

/** The rows of one page. */
export const REGISTER_PAGE_SIZE = 100;

/** The most rows one statement of a search's page reads (readPage). */
const MAX_SEARCH_BATCH = 2_000;

/** The slice of expo-sqlite the reads use. */
export interface RegisterReadDb {
  getAllAsync: (sql: string, params: any[]) => Promise<unknown[]>;
}

/** The register's status chips and search box. */
export interface RegisterFilter {
  status: FilterStatus;
  search: string;
}

/** A page starts just after this row, in the registers' order. */
export interface RegisterCursor {
  txnDate: string;
  createdAt: string;
  rowid: number;
}

/** A row of a register; All Accounts carries the account's name for its search. */
export type RegisterRow = TransactionWithSplits & { accountName?: string };

export interface RegisterPage {
  rows: RegisterRow[];
  /** Where the next page starts, or null: the register ends with this page. */
  next: RegisterCursor | null;
  /**
   * Every listed account's totals by status, read with the first page only:
   * the summary under the register and the balance its newest row shows.
   */
  totals?: Record<string, RegisterTotals>;
}

const ORDER = 't.txn_date DESC, t.created_at DESC, t.rowid ASC';

/**
 * After the cursor's row in ORDER: (txn_date, created_at, rowid) as bound.
 * The first term is implied by the rest; it is there for the index, which
 * SQLite can then seek to the cursor's day. Without it every page walked the
 * index from the top of the register to the cursor, so a refetch of every
 * loaded page cost the square of their number (All Accounts, 50,000 rows
 * read to the end: 539 ms, against 75 ms with it, measured).
 */
const AFTER = `t.txn_date <= ? AND (t.txn_date < ? OR (t.txn_date = ?
  AND (t.created_at < ? OR (t.created_at = ? AND t.rowid > ?))))`;

/**
 * An account's rows of the user's (#177). The unary + keeps user_id off
 * every index, so SQLite -- which a device never ANALYZEs -- walks the
 * account's index: on the user's, a 30-row account among 50,000 rows read
 * the whole history in date order for its first page (9.5 ms against
 * 0.04 ms, measured).
 */
const ACCOUNTS_USER = "+t.user_id = ? AND t._sync_status != 'deleted'";

/**
 * An amount in whole cents, as lib/register.ts's toCents rounds it. Summed
 * with TOTAL, not SUM: SQLite's integer SUM throws "integer overflow" past
 * 2^63, and a row saved before #165's cap can hold more (its cents read
 * "1e+21"), which made the account's register and All Accounts fail to open.
 * TOTAL adds in floating point, exact for every sum of whole cents below
 * 2^53 ($90 trillion), and never throws; no CAST, which would clamp such a
 * row to 2^63 while toCents does not.
 */
const CENTS = 'ROUND(t.amount * 100)';

/**
 * The totals by status, and how many rows may be beyond #165's cap: an
 * amount past MAX_AMOUNT_CENTS / 100 (bound twice, as it and its negative),
 * compared as stored -- no row at or under it rounds to more cents than the
 * cap. When there are none, as there are not but for a row saved before the
 * cap, these sums are the exact ones; else readTotals reads TOTALS_SPLIT.
 * The two comparisons cost a tenth of the GROUP BY; the split's ROUNDs, read
 * every time, cost half again (measured at 50,000 rows).
 */
const TOTALS = `t.account_id AS account_id,
  TOTAL(CASE WHEN t.status = 'pending' THEN 0 ELSE ${CENTS} END)
    AS cleared_cents,
  TOTAL(CASE WHEN t.status = 'pending' THEN ${CENTS} ELSE 0 END)
    AS pending_cents,
  COUNT(CASE WHEN t.amount > ? OR t.amount < ? THEN 1 END)
    AS maybe_beyond_cap`;

/**
 * A row beyond #165's cap, which only a row saved before the cap holds, in
 * the cents toCents rounds it to: its amounts are summed apart
 * (RegisterTotals' beyondCap), so the sums of the others stay below 2^53 and
 * exact, and so do the balances below it. NULL for a NULL amount, which no
 * writer stores and every sum leaves out.
 */
const BEYOND_CAP = `ABS(${CENTS}) > ${MAX_AMOUNT_CENTS}`;

const TOTALS_SPLIT = `t.account_id AS account_id,
  TOTAL(CASE WHEN ${BEYOND_CAP} THEN 0 WHEN t.status = 'pending' THEN 0
    ELSE ${CENTS} END) AS cleared_cents,
  TOTAL(CASE WHEN ${BEYOND_CAP} THEN 0 WHEN t.status = 'pending'
    THEN ${CENTS} ELSE 0 END) AS pending_cents,
  COUNT(CASE WHEN ${BEYOND_CAP} THEN 1 END) AS beyond_cap_rows,
  TOTAL(CASE WHEN ${BEYOND_CAP} AND t.status IS NOT 'pending' THEN ${CENTS}
    ELSE 0 END) AS beyond_cap_cleared_cents,
  TOTAL(CASE WHEN ${BEYOND_CAP} AND t.status = 'pending' THEN ${CENTS}
    ELSE 0 END) AS beyond_cap_pending_cents`;

/** The amount, in dollars, past which a row may be beyond the cap (TOTALS). */
const CAP_DOLLARS = MAX_AMOUNT_CENTS / 100;

/**
 * The two characters whose lowercase holds an ASCII letter: U+0130 (İ, to
 * "i̇") and U+212A (the Kelvin sign, to "k") -- every other character
 * outside ASCII lowercases to characters outside it (measured over every
 * code point).
 */
const FOLD_INTO_ASCII = ['\u0130', '\u212a'];

/** Any character outside ASCII, for GLOB. */
const OUTSIDE_ASCII = '*[^\u0001-\u007f]*';

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * The rows whose `column` can hold `q` (lowercased) once lowercased as
 * matchesSearch lowercases it -- a set matchesSearch then narrows. SQLite's
 * lower() folds ASCII alone. A row of ASCII text lowercases the same way
 * there and in JS, so for an ASCII `q` the instr() is exact on it, and a row
 * whose text lowercases into ASCII from outside it can only hold one of
 * FOLD_INTO_ASCII; a `q` outside ASCII can only be held by text outside it.
 */
function mayHold(column: string, q: string): { sql: string; params: string[] } {
  if (isAscii(q)) {
    return {
      sql: `(instr(lower(${column}), ?) > 0 OR instr(${column}, ?) > 0
        OR instr(${column}, ?) > 0)`,
      params: [q, ...FOLD_INTO_ASCII],
    };
  }
  return { sql: `(${column} GLOB ?)`, params: [OUTSIDE_ASCII] };
}

type Scope = { accountId: string } | { allAccounts: true };

interface PageRow extends DbTransaction {
  _rowid: number;
  _account_name?: string | null;
}

function pageSql(
  scope: Scope,
  userId: string,
  filter: RegisterFilter,
  after: RegisterCursor | null,
  limit: number
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql: string;
  if ('accountId' in scope) {
    sql = `SELECT t.*, t.rowid AS _rowid FROM transactions t
      WHERE t.account_id = ? AND ${ACCOUNTS_USER}`;
    params.push(scope.accountId, userId);
  } else {
    // The accounts the user still sees: as activeAccountTransactions keeps
    // the rows of useAccounts' accounts that are not archived.
    sql = `SELECT t.*, t.rowid AS _rowid, a.name AS _account_name
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id AND a.user_id = ?
        AND a._sync_status != 'deleted' AND COALESCE(a.is_archived, 0) = 0
      WHERE t.user_id = ? AND t._sync_status != 'deleted'`;
    params.push(userId, userId);
  }
  if (filter.status === 'pending') {
    sql += ` AND t.status = 'pending'`;
  } else if (filter.status === 'cleared') {
    sql += ` AND t.status IN ('cleared', 'reconciled')`;
  }
  const q = searchQuery(filter.search);
  if (q !== null) {
    const parts = [mayHold('t.payee', q), mayHold('t.memo', q)];
    if (!('accountId' in scope)) parts.push(mayHold('a.name', q));
    sql += ` AND (${parts.map((p) => p.sql).join(' OR ')}
      OR instr(t.check_number, ?) > 0)`;
    for (const p of parts) params.push(...p.params);
    params.push(q);
  }
  if (after) {
    sql += ` AND ${AFTER}`;
    params.push(
      after.txnDate,
      after.txnDate,
      after.txnDate,
      after.createdAt,
      after.createdAt,
      after.rowid
    );
  }
  sql += ` ORDER BY ${ORDER} LIMIT ?`;
  params.push(limit);
  return { sql, params };
}

async function readTotals(
  db: RegisterReadDb,
  scope: Scope,
  userId: string
): Promise<Record<string, RegisterTotals>> {
  const { where, params }: { where: string; params: string[] } =
    'accountId' in scope
      ? {
          where: `t.account_id = ? AND ${ACCOUNTS_USER}`,
          params: [scope.accountId, userId],
        }
      : {
          where: `t.user_id = ? AND t._sync_status != 'deleted'`,
          params: [userId],
        };
  let rows = (await db.getAllAsync(
    `SELECT ${TOTALS} FROM transactions t WHERE ${where} GROUP BY t.account_id`,
    [CAP_DOLLARS, -CAP_DOLLARS, ...params]
  )) as {
    account_id: string;
    cleared_cents: number;
    pending_cents: number;
    maybe_beyond_cap?: number;
    beyond_cap_rows?: number;
    beyond_cap_cleared_cents?: number;
    beyond_cap_pending_cents?: number;
  }[];
  if (rows.some((r) => (r.maybe_beyond_cap ?? 0) > 0)) {
    rows = (await db.getAllAsync(
      `SELECT ${TOTALS_SPLIT} FROM transactions t
        WHERE ${where} GROUP BY t.account_id`,
      params
    )) as typeof rows;
  }
  const totals: Record<string, RegisterTotals> = {};
  for (const r of rows) {
    const sums: RegisterTotals = {
      clearedCents: r.cleared_cents,
      pendingCents: r.pending_cents,
    };
    if (r.beyond_cap_rows !== undefined && r.beyond_cap_rows > 0) {
      sums.beyondCap = {
        rows: r.beyond_cap_rows,
        clearedCents: r.beyond_cap_cleared_cents ?? 0,
        pendingCents: r.beyond_cap_pending_cents ?? 0,
      };
    }
    totals[r.account_id] = sums;
  }
  return totals;
}

async function readPage(
  db: RegisterReadDb,
  scope: Scope,
  userId: string,
  filter: RegisterFilter,
  cursor: RegisterCursor | null,
  pageSize: number,
  signal?: AbortSignal
): Promise<RegisterPage> {
  // Before the rows: what the newest row shows is the totals' balance.
  const totals = cursor === null ? await readTotals(db, scope, userId) : null;

  const q = searchQuery(filter.search);
  const rows: RegisterRow[] = [];
  let after = cursor;
  let ended = false;
  // The SQL can only narrow a search to the rows that may match; the rule
  // decides each one (matchesSearch), so a page reads on until it is full or
  // the register ends.
  let batchSize = pageSize;
  while (rows.length < pageSize) {
    // A search typed over this one, or the screen gone: TanStack aborts the
    // read (the query's signal), and the batches left are not read.
    if (signal?.aborted) throw new Error('The register read was cancelled.');
    const { sql, params } = pageSql(scope, userId, filter, after, batchSize);
    const batch = (await db.getAllAsync(sql, params)) as PageRow[];
    let pageFull = false;
    let used = 0;
    let kept = 0;
    for (const raw of batch) {
      used++;
      after = {
        txnDate: raw.txn_date,
        createdAt: raw.created_at,
        rowid: raw._rowid,
      };
      const t = mapTransaction(raw);
      const accountName =
        'accountId' in scope ? undefined : (raw._account_name ?? undefined);
      if (q === null || matchesSearch(t, q, accountName)) {
        kept++;
        rows.push(
          accountName === undefined
            ? { ...t, splits: [] }
            : { ...t, splits: [], accountName }
        );
        if (rows.length === pageSize) {
          pageFull = true;
          break;
        }
      }
    }
    if (batch.length < batchSize) {
      // The SQL had no more rows: the register ends here, unless the page
      // filled up before the last of them.
      ended = used === batch.length;
      break;
    }
    if (pageFull) break;
    // A search SQLite narrows loosely (a query outside ASCII reads every row
    // holding text outside ASCII) keeps few of the rows it reads: read on in
    // larger batches, so a search that finds little is a few statements, not
    // one per hundred rows of the history.
    if (kept * 2 < batch.length) {
      batchSize = Math.min(batchSize * 4, MAX_SEARCH_BATCH);
    }
  }

  if (rows.length > 0) {
    const ids = rows.map((t) => t.id);
    const splitRows = (await db.getAllAsync(
      `SELECT * FROM transaction_splits
        WHERE transaction_id IN (${ids.map(() => '?').join(',')})
          AND _sync_status != 'deleted'`,
      ids
    )) as DbTransactionSplit[];
    const byTxn = new Map<string, TransactionWithSplits['splits']>();
    for (const s of splitRows.map(mapTransactionSplit)) {
      const list = byTxn.get(s.transactionId) ?? [];
      list.push(s);
      byTxn.set(s.transactionId, list);
    }
    for (const t of rows) {
      t.splits = byTxn.get(t.id) ?? [];
    }
  }

  return {
    rows,
    next: ended ? null : after,
    ...(totals ? { totals } : {}),
  };
}

/**
 * A page of the signed-in user's register of `accountId` (#177: never a row
 * of another user's filed under it), the first one with the account's
 * totals.
 */
export function readRegisterPage(
  db: RegisterReadDb,
  input: {
    userId: string;
    accountId: string;
    filter: RegisterFilter;
    cursor: RegisterCursor | null;
    pageSize?: number;
    signal?: AbortSignal;
  }
): Promise<RegisterPage> {
  return readPage(
    db,
    { accountId: input.accountId },
    input.userId,
    input.filter,
    input.cursor,
    input.pageSize ?? REGISTER_PAGE_SIZE,
    input.signal
  );
}

/**
 * A page of All Accounts: the rows of every account of the user's that is
 * not archived, the first page with every account's totals (the summary
 * keeps the ones the net balance counts: allAccountsSummaryFromTotals).
 */
export function readAllAccountsPage(
  db: RegisterReadDb,
  input: {
    userId: string;
    filter: RegisterFilter;
    cursor: RegisterCursor | null;
    pageSize?: number;
    signal?: AbortSignal;
  }
): Promise<RegisterPage> {
  return readPage(
    db,
    { allAccounts: true },
    input.userId,
    input.filter,
    input.cursor,
    input.pageSize ?? REGISTER_PAGE_SIZE,
    input.signal
  );
}

/**
 * What the New Transaction form suggests for `accountId` (#28): its past
 * payees and its next check number, as uniquePayees and nextCheckNumber
 * read them from the whole register, from two narrow reads instead of every
 * row. The payee read keeps each spelling's latest row in the register's
 * order, which is all uniquePayees keeps of it; the check read keeps the
 * check numbers holding a digit, the only ones parseInt reads as a number.
 */
export async function readTransactionHints(
  db: RegisterReadDb,
  userId: string,
  accountId: string
): Promise<{ payees: string[]; nextCheckNumber: string }> {
  const payees = (await db.getAllAsync(
    `SELECT payee FROM (
       SELECT t.payee, t.txn_date, t.created_at, t.rowid AS r,
              ROW_NUMBER() OVER (PARTITION BY t.payee ORDER BY ${ORDER}) AS n
         FROM transactions t
        WHERE t.account_id = ? AND ${ACCOUNTS_USER} AND t.payee != '')
      WHERE n = 1
      ORDER BY txn_date DESC, created_at DESC, r ASC`,
    [accountId, userId]
  )) as { payee: string }[];
  const checks = (await db.getAllAsync(
    `SELECT DISTINCT t.check_number FROM transactions t
      WHERE t.account_id = ? AND ${ACCOUNTS_USER}
        AND t.check_number GLOB '*[0-9]*'`,
    [accountId, userId]
  )) as { check_number: string }[];
  return {
    payees: uniquePayees(payees),
    nextCheckNumber: nextCheckNumber(
      checks.map((c) => ({ checkNumber: c.check_number }))
    ),
  };
}

/**
 * The indexes the registers' reads walk in order (#28): an account's rows,
 * and a user's, by day and created_at (rowid rides in every index). Created
 * at launch, after the migration ladder, rather than as a step of it: a step
 * would raise user_version, and every older build -- a TestFlight build of
 * an earlier branch, a Netlify rollback, an older desktop app -- would then
 * refuse to open the database (lib/migrations.ts). An older build opens a
 * database holding these indexes as before; only its own reads plan on them
 * (it lists a day's ties in reverse, and reads a small account's register
 * through the user's index: milliseconds, measured), until it is updated.
 * IF NOT EXISTS makes every later launch a no-op.
 */
export const REGISTER_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_transactions_account_order
  ON transactions(account_id, txn_date, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user_order
  ON transactions(user_id, txn_date, created_at);
`;

export async function ensureRegisterIndexes(db: {
  execAsync: (sql: string) => Promise<void>;
}): Promise<void> {
  await db.execAsync(REGISTER_INDEXES_SQL);
}

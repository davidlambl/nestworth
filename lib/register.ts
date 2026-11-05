import { isExcludedFromTotals } from './accountTotals';
import { MAX_AMOUNT_CENTS } from './format';
import type { Account, TransactionWithSplits } from './types';

export type FilterStatus = 'all' | 'pending' | 'cleared';

/**
 * Whether a transaction passes the register's status chips: Pending is the
 * pending rows, Cleared the cleared and the reconciled ones (#28: the
 * register's SQL, lib/registerRead.ts, is this rule's twin).
 */
export function matchesStatus(
  t: { status: string },
  filterStatus: FilterStatus
): boolean {
  if (filterStatus === 'pending') return t.status === 'pending';
  if (filterStatus === 'cleared')
    return t.status === 'cleared' || t.status === 'reconciled';
  return true;
}

/**
 * What the search box searches for: the box lowercased, untrimmed, or null
 * when it holds nothing but whitespace.
 */
export function searchQuery(search: string): string | null {
  return search.trim() ? search.toLowerCase() : null;
}

/**
 * The register's search (`q` from searchQuery): the payee, the memo or the
 * account's name holding it, case aside, or the check number holding it as
 * typed. lib/registerRead.ts reads the rows that can match from SQLite, a
 * set this rule then narrows: SQLite's lower() folds ASCII alone.
 */
export function matchesSearch(
  t: { payee: string; memo: string | null; checkNumber: string | null },
  q: string,
  accountName?: string
): boolean {
  return (
    t.payee.toLowerCase().includes(q) ||
    (t.memo?.toLowerCase().includes(q) ?? false) ||
    (t.checkNumber?.includes(q) ?? false) ||
    (accountName?.toLowerCase().includes(q) ?? false)
  );
}

export function filterTransactions(
  transactions: TransactionWithSplits[] | undefined,
  filterStatus: FilterStatus,
  search: string,
  accountNames?: Map<string, string>
): TransactionWithSplits[] {
  if (!transactions) return [];

  let list = transactions;
  if (filterStatus !== 'all') {
    list = list.filter((t) => matchesStatus(t, filterStatus));
  }

  const q = searchQuery(search);
  if (q !== null) {
    list = list.filter((t) =>
      matchesSearch(t, q, accountNames?.get(t.accountId))
    );
  }

  return list;
}

/**
 * An amount in whole cents, rounded as SQLite's ROUND(amount * 100) rounds
 * it: half away from zero, after the same double arithmetic. The register's
 * totals are summed in SQLite in these cents (lib/registerRead.ts), and its
 * rows' balances here, so the two agree to the cent whatever the floats.
 * A null amount (no writer stores one) is 0, as SUM leaves it out.
 */
export function toCents(amount: number): number {
  const cents = Math.trunc(Math.abs(amount) * 100 + 0.5);
  return cents === 0 ? 0 : amount < 0 ? -cents : cents;
}

/**
 * The newest-first order the register lists in: the later day first, then
 * the later created_at, both compared as SQLite compares them (character by
 * character, not by locale). Rows tied on both keep their order in the list
 * given: the register's SQL breaks the tie by rowid, the order they were
 * written on this device.
 */
function newestFirst(
  a: { txnDate: string; createdAt: string },
  b: { txnDate: string; createdAt: string }
): number {
  if (a.txnDate !== b.txnDate) return a.txnDate > b.txnDate ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return 0;
}

/** Whether an amount in cents is one the server takes (#165's cap). */
function withinCap(cents: number): boolean {
  return Math.abs(cents) <= MAX_AMOUNT_CENTS;
}

/**
 * The running balance of a register listed newest first (#28): each row
 * shows the balance after it, which is the balance at the top (`top`, the
 * account's balance: registerTop) less every row listed above it. A page of
 * the register is enough: the rows above it are the pages loaded before it.
 *
 * The rows beyond MAX_AMOUNT_CENTS (RegisterTotals' beyondCap) are taken off
 * a part of the top of their own: their sum can be past what a float holds
 * to the cent, and in one sum with the rest its rounding swallowed the cents
 * of the other rows, so every row below them showed a balance off by what
 * was lost (one row of $1e19 put each of them $66.66 out), where the
 * register before #28 showed them exactly. Below the last of them that part
 * is spent and dropped, and the balance is the exact one again.
 */
export function runningBalances(
  top: RegisterTop,
  rows: readonly { id: string; amount: number }[]
): Map<string, number> {
  const map = new Map<string, number>();
  let cents = top.cents;
  let beyondCents = top.beyondCapCents;
  let beyondRows = top.beyondCapRows;
  for (const t of rows) {
    map.set(t.id, (cents + beyondCents) / 100);
    const amount = toCents(t.amount);
    if (withinCap(amount)) {
      cents -= amount;
    } else {
      beyondRows--;
      beyondCents = beyondRows > 0 ? beyondCents - amount : 0;
    }
  }
  return map;
}

/**
 * The running balances of a whole register at once: `filteredTransactions`
 * listed newest first under a top that counts every transaction. The rows
 * the filter hides are in that top, so the newest row listed shows the
 * account's balance whatever the filter. Until #28 this summed upward from
 * the oldest row and broke ties by locale: on a day a CSV import wrote
 * several rows (one created_at for all of them), the balances inside the day
 * ran the opposite way to the rows. This is the rule the paginated register
 * (runningBalances over its pages) is pinned to.
 */
export function computeRunningBalances(
  initialBalance: number,
  allTransactions: TransactionWithSplits[],
  filteredTransactions: TransactionWithSplits[]
): Map<string, number> {
  if (!filteredTransactions.length) return new Map();

  return runningBalances(
    registerTop(initialBalance, totalsOf(allTransactions)),
    [...filteredTransactions].sort(newestFirst)
  );
}

/**
 * An account's transactions summed by status, in cents. The ones beyond
 * MAX_AMOUNT_CENTS are summed apart (`beyondCap`, absent when there are
 * none): only a row saved before #165's cap holds such an amount -- the
 * server refused it, and it stays pending here until it is edited or
 * discarded (#115) -- and nothing bounds it, so its sum can be past 2^53
 * cents ($90 trillion), where a float no longer holds every cent. Apart, the
 * other two sums stay exact (runningBalances).
 */
export interface RegisterTotals {
  /** The cleared and reconciled ones. */
  clearedCents: number;
  pendingCents: number;
  beyondCap?: { rows: number; clearedCents: number; pendingCents: number };
}

/**
 * Where a register's running balance starts (runningBalances): the account's
 * balance in cents, in two parts -- the starting balance and every
 * transaction within MAX_AMOUNT_CENTS, exact, and the transactions beyond
 * it, with how many there are.
 */
export interface RegisterTop {
  cents: number;
  beyondCapCents: number;
  beyondCapRows: number;
}

export interface BalanceSummary {
  cleared: number;
  outstanding: number;
  balance: number;
}

const NO_SUMMARY: BalanceSummary = { cleared: 0, outstanding: 0, balance: 0 };

const NO_TOTALS: RegisterTotals = { clearedCents: 0, pendingCents: 0 };

/**
 * `totals` with a transaction counted in (`sign` 1) or taken out (-1): by its
 * status, and apart when its amount is beyond MAX_AMOUNT_CENTS. The one rule
 * the totals are summed by here (totalsOf) and moved by when an edit is
 * patched in before it lands (lib/hooks/useTransactions.ts).
 */
export function countInTotals(
  totals: RegisterTotals,
  t: { status: string; amount: number },
  sign: 1 | -1
): RegisterTotals {
  const cents = sign * toCents(t.amount);
  const pending = t.status === 'pending';
  if (withinCap(cents)) {
    return pending
      ? { ...totals, pendingCents: totals.pendingCents + cents }
      : { ...totals, clearedCents: totals.clearedCents + cents };
  }
  const beyond = totals.beyondCap ?? { rows: 0, ...NO_TOTALS };
  const next: RegisterTotals = {
    clearedCents: totals.clearedCents,
    pendingCents: totals.pendingCents,
  };
  const rows = beyond.rows + sign;
  if (rows !== 0) {
    next.beyondCap = pending
      ? { ...beyond, rows, pendingCents: beyond.pendingCents + cents }
      : { ...beyond, rows, clearedCents: beyond.clearedCents + cents };
  }
  return next;
}

/** Transactions summed by status (lib/registerRead.ts sums the same in SQLite). */
export function totalsOf(
  transactions: readonly { status: string; amount: number }[]
): RegisterTotals {
  let sums = NO_TOTALS;
  for (const t of transactions) sums = countInTotals(sums, t, 1);
  return sums;
}

/** Transactions summed by status, account by account. */
export function totalsByAccount(
  transactions: readonly { accountId: string; status: string; amount: number }[]
): Record<string, RegisterTotals> {
  const totals: Record<string, RegisterTotals> = {};
  for (const t of transactions) {
    totals[t.accountId] = countInTotals(totals[t.accountId] ?? NO_TOTALS, t, 1);
  }
  return totals;
}

/**
 * The summary under a register: Cleared is the starting balance and every
 * transaction that is not pending, Outstanding the pending ones, Balance the
 * two together.
 */
export function summaryFromTotals(
  initialBalance: number,
  totals: RegisterTotals | undefined
): BalanceSummary {
  const { cleared, pending } = summaryCents(initialBalance, totals);
  return {
    cleared: cleared / 100,
    outstanding: pending / 100,
    balance: (cleared + pending) / 100,
  };
}

/** An account's Cleared (its starting balance included) and Outstanding, in cents. */
function summaryCents(
  initialBalance: number,
  totals: RegisterTotals | undefined
): { cleared: number; pending: number } {
  return {
    cleared:
      toCents(initialBalance) +
      (totals?.clearedCents ?? 0) +
      (totals?.beyondCap?.clearedCents ?? 0),
    pending:
      (totals?.pendingCents ?? 0) + (totals?.beyondCap?.pendingCents ?? 0),
  };
}

/** The account's balance: what the newest row of its register shows. */
export function registerTop(
  initialBalance: number,
  totals: RegisterTotals | undefined
): RegisterTop {
  const beyond = totals?.beyondCap;
  return {
    cents:
      toCents(initialBalance) +
      (totals?.clearedCents ?? 0) +
      (totals?.pendingCents ?? 0),
    beyondCapCents: beyond ? beyond.clearedCents + beyond.pendingCents : 0,
    beyondCapRows: beyond?.rows ?? 0,
  };
}

export function computeBalanceSummary(
  initialBalance: number,
  transactions: TransactionWithSplits[] | undefined
): BalanceSummary {
  if (!transactions) return NO_SUMMARY;
  return summaryFromTotals(initialBalance, totalsOf(transactions));
}

/** An account as the All Accounts register reads it. */
type LedgerAccount = Pick<
  Account,
  'id' | 'initialBalance' | 'isArchived' | 'excludeFromTotal'
>;

/**
 * The summary under the All Accounts register from each account's totals
 * (`totals`, lib/registerRead.ts): the starting balances and the
 * transactions of the accounts the net balance counts. See
 * computeAllAccountsBalanceSummary, the same rule over a list.
 */
export function allAccountsSummaryFromTotals(
  accounts: readonly LedgerAccount[] | undefined,
  totals: Record<string, RegisterTotals> | undefined
): BalanceSummary {
  if (!accounts || !totals) return NO_SUMMARY;

  let clearedCents = 0;
  let pendingCents = 0;
  for (const a of accounts) {
    if (isExcludedFromTotals(a)) continue;
    const cents = summaryCents(a.initialBalance, totals[a.id]);
    clearedCents += cents.cleared;
    pendingCents += cents.pending;
  }
  return {
    cleared: clearedCents / 100,
    outstanding: pendingCents / 100,
    balance: (clearedCents + pendingCents) / 100,
  };
}

/**
 * The summary under the All Accounts register: the starting balances and the
 * transactions of the accounts the net balance counts (isExcludedFromTotals,
 * lib/accountTotals.ts), so its Balance is the All Accounts total on the
 * Accounts tab and in the desktop sidebar (netBalance). An archived account is
 * left out with all its transactions, and so is an active one whose "Include
 * in Net Balance" switch is off: this used to count the switched-off ones, so
 * the register's Balance differed from the total it was opened from by their
 * balances (#76). A transaction whose account is not among `accounts` is not
 * counted.
 */
export function computeAllAccountsBalanceSummary(
  accounts: LedgerAccount[] | undefined,
  transactions: TransactionWithSplits[] | undefined
): BalanceSummary {
  if (!accounts || !transactions) return NO_SUMMARY;
  return allAccountsSummaryFromTotals(accounts, totalsByAccount(transactions));
}

/**
 * The transactions that belong to an account the user can still see.
 *
 * The All Accounts ledger is an "active accounts" view: archived accounts are
 * hidden from the accounts list, the desktop sidebar and every account picker,
 * so their transactions must not appear in that ledger either. Before #24 the
 * ledger listed them and its summary added them while leaving their accounts'
 * initial balances out -- a total that matched neither the accounts tab nor
 * the rows on screen.
 *
 * Reports and CSV export deliberately keep reading every transaction: history
 * and backups should stay complete. The register reads the same set from
 * SQLite a page at a time (lib/registerRead.ts, #28).
 */
export function activeAccountTransactions(
  accounts: { id: string; isArchived: boolean }[] | undefined,
  transactions: TransactionWithSplits[] | undefined
): TransactionWithSplits[] {
  if (!accounts || !transactions) return [];
  const activeIds = new Set(
    accounts.filter((a) => !a.isArchived).map((a) => a.id)
  );
  return transactions.filter((t) => activeIds.has(t.accountId));
}

/**
 * What the All Accounts register (app/account/all.tsx) shows: the
 * transactions it lists and the summary under them. One call, so the screen
 * and its tests put the two together the same way (#76: the screen's own
 * composition was untested).
 *
 * It lists the transactions of every account that is not archived -- an
 * account switched out of the net balance included, as it stays on the
 * Accounts tab with its balance dimmed -- and sums only the accounts the net
 * balance counts, so its Balance is the All Accounts total the register is
 * opened from. A switched-off account's rows are listed and not summed. The
 * screen reads both a page at a time since #28 (allAccountsView); this is
 * the whole-list rule its tests pin the pages to.
 */
export function allAccountsLedger(
  accounts: LedgerAccount[] | undefined,
  transactions: TransactionWithSplits[] | undefined
): {
  transactions: TransactionWithSplits[];
  summary: BalanceSummary;
} {
  return {
    transactions: activeAccountTransactions(accounts, transactions),
    summary: computeAllAccountsBalanceSummary(accounts, transactions),
  };
}

/** The loaded pages of a register, as its hook selects them. */
export interface RegisterPages {
  rows: TransactionWithSplits[];
  /** By account, read with the first page. */
  totals: Record<string, RegisterTotals>;
}

/**
 * What an account's register (app/account/[id].tsx) shows (#28): the rows
 * loaded so far, each row's running balance, and the summary under them.
 * Until the account is read there are no balances and the summary is zeros,
 * as before; the rows show at once.
 */
export function registerView(
  account: { initialBalance: number } | undefined,
  accountId: string,
  pages: RegisterPages | undefined
): {
  rows: TransactionWithSplits[];
  balances: Map<string, number>;
  summary: BalanceSummary;
} {
  const rows = pages?.rows ?? [];
  if (!account || !pages) {
    return { rows, balances: new Map(), summary: NO_SUMMARY };
  }
  const totals = pages.totals[accountId];
  return {
    rows,
    balances: runningBalances(
      registerTop(account.initialBalance, totals),
      rows
    ),
    summary: summaryFromTotals(account.initialBalance, totals),
  };
}

/**
 * What the All Accounts register shows (#28): the rows loaded so far -- the
 * read lists active accounts only, as activeAccountTransactions does -- and
 * the summary of the accounts the net balance counts.
 */
export function allAccountsView(
  accounts: LedgerAccount[] | undefined,
  pages: RegisterPages | undefined
): { rows: TransactionWithSplits[]; summary: BalanceSummary } {
  return {
    rows: accounts ? (pages?.rows ?? []) : [],
    summary: allAccountsSummaryFromTotals(accounts, pages?.totals),
  };
}

// Read with Number, as centsInputToAmount reads it for Save: the edit screen's
// seed of a row saved before the cap can be in exponent notation ("1e+21"),
// which parseInt read as 1 cent (#165).
export function centsToDisplay(centsStr: string): string {
  const cents = Number(centsStr || '0');
  return (cents / 100).toFixed(2);
}

// The most digits a cents field takes: the twelve of MAX_AMOUNT_CENTS, the
// largest amount the server's numeric(12,2) columns hold.
const MAX_CENTS_DIGITS = String(MAX_AMOUNT_CENTS).length;

/**
 * The digits of a cents-entry amount field (transaction new/edit, transfer):
 * every non-digit is dropped, and so is every digit after the twelfth (#165).
 * A thirteenth digit made an amount the server refuses -- fourteen nines are
 * $999,999,999,999.99 -- and the push then kept the row pending forever. So
 * a digit typed into a full field is ignored, and a longer paste keeps its
 * first twelve digits; the field shows the result before Save, as it shows
 * every paste ("1,234" reads $12.34).
 */
export function sanitizeCentsInput(text: string): string {
  const digits = text.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.slice(0, MAX_CENTS_DIGITS);
}

/**
 * The amount, in dollars, that a cents field's digits hold, or null when they
 * hold more than MAX_AMOUNT_CENTS (#165). The field caps what is typed, but
 * the edit screen seeds it from the stored row, and a row saved before the cap
 * can hold more: the server refused it and it is still pending here.
 */
export function centsInputToAmount(centsStr: string): number | null {
  const cents = Number(centsStr || '0');
  return cents <= MAX_AMOUNT_CENTS ? cents / 100 : null;
}

/**
 * What the edit screen says when its amount is beyond MAX_AMOUNT_CENTS
 * (#165); the figure is formatCurrency(MAX_AMOUNT_CENTS / 100).
 */
export const AMOUNT_TOO_LARGE_MESSAGE =
  'The amount can be at most $9,999,999,999.99, so this change was not saved.';

export function nextCheckNumber(
  transactions: { checkNumber: string | null }[] | undefined
): string {
  if (!transactions) return '';
  const nums = transactions
    .map((t) => parseInt(t.checkNumber ?? '', 10))
    .filter((n) => !isNaN(n));
  if (nums.length === 0) return '';
  return String(Math.max(...nums) + 1);
}

export function uniquePayees(
  transactions: { payee: string }[] | undefined
): string[] {
  if (!transactions) return [];
  const seen = new Set<string>();
  return transactions
    .filter((t) => {
      if (!t.payee || seen.has(t.payee.toLowerCase())) return false;
      seen.add(t.payee.toLowerCase());
      return true;
    })
    .map((t) => t.payee);
}

export function filterPayeeSuggestions(
  payees: string[],
  query: string,
  limit = 5
): string[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const prefix: string[] = [];
  const interior: string[] = [];
  for (const p of payees) {
    const lower = p.toLowerCase();
    if (lower.startsWith(q)) prefix.push(p);
    else if (lower.includes(q)) interior.push(p);
  }
  return [...prefix, ...interior].slice(0, limit);
}

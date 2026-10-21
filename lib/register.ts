import { isExcludedFromTotals } from './accountTotals';
import { MAX_AMOUNT_CENTS } from './format';
import type { Account, TransactionWithSplits } from './types';

export type FilterStatus = 'all' | 'pending' | 'cleared';

export function filterTransactions(
  transactions: TransactionWithSplits[] | undefined,
  filterStatus: FilterStatus,
  search: string,
  accountNames?: Map<string, string>
): TransactionWithSplits[] {
  if (!transactions) return [];

  let list = transactions;
  if (filterStatus === 'pending') {
    list = list.filter((t) => t.status === 'pending');
  } else if (filterStatus === 'cleared') {
    list = list.filter(
      (t) => t.status === 'cleared' || t.status === 'reconciled'
    );
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    list = list.filter(
      (t) =>
        t.payee.toLowerCase().includes(q) ||
        (t.memo?.toLowerCase().includes(q) ?? false) ||
        (t.checkNumber?.includes(q) ?? false) ||
        (accountNames?.get(t.accountId)?.toLowerCase().includes(q) ?? false)
    );
  }

  return list;
}

export function computeRunningBalances(
  initialBalance: number,
  allTransactions: TransactionWithSplits[],
  filteredTransactions: TransactionWithSplits[]
): Map<string, number> {
  if (!filteredTransactions.length) return new Map();

  const filteredSet = new Set(filteredTransactions);
  const sorted = [...filteredTransactions].sort((a, b) => {
    const dc = a.txnDate.localeCompare(b.txnDate);
    return dc !== 0 ? dc : a.createdAt.localeCompare(b.createdAt);
  });

  let bal = initialBalance;
  const excluded = allTransactions.filter((t) => !filteredSet.has(t));
  for (const t of excluded.sort((a, b) => a.txnDate.localeCompare(b.txnDate))) {
    bal += t.amount;
  }

  const map = new Map<string, number>();
  for (const t of sorted) {
    bal += t.amount;
    map.set(t.id, bal);
  }
  return map;
}

export function computeBalanceSummary(
  initialBalance: number,
  transactions: TransactionWithSplits[] | undefined
): { cleared: number; outstanding: number; balance: number } {
  if (!transactions) return { cleared: 0, outstanding: 0, balance: 0 };

  let clearedSum = initialBalance;
  let outstandingSum = 0;
  for (const t of transactions) {
    if (t.status === 'pending') {
      outstandingSum += t.amount;
    } else {
      clearedSum += t.amount;
    }
  }
  return {
    cleared: clearedSum,
    outstanding: outstandingSum,
    balance: clearedSum + outstandingSum,
  };
}

/** An account as the All Accounts register reads it. */
type LedgerAccount = Pick<
  Account,
  'id' | 'initialBalance' | 'isArchived' | 'excludeFromTotal'
>;

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
): { cleared: number; outstanding: number; balance: number } {
  if (!accounts || !transactions)
    return { cleared: 0, outstanding: 0, balance: 0 };

  const counted = accounts.filter((a) => !isExcludedFromTotals(a));
  const countedIds = new Set(counted.map((a) => a.id));
  let clearedSum = 0;
  for (const a of counted) {
    clearedSum += a.initialBalance;
  }
  let outstandingSum = 0;
  for (const t of transactions) {
    if (!countedIds.has(t.accountId)) {
      continue;
    }
    if (t.status === 'pending') {
      outstandingSum += t.amount;
    } else {
      clearedSum += t.amount;
    }
  }
  return {
    cleared: clearedSum,
    outstanding: outstandingSum,
    balance: clearedSum + outstandingSum,
  };
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
 * and backups should stay complete.
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
 * opened from. A switched-off account's rows are listed and not summed.
 */
export function allAccountsLedger(
  accounts: LedgerAccount[] | undefined,
  transactions: TransactionWithSplits[] | undefined
): {
  transactions: TransactionWithSplits[];
  summary: { cleared: number; outstanding: number; balance: number };
} {
  return {
    transactions: activeAccountTransactions(accounts, transactions),
    summary: computeAllAccountsBalanceSummary(accounts, transactions),
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

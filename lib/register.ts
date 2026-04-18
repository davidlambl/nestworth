import type { TransactionWithSplits, TransactionStatus } from './types';

export type FilterStatus = 'all' | 'pending' | 'cleared';

export function filterTransactions(
  transactions: TransactionWithSplits[] | undefined,
  filterStatus: FilterStatus,
  search: string,
  accountNames?: Map<string, string>,
): TransactionWithSplits[] {
  if (!transactions) return [];

  let list = transactions;
  if (filterStatus === 'pending') {
    list = list.filter((t) => t.status === 'pending');
  } else if (filterStatus === 'cleared') {
    list = list.filter(
      (t) => t.status === 'cleared' || t.status === 'reconciled',
    );
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    list = list.filter(
      (t) =>
        t.payee.toLowerCase().includes(q) ||
        (t.memo?.toLowerCase().includes(q) ?? false) ||
        (t.checkNumber?.includes(q) ?? false) ||
        (accountNames?.get(t.accountId)?.toLowerCase().includes(q) ?? false),
    );
  }

  return list;
}

export function computeRunningBalances(
  initialBalance: number,
  allTransactions: TransactionWithSplits[],
  filteredTransactions: TransactionWithSplits[],
): Map<string, number> {
  if (!filteredTransactions.length) return new Map();

  const filteredSet = new Set(filteredTransactions);
  const sorted = [...filteredTransactions].sort((a, b) => {
    const dc = a.txnDate.localeCompare(b.txnDate);
    return dc !== 0 ? dc : a.createdAt.localeCompare(b.createdAt);
  });

  let bal = initialBalance;
  const excluded = allTransactions.filter((t) => !filteredSet.has(t));
  for (const t of excluded.sort((a, b) =>
    a.txnDate.localeCompare(b.txnDate),
  )) {
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
  transactions: TransactionWithSplits[] | undefined,
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

export function computeAllAccountsBalanceSummary(
  accounts: { initialBalance: number; isArchived: boolean }[] | undefined,
  transactions: TransactionWithSplits[] | undefined,
): { cleared: number; outstanding: number; balance: number } {
  if (!accounts || !transactions) return { cleared: 0, outstanding: 0, balance: 0 };

  let clearedSum = 0;
  for (const a of accounts.filter((a) => !a.isArchived)) {
    clearedSum += a.initialBalance;
  }
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

export function centsToDisplay(centsStr: string): string {
  const cents = parseInt(centsStr || '0', 10);
  return (cents / 100).toFixed(2);
}

export function sanitizeCentsInput(text: string): string {
  const digits = text.replace(/[^0-9]/g, '');
  return digits.replace(/^0+/, '') || '';
}

export function nextCheckNumber(
  transactions: { checkNumber: string | null }[] | undefined,
): string {
  if (!transactions) return '';
  const nums = transactions
    .map((t) => parseInt(t.checkNumber ?? '', 10))
    .filter((n) => !isNaN(n));
  if (nums.length === 0) return '';
  return String(Math.max(...nums) + 1);
}

export function uniquePayees(
  transactions: { payee: string }[] | undefined,
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
  limit = 5,
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

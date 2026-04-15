import {
  filterTransactions,
  computeRunningBalances,
  computeBalanceSummary,
  computeAllAccountsBalanceSummary,
  centsToDisplay,
  sanitizeCentsInput,
  nextCheckNumber,
  uniquePayees,
  filterPayeeSuggestions,
} from '../register';
import type { TransactionWithSplits } from '../types';

function makeTxn(
  overrides: Partial<TransactionWithSplits> & { id: string },
): TransactionWithSplits {
  return {
    userId: 'u1',
    accountId: 'acc-1',
    txnDate: '2026-04-10',
    payee: 'Test',
    amount: -10,
    checkNumber: null,
    memo: null,
    status: 'cleared',
    transferLinkId: null,
    receiptPath: null,
    createdAt: '2026-04-10T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    splits: [],
    ...overrides,
  };
}

describe('filterTransactions', () => {
  const txns: TransactionWithSplits[] = [
    makeTxn({ id: '1', status: 'pending', payee: 'Coffee Shop', memo: 'morning' }),
    makeTxn({ id: '2', status: 'cleared', payee: 'Grocery Store', checkNumber: '1001' }),
    makeTxn({ id: '3', status: 'reconciled', payee: 'Electric Co', memo: 'utility' }),
  ];

  it('returns all when filter is "all"', () => {
    expect(filterTransactions(txns, 'all', '')).toHaveLength(3);
  });

  it('filters pending only', () => {
    const result = filterTransactions(txns, 'pending', '');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('filters cleared includes reconciled', () => {
    const result = filterTransactions(txns, 'cleared', '');
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(['2', '3']);
  });

  it('searches by payee (case insensitive)', () => {
    const result = filterTransactions(txns, 'all', 'coffee');
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Coffee Shop');
  });

  it('searches by memo', () => {
    const result = filterTransactions(txns, 'all', 'utility');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('searches by check number', () => {
    const result = filterTransactions(txns, 'all', '1001');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('searches by account name when accountNames provided', () => {
    const names = new Map([['acc-1', 'PNC Bank']]);
    const result = filterTransactions(txns, 'all', 'PNC', names);
    expect(result).toHaveLength(3);
  });

  it('combines filter and search', () => {
    const result = filterTransactions(txns, 'cleared', 'grocery');
    expect(result).toHaveLength(1);
  });

  it('returns empty for undefined transactions', () => {
    expect(filterTransactions(undefined, 'all', '')).toEqual([]);
  });

  it('returns empty when search matches nothing', () => {
    expect(filterTransactions(txns, 'all', 'zzz')).toEqual([]);
  });
});

describe('computeRunningBalances', () => {
  it('computes running balances for a simple sequence', () => {
    const txns = [
      makeTxn({ id: '1', txnDate: '2026-04-01', amount: 100, createdAt: '2026-04-01T00:00:00Z' }),
      makeTxn({ id: '2', txnDate: '2026-04-02', amount: -30, createdAt: '2026-04-02T00:00:00Z' }),
      makeTxn({ id: '3', txnDate: '2026-04-03', amount: -20, createdAt: '2026-04-03T00:00:00Z' }),
    ];
    const result = computeRunningBalances(500, txns, txns);
    expect(result.get('1')).toBe(600);
    expect(result.get('2')).toBe(570);
    expect(result.get('3')).toBe(550);
  });

  it('includes excluded (non-filtered) transactions in the seed balance', () => {
    const all = [
      makeTxn({ id: '1', txnDate: '2026-04-01', amount: 100, createdAt: '2026-04-01T00:00:00Z' }),
      makeTxn({ id: '2', txnDate: '2026-04-02', amount: -30, createdAt: '2026-04-02T00:00:00Z' }),
    ];
    const filtered = [all[1]];
    const result = computeRunningBalances(500, all, filtered);
    expect(result.get('2')).toBe(570);
  });

  it('returns empty map for empty filtered list', () => {
    const result = computeRunningBalances(500, [], []);
    expect(result.size).toBe(0);
  });

  it('sorts by date then createdAt', () => {
    const txns = [
      makeTxn({ id: '2', txnDate: '2026-04-01', amount: 20, createdAt: '2026-04-01T12:00:00Z' }),
      makeTxn({ id: '1', txnDate: '2026-04-01', amount: 10, createdAt: '2026-04-01T06:00:00Z' }),
    ];
    const result = computeRunningBalances(0, txns, txns);
    expect(result.get('1')).toBe(10);
    expect(result.get('2')).toBe(30);
  });
});

describe('computeBalanceSummary', () => {
  it('splits cleared and outstanding correctly', () => {
    const txns = [
      makeTxn({ id: '1', status: 'cleared', amount: 100 }),
      makeTxn({ id: '2', status: 'pending', amount: -30 }),
      makeTxn({ id: '3', status: 'reconciled', amount: 50 }),
    ];
    const result = computeBalanceSummary(1000, txns);
    expect(result.cleared).toBe(1150);
    expect(result.outstanding).toBe(-30);
    expect(result.balance).toBe(1120);
  });

  it('handles all pending transactions', () => {
    const txns = [
      makeTxn({ id: '1', status: 'pending', amount: -100 }),
      makeTxn({ id: '2', status: 'pending', amount: -50 }),
    ];
    const result = computeBalanceSummary(500, txns);
    expect(result.cleared).toBe(500);
    expect(result.outstanding).toBe(-150);
    expect(result.balance).toBe(350);
  });

  it('handles no transactions', () => {
    const result = computeBalanceSummary(500, []);
    expect(result).toEqual({ cleared: 500, outstanding: 0, balance: 500 });
  });

  it('returns zeros for undefined transactions', () => {
    const result = computeBalanceSummary(0, undefined);
    expect(result).toEqual({ cleared: 0, outstanding: 0, balance: 0 });
  });
});

describe('computeAllAccountsBalanceSummary', () => {
  it('sums initial balances from non-archived accounts', () => {
    const accounts = [
      { initialBalance: 1000, isArchived: false },
      { initialBalance: 500, isArchived: false },
      { initialBalance: 200, isArchived: true },
    ];
    const txns = [
      makeTxn({ id: '1', status: 'cleared', amount: 100 }),
      makeTxn({ id: '2', status: 'pending', amount: -30 }),
    ];
    const result = computeAllAccountsBalanceSummary(accounts, txns);
    expect(result.cleared).toBe(1600);
    expect(result.outstanding).toBe(-30);
    expect(result.balance).toBe(1570);
  });

  it('returns zeros when accounts or transactions are undefined', () => {
    expect(computeAllAccountsBalanceSummary(undefined, [])).toEqual({
      cleared: 0, outstanding: 0, balance: 0,
    });
    expect(computeAllAccountsBalanceSummary([], undefined)).toEqual({
      cleared: 0, outstanding: 0, balance: 0,
    });
  });
});

describe('centsToDisplay', () => {
  it('converts cents string to dollars', () => {
    expect(centsToDisplay('123')).toBe('1.23');
    expect(centsToDisplay('5')).toBe('0.05');
    expect(centsToDisplay('1000')).toBe('10.00');
  });

  it('treats empty string as zero', () => {
    expect(centsToDisplay('')).toBe('0.00');
  });

  it('returns NaN display for non-numeric (callers use sanitizeCentsInput first)', () => {
    expect(centsToDisplay('abc')).toBe('NaN');
  });
});

describe('sanitizeCentsInput', () => {
  it('strips non-digit characters', () => {
    expect(sanitizeCentsInput('$1,234')).toBe('1234');
    expect(sanitizeCentsInput('12.34')).toBe('1234');
  });

  it('strips leading zeros', () => {
    expect(sanitizeCentsInput('00123')).toBe('123');
  });

  it('returns empty string for all zeros', () => {
    expect(sanitizeCentsInput('000')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeCentsInput('')).toBe('');
  });
});

describe('nextCheckNumber', () => {
  it('returns max check number + 1', () => {
    const txns = [
      { checkNumber: '1001' },
      { checkNumber: '1003' },
      { checkNumber: '1002' },
    ];
    expect(nextCheckNumber(txns)).toBe('1004');
  });

  it('returns empty string when no check numbers exist', () => {
    const txns = [{ checkNumber: null }, { checkNumber: null }];
    expect(nextCheckNumber(txns)).toBe('');
  });

  it('ignores non-numeric check numbers', () => {
    const txns = [
      { checkNumber: 'ABC' },
      { checkNumber: '500' },
    ];
    expect(nextCheckNumber(txns)).toBe('501');
  });

  it('returns empty string for undefined transactions', () => {
    expect(nextCheckNumber(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(nextCheckNumber([])).toBe('');
  });
});

describe('uniquePayees', () => {
  it('deduplicates case-insensitively, preserving first casing', () => {
    const txns = [
      { payee: 'Coffee Shop' },
      { payee: 'coffee shop' },
      { payee: 'Grocery' },
      { payee: 'COFFEE SHOP' },
    ];
    expect(uniquePayees(txns)).toEqual(['Coffee Shop', 'Grocery']);
  });

  it('skips empty payees', () => {
    const txns = [{ payee: '' }, { payee: 'Valid' }];
    expect(uniquePayees(txns)).toEqual(['Valid']);
  });

  it('returns empty for undefined', () => {
    expect(uniquePayees(undefined)).toEqual([]);
  });
});

describe('filterPayeeSuggestions', () => {
  const payees = ['Coffee Shop', 'Coffee Bean', 'Grocery Store', 'Gas Station'];

  it('filters by substring match', () => {
    expect(filterPayeeSuggestions(payees, 'coffee')).toEqual([
      'Coffee Shop',
      'Coffee Bean',
    ]);
  });

  it('respects the limit', () => {
    expect(filterPayeeSuggestions(payees, 'co', 1)).toEqual(['Coffee Shop']);
  });

  it('returns empty for empty query', () => {
    expect(filterPayeeSuggestions(payees, '')).toEqual([]);
    expect(filterPayeeSuggestions(payees, '   ')).toEqual([]);
  });

  it('returns empty when nothing matches', () => {
    expect(filterPayeeSuggestions(payees, 'zzz')).toEqual([]);
  });
});

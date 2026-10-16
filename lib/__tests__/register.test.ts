import {
  filterTransactions,
  computeRunningBalances,
  computeBalanceSummary,
  computeAllAccountsBalanceSummary,
  activeAccountTransactions,
  centsToDisplay,
  sanitizeCentsInput,
  centsInputToAmount,
  AMOUNT_TOO_LARGE_MESSAGE,
  nextCheckNumber,
  uniquePayees,
  filterPayeeSuggestions,
} from '../register';
import { formatCurrency, MAX_AMOUNT_CENTS } from '../format';
import type { TransactionWithSplits } from '../types';

function makeTxn(
  overrides: Partial<TransactionWithSplits> & { id: string }
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
    makeTxn({
      id: '1',
      status: 'pending',
      payee: 'Coffee Shop',
      memo: 'morning',
    }),
    makeTxn({
      id: '2',
      status: 'cleared',
      payee: 'Grocery Store',
      checkNumber: '1001',
    }),
    makeTxn({
      id: '3',
      status: 'reconciled',
      payee: 'Electric Co',
      memo: 'utility',
    }),
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
      makeTxn({
        id: '1',
        txnDate: '2026-04-01',
        amount: 100,
        createdAt: '2026-04-01T00:00:00Z',
      }),
      makeTxn({
        id: '2',
        txnDate: '2026-04-02',
        amount: -30,
        createdAt: '2026-04-02T00:00:00Z',
      }),
      makeTxn({
        id: '3',
        txnDate: '2026-04-03',
        amount: -20,
        createdAt: '2026-04-03T00:00:00Z',
      }),
    ];
    const result = computeRunningBalances(500, txns, txns);
    expect(result.get('1')).toBe(600);
    expect(result.get('2')).toBe(570);
    expect(result.get('3')).toBe(550);
  });

  it('includes excluded (non-filtered) transactions in the seed balance', () => {
    const all = [
      makeTxn({
        id: '1',
        txnDate: '2026-04-01',
        amount: 100,
        createdAt: '2026-04-01T00:00:00Z',
      }),
      makeTxn({
        id: '2',
        txnDate: '2026-04-02',
        amount: -30,
        createdAt: '2026-04-02T00:00:00Z',
      }),
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
      makeTxn({
        id: '2',
        txnDate: '2026-04-01',
        amount: 20,
        createdAt: '2026-04-01T12:00:00Z',
      }),
      makeTxn({
        id: '1',
        txnDate: '2026-04-01',
        amount: 10,
        createdAt: '2026-04-01T06:00:00Z',
      }),
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
      cleared: 0,
      outstanding: 0,
      balance: 0,
    });
    expect(computeAllAccountsBalanceSummary([], undefined)).toEqual({
      cleared: 0,
      outstanding: 0,
      balance: 0,
    });
  });
});

describe('activeAccountTransactions', () => {
  const accounts = [
    { id: 'acc-active', isArchived: false },
    { id: 'acc-archived', isArchived: true },
  ];
  const txns = [
    makeTxn({ id: '1', accountId: 'acc-active', amount: 100 }),
    makeTxn({ id: '2', accountId: 'acc-archived', amount: -40 }),
    makeTxn({ id: '3', accountId: 'acc-active', amount: -10 }),
  ];

  it('keeps transactions of active accounts and drops archived ones', () => {
    const result = activeAccountTransactions(accounts, txns);
    expect(result.map((t) => t.id)).toEqual(['1', '3']);
  });

  it('drops transactions whose account is unknown', () => {
    const result = activeAccountTransactions(accounts, [
      makeTxn({ id: '9', accountId: 'acc-gone' }),
    ]);
    expect(result).toEqual([]);
  });

  it('returns an empty list when accounts or transactions are undefined', () => {
    expect(activeAccountTransactions(undefined, txns)).toEqual([]);
    expect(activeAccountTransactions(accounts, undefined)).toEqual([]);
  });

  // Regression (#24): the All Accounts ledger summary skipped an archived
  // account's initial balance but still added every one of its transactions,
  // so archiving an account moved the ledger total away from the accounts-tab
  // total by exactly that account's transaction sum. `all.tsx` now feeds the
  // summary `activeAccountTransactions(...)`; without that filtering this
  // expectation reads 1050 instead of 1090.
  it('makes the All Accounts summary ignore an archived account entirely', () => {
    const ledgerAccounts = [
      { id: 'acc-active', isArchived: false, initialBalance: 1000 },
      { id: 'acc-archived', isArchived: true, initialBalance: 500 },
    ];
    const summary = computeAllAccountsBalanceSummary(
      ledgerAccounts,
      activeAccountTransactions(ledgerAccounts, txns)
    );
    expect(summary.cleared).toBe(1090);
    expect(summary.outstanding).toBe(0);
    expect(summary.balance).toBe(1090);
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

  // D1 (#165) -- the edit screen seeds its field with the stored amount's
  // cents, String(Math.round(Math.abs(amount) * 100)), which is in exponent
  // notation from 10^21 cents up: a row saved before the cap from a paste of
  // 22 digits or more. parseInt read "1e+21" as 1, so the field showed 0.01
  // while Save refused the amount as too large.
  it('shows a seed in exponent notation as the amount Save reads', () => {
    for (const amount of [1e19, 1.2345678901234568e22]) {
      const seed = String(Math.round(amount * 100));
      expect(seed).toContain('e+');
      expect(Number(centsToDisplay(seed))).toBe(Number(seed) / 100);
      expect(centsInputToAmount(seed)).toBeNull();
    }
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

  // #165 -- the server's numeric(12,2) holds at most twelve digits of cents.
  // The screens call it with the field's whole text after each keystroke: the
  // display (centsToDisplay of the digits so far) plus what was typed.
  describe('the twelve-digit cap (#165)', () => {
    // R1 -- a digit typed into a full field changes nothing.
    it('ignores a digit typed after the twelfth', () => {
      const full = centsToDisplay('999999999999');
      expect(full).toBe('9999999999.99');
      expect(sanitizeCentsInput(full + '9')).toBe('999999999999');
    });

    // R2 -- the issue's fourteen nines, and longer pastes.
    it('keeps the first twelve digits of a longer entry', () => {
      expect(sanitizeCentsInput('99999999999999')).toBe('999999999999');
      expect(sanitizeCentsInput('1234567890123456789012345')).toBe(
        '123456789012'
      );
      expect(sanitizeCentsInput('$12,345,678,901.23')).toBe('123456789012');
    });

    // R3 -- the cap is the server's bound itself, not a rounder number.
    it('caps at exactly MAX_AMOUNT_CENTS', () => {
      expect(sanitizeCentsInput('9'.repeat(30))).toBe(String(MAX_AMOUNT_CENTS));
    });

    // R4 -- pin: twelve digits are kept whole, and shown as the largest
    // amount the server stores.
    it('keeps twelve digits whole', () => {
      expect(sanitizeCentsInput('123456789012')).toBe('123456789012');
      expect(centsToDisplay(sanitizeCentsInput('999999999999'))).toBe(
        '9999999999.99'
      );
    });

    // R5 -- pin: leading zeros are not digits of the amount, so they do not
    // count towards the twelve.
    it('drops leading zeros before counting', () => {
      expect(sanitizeCentsInput('000' + '1'.repeat(12))).toBe('1'.repeat(12));
    });
  });
});

describe('centsInputToAmount (#165)', () => {
  // C1
  it("reads a cents field's digits as dollars", () => {
    expect(centsInputToAmount('')).toBe(0);
    expect(centsInputToAmount('5')).toBe(0.05);
    expect(centsInputToAmount('123456')).toBe(1234.56);
    expect(centsInputToAmount('999999999999')).toBe(9999999999.99);
  });

  // C2 -- what the edit screen can be seeded with from a row saved before the
  // cap: more than the server stores. bc1c355's save line,
  // parseInt(text) / 100, read "1e+22" as 0.01.
  it('refuses more than MAX_AMOUNT_CENTS', () => {
    expect(centsInputToAmount('1000000000000')).toBeNull();
    expect(centsInputToAmount('99999999999999')).toBeNull();
    expect(centsInputToAmount('1e+22')).toBeNull();
    expect(centsInputToAmount('abc')).toBeNull();
  });

  // C3 -- pin: the edit screen's seed, String(Math.round(Math.abs(amount) *
  // 100)), reads back as the stored amount for every amount the server can
  // hold (production's largest is 68,255.80).
  it.each([0.01, 1.15, 0.29, 68219.39, 68255.8, 1234567.89, 9999999999.99])(
    'reads the seed of a stored %p back exactly',
    (amount) => {
      const seed = String(Math.round(Math.abs(amount) * 100));
      expect(centsInputToAmount(seed)).toBe(amount);
      expect(
        centsInputToAmount(String(Math.round(Math.abs(-amount) * 100)))
      ).toBe(amount);
    }
  );

  // C4 -- the message names the bound it enforces.
  it('names the largest amount in its refusal', () => {
    expect(AMOUNT_TOO_LARGE_MESSAGE).toBe(
      `The amount can be at most ${formatCurrency(MAX_AMOUNT_CENTS / 100)}, so this change was not saved.`
    );
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
    const txns = [{ checkNumber: 'ABC' }, { checkNumber: '500' }];
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

  it('ranks prefix matches above interior substring matches', () => {
    const ranked = [
      'Safeway Groceries',
      'Groceries R Us',
      'Whole Foods Grocery',
    ];
    expect(filterPayeeSuggestions(ranked, 'gro')).toEqual([
      'Groceries R Us',
      'Safeway Groceries',
      'Whole Foods Grocery',
    ]);
  });

  it('preserves original order within the same match tier', () => {
    const payeesB = ['Coffee Shop', 'Coffee Bean', 'Java Coffee'];
    expect(filterPayeeSuggestions(payeesB, 'coff')).toEqual([
      'Coffee Shop',
      'Coffee Bean',
      'Java Coffee',
    ]);
  });
});

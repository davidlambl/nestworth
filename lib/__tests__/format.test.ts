import {
  formatCurrency,
  formatDate,
  formatDateShort,
  todayString,
  balanceColor,
  formatRelativeSyncedTime,
  parseAmount,
  parseStartingBalance,
  MAX_AMOUNT_CENTS,
} from '../format';

describe('formatCurrency', () => {
  it('formats positive amounts', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats negative amounts', () => {
    expect(formatCurrency(-42.5)).toBe('-$42.50');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('treats near-zero (< 0.005) as zero', () => {
    expect(formatCurrency(0.004)).toBe('$0.00');
    expect(formatCurrency(-0.004)).toBe('$0.00');
    expect(formatCurrency(0.0049)).toBe('$0.00');
  });

  it('formats values just above the near-zero threshold', () => {
    expect(formatCurrency(0.01)).toBe('$0.01');
    expect(formatCurrency(-0.01)).toBe('-$0.01');
  });

  it('formats large numbers with comma separators', () => {
    expect(formatCurrency(1000000)).toBe('$1,000,000.00');
  });
});

describe('balanceColor', () => {
  const colors = {
    income: '#16a34a',
    expense: '#dc2626',
    textSecondary: '#6b7280',
  };

  it('returns income color for positive values', () => {
    expect(balanceColor(100, colors)).toBe(colors.income);
    expect(balanceColor(0.01, colors)).toBe(colors.income);
  });

  it('returns expense color for negative values', () => {
    expect(balanceColor(-50, colors)).toBe(colors.expense);
    expect(balanceColor(-0.01, colors)).toBe(colors.expense);
  });

  it('returns textSecondary for zero', () => {
    expect(balanceColor(0, colors)).toBe(colors.textSecondary);
  });

  it('returns textSecondary for near-zero values (< 0.005)', () => {
    expect(balanceColor(0.004, colors)).toBe(colors.textSecondary);
    expect(balanceColor(-0.004, colors)).toBe(colors.textSecondary);
    expect(balanceColor(0.0049, colors)).toBe(colors.textSecondary);
  });
});

describe('formatDate', () => {
  it('formats a YYYY-MM-DD string to a locale date', () => {
    const result = formatDate('2026-01-15');
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2026/);
  });

  it('formats a different month', () => {
    const result = formatDate('2025-12-03');
    expect(result).toMatch(/Dec/);
    expect(result).toMatch(/3/);
    expect(result).toMatch(/2025/);
  });
});

describe('formatDateShort', () => {
  it('formats without year', () => {
    const result = formatDateShort('2026-04-14');
    expect(result).toMatch(/Apr/);
    expect(result).toMatch(/14/);
    expect(result).not.toMatch(/2026/);
  });
});

describe('todayString', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the current date', () => {
    const now = new Date();
    const expected = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    expect(todayString()).toBe(expected);
  });
});

describe('formatRelativeSyncedTime', () => {
  it('returns "Never" for null', () => {
    expect(formatRelativeSyncedTime(null)).toBe('Never');
  });

  it('returns "Unknown" for invalid ISO string', () => {
    expect(formatRelativeSyncedTime('not-a-date')).toBe('Unknown');
  });

  it('returns "Just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatRelativeSyncedTime(now)).toBe('Just now');
  });

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeSyncedTime(fiveMinAgo)).toBe('5 minutes ago');
  });

  it('uses singular "minute"', () => {
    const oneMinAgo = new Date(Date.now() - 61 * 1000).toISOString();
    expect(formatRelativeSyncedTime(oneMinAgo)).toBe('1 minute ago');
  });

  it('returns hours ago', () => {
    const threeHrsAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeSyncedTime(threeHrsAgo)).toBe('3 hours ago');
  });

  it('uses singular "hour"', () => {
    const oneHrAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatRelativeSyncedTime(oneHrAgo)).toBe('1 hour ago');
  });

  it('returns days ago for >= 48 hours', () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000
    ).toISOString();
    expect(formatRelativeSyncedTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('stays in hours until 48h threshold', () => {
    const fortySevenHrs = new Date(
      Date.now() - 47 * 60 * 60 * 1000
    ).toISOString();
    expect(formatRelativeSyncedTime(fortySevenHrs)).toBe('47 hours ago');
  });
});

describe('parseAmount (#145)', () => {
  // A1 — the reported value: parseFloat stopped at the comma and stored -68.
  it('reads an amount typed with a thousands separator whole (-68,655.02)', () => {
    expect(parseAmount('-68,655.02')).toBe(-68655.02);
  });

  // A2
  it('reads thousands separators placed every three digits', () => {
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('1,000,000')).toBe(1000000);
    expect(parseAmount('12,345,678.90')).toBe(12345678.9);
  });

  // A3
  it('reads a dollar sign and a sign on either side of it', () => {
    expect(parseAmount('$5.00')).toBe(5);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('-$5')).toBe(-5);
    expect(parseAmount('$-5')).toBe(-5);
    expect(parseAmount('-$68,655.02')).toBe(-68655.02);
    expect(parseAmount('+5')).toBe(5);
  });

  // A4 — pins: what parseFloat already read correctly still reads the same.
  it('reads plain decimals, a bare point either side, and outer whitespace', () => {
    expect(parseAmount('5')).toBe(5);
    expect(parseAmount('1234.5')).toBe(1234.5);
    expect(parseAmount('5.')).toBe(5);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('0.05')).toBe(0.05);
    expect(parseAmount('-.5')).toBe(-0.5);
    expect(parseAmount('  5 ')).toBe(5);
    expect(parseAmount(' 5 ')).toBe(5);
  });

  // A5 — refused rather than guessed at. Pins: the 16 rows parseFloat already
  // refused (NaN) -- the blanks, the lone symbols, abc, --5, -$-5, $$5, -$$5,
  // - 5, NaN, (5.00), the Unicode minus and the non-ASCII digit.
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['.', 'a point alone'],
    ['-', 'a sign alone'],
    ['$', 'a dollar sign alone'],
    ['-$.', 'no digits'],
    ['abc', 'not a number'],
    ['12,34', 'a comma not followed by three digits'],
    ['1,2,3', 'commas between single digits'],
    ['1.234,56', 'a comma as the decimal separator'],
    ['0,123', 'a grouped number starting with 0'],
    ['1,234,56', 'a short last group'],
    ['1234,567', 'a first group longer than three digits'],
    ['1,2345', 'a group after a comma longer than three digits'],
    ['1 234', 'a space as the separator'],
    ['5-', 'a trailing sign'],
    ['--5', 'two signs'],
    ['-$-5', 'a sign on both sides'],
    ['$$5', 'two dollar signs'],
    ['-$$5', 'two dollar signs after a sign'],
    ['- 5', 'a space after the sign'],
    ['1.2.3', 'two points'],
    ['1.005', 'more than two decimal places'],
    ['1e5', 'an exponent'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['0x10', 'hexadecimal'],
    ['(5.00)', 'accounting parentheses'],
    ['−5', 'a Unicode minus sign'],
    ['٣', 'a non-ASCII digit'],
    ['5 USD', 'a currency code'],
  ])('refuses %j (%s)', (text) => {
    expect(parseAmount(text)).toBeNull();
  });

  // A6 — the server's numeric(12,2) bound.
  it('reads up to the largest amount the server stores and refuses more', () => {
    expect(MAX_AMOUNT_CENTS).toBe(999999999999);
    expect(parseAmount('9,999,999,999.99')).toBe(9999999999.99);
    expect(parseAmount('-9999999999.99')).toBe(-9999999999.99);
    expect(parseAmount('10,000,000,000')).toBeNull();
    expect(parseAmount('10000000000')).toBeNull();
    expect(parseAmount('-10000000000.00')).toBeNull();
    expect(parseAmount('9'.repeat(400))).toBeNull();
  });

  // A7 — parseFloat('-0') is -0; a pin against a0d8d03's `|| 0` (gave 0).
  it('reads zero as 0, never -0', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('-0')).toBe(0);
    expect(parseAmount('-$0.00')).toBe(0);
    expect(parseAmount('0.00')).toBe(0);
  });

  // A8 — pin: the parser reads back exactly what formatCurrency prints.
  it.each([
    0.01, -0.01, 0.1, 0.29, 1.15, 5, -42.5, 1234.56, -68655.02, 1000000,
    9999999999.99, -9999999999.99,
  ])('reads formatCurrency(%p) back exactly', (value) => {
    expect(parseAmount(formatCurrency(value))).toBe(value);
  });
});

describe('parseStartingBalance (#145)', () => {
  // B1 -- a pin (a0d8d03's `parseFloat(text) || 0` gave 0 too): the placeholder
  // reads "Starting Balance (0.00)", and every e2e spec creates its accounts
  // with the field left blank.
  it('reads a blank starting balance as 0', () => {
    expect(parseStartingBalance('')).toBe(0);
    expect(parseStartingBalance('   ')).toBe(0);
    expect(parseStartingBalance('\u00a0')).toBe(0);
  });

  // B2 -- the reported value, through the function the New Account modal calls.
  it('reads the reported starting balance whole (-68,655.02)', () => {
    expect(parseStartingBalance('-68,655.02')).toBe(-68655.02);
    expect(parseStartingBalance('$5.00')).toBe(5);
  });

  // B3 -- refused, so the modal can say so instead of saving another number.
  it('refuses a starting balance that is not an amount', () => {
    for (const text of ['12,34', '1.005', 'abc', '-', '10,000,000,000']) {
      expect(parseStartingBalance(text)).toBeNull();
    }
  });
});

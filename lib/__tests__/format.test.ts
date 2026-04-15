import {
  formatCurrency,
  formatDate,
  formatDateShort,
  todayString,
  balanceColor,
  formatRelativeSyncedTime,
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
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeSyncedTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('stays in hours until 48h threshold', () => {
    const fortySevenHrs = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeSyncedTime(fortySevenHrs)).toBe('47 hours ago');
  });
});

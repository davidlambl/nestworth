import { mapAccount, mapTransaction, mapTransactionSplit, mapRecurringRule } from '../mappers';
import type {
  DbAccount,
  DbTransaction,
  DbTransactionSplit,
  DbRecurringRule,
} from '../types';

const baseAccount: DbAccount = {
  id: 'acc-1',
  user_id: 'user-1',
  name: 'Checking',
  type: 'checking',
  icon: null,
  initial_balance: 1000,
  exclude_from_total: false,
  sort_order: 0,
  is_archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('mapAccount', () => {
  it('maps snake_case to camelCase', () => {
    const result = mapAccount(baseAccount);
    expect(result).toEqual({
      id: 'acc-1',
      userId: 'user-1',
      name: 'Checking',
      type: 'checking',
      icon: null,
      initialBalance: 1000,
      excludeFromTotal: false,
      sortOrder: 0,
      isArchived: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('coerces initial_balance to number', () => {
    const row = { ...baseAccount, initial_balance: '500.25' as any };
    expect(mapAccount(row).initialBalance).toBe(500.25);
  });

  it('coerces boolean fields from integers', () => {
    const row = { ...baseAccount, exclude_from_total: 1 as any, is_archived: 1 as any };
    const result = mapAccount(row);
    expect(result.excludeFromTotal).toBe(true);
    expect(result.isArchived).toBe(true);
  });

  it('coerces falsy boolean fields', () => {
    const row = { ...baseAccount, exclude_from_total: 0 as any, is_archived: 0 as any };
    const result = mapAccount(row);
    expect(result.excludeFromTotal).toBe(false);
    expect(result.isArchived).toBe(false);
  });
});

describe('mapTransaction', () => {
  const baseTxn: DbTransaction = {
    id: 'txn-1',
    user_id: 'user-1',
    account_id: 'acc-1',
    txn_date: '2026-04-10',
    payee: 'Coffee Shop',
    amount: -4.5,
    check_number: '1001',
    memo: 'Morning coffee',
    status: 'cleared',
    transfer_link_id: null,
    receipt_path: null,
    created_at: '2026-04-10T08:00:00Z',
    updated_at: '2026-04-10T08:00:00Z',
  };

  it('maps all fields correctly', () => {
    const result = mapTransaction(baseTxn);
    expect(result).toEqual({
      id: 'txn-1',
      userId: 'user-1',
      accountId: 'acc-1',
      txnDate: '2026-04-10',
      payee: 'Coffee Shop',
      amount: -4.5,
      checkNumber: '1001',
      memo: 'Morning coffee',
      status: 'cleared',
      transferLinkId: null,
      receiptPath: null,
      createdAt: '2026-04-10T08:00:00Z',
      updatedAt: '2026-04-10T08:00:00Z',
    });
  });

  it('preserves null optional fields', () => {
    const result = mapTransaction({ ...baseTxn, check_number: null, memo: null });
    expect(result.checkNumber).toBeNull();
    expect(result.memo).toBeNull();
  });
});

describe('mapTransactionSplit', () => {
  const baseSplit: DbTransactionSplit = {
    id: 'split-1',
    transaction_id: 'txn-1',
    amount: 25.0,
    memo: 'Groceries portion',
  };

  it('maps all fields correctly', () => {
    const result = mapTransactionSplit(baseSplit);
    expect(result).toEqual({
      id: 'split-1',
      transactionId: 'txn-1',
      amount: 25.0,
      memo: 'Groceries portion',
    });
  });

  it('preserves null memo', () => {
    expect(mapTransactionSplit({ ...baseSplit, memo: null }).memo).toBeNull();
  });
});

describe('mapRecurringRule', () => {
  const templateObj = {
    payee: 'Netflix',
    amount: -15.99,
    checkNumber: null,
    memo: null,
    splits: [],
  };

  const baseRule: DbRecurringRule = {
    id: 'rule-1',
    user_id: 'user-1',
    account_id: 'acc-1',
    frequency: 'monthly',
    next_date: '2026-05-01',
    end_date: null,
    template: templateObj,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('maps fields correctly when template is already an object', () => {
    const result = mapRecurringRule(baseRule);
    expect(result).toEqual({
      id: 'rule-1',
      userId: 'user-1',
      accountId: 'acc-1',
      frequency: 'monthly',
      nextDate: '2026-05-01',
      endDate: null,
      template: templateObj,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('parses template from JSON string', () => {
    const row = { ...baseRule, template: JSON.stringify(templateObj) as any };
    const result = mapRecurringRule(row);
    expect(result.template).toEqual(templateObj);
  });

  it('throws on invalid JSON template string', () => {
    const row = { ...baseRule, template: '{not valid json' as any };
    expect(() => mapRecurringRule(row)).toThrow();
  });
});

import type {
  Account, DbAccount,
  Transaction, DbTransaction,
  TransactionSplit, DbTransactionSplit,
  RecurringRule, DbRecurringRule,
} from './types';

export function mapAccount(row: DbAccount): Account {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    icon: row.icon,
    initialBalance: Number(row.initial_balance),
    excludeFromTotal: !!row.exclude_from_total,
    sortOrder: Number(row.sort_order),
    isArchived: !!row.is_archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTransaction(row: DbTransaction): Transaction {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    txnDate: row.txn_date,
    payee: row.payee,
    amount: row.amount,
    checkNumber: row.check_number,
    memo: row.memo,
    status: row.status,
    transferLinkId: row.transfer_link_id,
    receiptPath: row.receipt_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTransactionSplit(row: DbTransactionSplit): TransactionSplit {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    amount: row.amount,
    memo: row.memo,
  };
}

export function mapRecurringRule(row: DbRecurringRule): RecurringRule {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    frequency: row.frequency,
    nextDate: row.next_date,
    endDate: row.end_date,
    template:
      typeof row.template === 'string'
        ? JSON.parse(row.template)
        : row.template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

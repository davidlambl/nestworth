export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  initialBalance: number;
  sortOrder: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AccountType = 'checking' | 'savings' | 'credit_card' | 'cash' | 'other';

export const AccountTypeLabels: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit Card',
  cash: 'Cash',
  other: 'Other',
};

export type TransactionStatus = 'pending' | 'cleared' | 'reconciled';

export interface Transaction {
  id: string;
  userId: string;
  accountId: string;
  txnDate: string;
  payee: string;
  amount: number;
  checkNumber: string | null;
  memo: string | null;
  status: TransactionStatus;
  transferLinkId: string | null;
  receiptPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionSplit {
  id: string;
  transactionId: string;
  categoryId: string | null;
  amount: number;
  memo: string | null;
}

export type CategoryType = 'income' | 'expense';

export interface Category {
  id: string;
  userId: string;
  name: string;
  parentId: string | null;
  type: CategoryType;
  createdAt: string;
}

export type RecurringFrequency =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'semimonthly'
  | 'quarterly'
  | 'biannually'
  | 'yearly';

export interface RecurringRule {
  id: string;
  userId: string;
  accountId: string;
  frequency: RecurringFrequency;
  nextDate: string;
  endDate: string | null;
  template: {
    payee: string;
    amount: number;
    checkNumber: string | null;
    memo: string | null;
    splits: { categoryId: string | null; amount: number; memo: string | null }[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface TransactionWithSplits extends Transaction {
  splits: TransactionSplit[];
}

export interface AccountWithBalance extends Account {
  currentBalance: number;
}

// Row shapes from Supabase (snake_case)
export interface DbAccount {
  id: string;
  user_id: string;
  name: string;
  type: AccountType;
  initial_balance: number;
  sort_order: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbTransaction {
  id: string;
  user_id: string;
  account_id: string;
  txn_date: string;
  payee: string;
  amount: number;
  check_number: string | null;
  memo: string | null;
  status: TransactionStatus;
  transfer_link_id: string | null;
  receipt_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTransactionSplit {
  id: string;
  transaction_id: string;
  category_id: string | null;
  amount: number;
  memo: string | null;
}

export interface DbCategory {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  type: CategoryType;
  created_at: string;
}

export interface DbRecurringRule {
  id: string;
  user_id: string;
  account_id: string;
  frequency: RecurringFrequency;
  next_date: string;
  end_date: string | null;
  template: RecurringRule['template'];
  created_at: string;
  updated_at: string;
}

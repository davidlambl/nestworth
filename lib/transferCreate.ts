import { mapTransaction } from './mappers';
import type { DbTransaction, Transaction } from './types';

// The slice of the expo-sqlite API this module needs. Deliberately
// non-generic (unlike transactionUpdate's TxnDb) so the shared test fixture's
// better-sqlite3 adapter satisfies it as-is; the real SQLiteDatabase does too.
export interface TransferDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  getFirstAsync: (sql: string, params: any[]) => Promise<unknown>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}

export interface CreateTransferInput {
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  /** Shown in the legs' payees: "Transfer to <to>" / "Transfer from <from>". */
  fromAccountName: string;
  toAccountName: string;
  /** Magnitude; the from-leg is written as -amount and the to-leg as +amount. */
  amount: number;
  txnDate: string;
  /** Blank means "Transfer". */
  memo?: string | null;
}

export interface CreateTransferResult {
  linkId: string;
  from: Transaction;
  to: Transaction;
}

const INSERT_LEG = `INSERT INTO transactions
     (id, user_id, account_id, txn_date, payee, amount, memo,
      status, transfer_link_id, created_at, updated_at, _sync_status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, 'pending')`;

/**
 * Writes both legs of a transfer, or neither.
 *
 * The legs share a transfer_link_id, which is what lets an edit or delete on
 * one side mirror to the other (transactionUpdate.ts, useDeleteTransaction).
 * As two bare INSERTs, a crash between them — or a fullSync pushing between
 * them — left one leg orphaned with a link nothing resolves. One SQLite
 * transaction closes that window, the same way applyTransactionUpdate does.
 */
export async function createTransfer(
  db: TransferDb,
  input: CreateTransferInput,
  opts: { now: string; newId: () => string }
): Promise<CreateTransferResult> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error('Source and destination must be different.');
  }
  const amount = Math.abs(input.amount);
  if (!(amount > 0)) {
    throw new Error('Transfer amount must be positive.');
  }
  const memo = input.memo?.trim() || 'Transfer';
  const { now, newId } = opts;
  const linkId = newId();
  const fromId = newId();
  const toId = newId();
  let fromRow: DbTransaction | null = null;
  let toRow: DbTransaction | null = null;

  await db.withTransactionAsync(async () => {
    await db.runAsync(INSERT_LEG, [
      fromId,
      input.userId,
      input.fromAccountId,
      input.txnDate,
      `Transfer to ${input.toAccountName}`,
      -amount,
      memo,
      linkId,
      now,
      now,
    ]);
    await db.runAsync(INSERT_LEG, [
      toId,
      input.userId,
      input.toAccountId,
      input.txnDate,
      `Transfer from ${input.fromAccountName}`,
      amount,
      memo,
      linkId,
      now,
      now,
    ]);
    fromRow = (await db.getFirstAsync(
      'SELECT * FROM transactions WHERE id = ?',
      [fromId]
    )) as DbTransaction | null;
    toRow = (await db.getFirstAsync('SELECT * FROM transactions WHERE id = ?', [
      toId,
    ])) as DbTransaction | null;
  });

  return {
    linkId,
    from: mapTransaction(fromRow!),
    to: mapTransaction(toRow!),
  };
}

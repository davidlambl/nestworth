import { mapTransaction } from './mappers';
import { pickLinkedTransferUpdate } from './transferLink';
import type { DbTransaction, Transaction, TransactionStatus } from './types';

export interface UpdateTransactionInput {
  id: string;
  accountId: string;
  txnDate?: string;
  payee?: string;
  amount?: number;
  checkNumber?: string | null;
  memo?: string | null;
  status?: TransactionStatus;
  splits?: { amount: number; memo: string | null }[];
}

export interface UpdateTransactionResult {
  txn: Transaction;
  linkedAccountId: string | null;
  linkedTransactionId: string | null;
}

// Slice of the expo-sqlite API this module uses. Defined so tests can run
// against an in-memory SQLite (better-sqlite3) without the React Query layer.
export interface TxnDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  getFirstAsync: <T>(sql: string, params: any[]) => Promise<T | null>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}

export async function applyTransactionUpdate(
  db: TxnDb,
  input: UpdateTransactionInput,
  opts: { now: string; newSplitId: () => string }
): Promise<UpdateTransactionResult> {
  const { now, newSplitId } = opts;
  let linkedAccountId: string | null = null;
  let linkedTransactionId: string | null = null;
  let primaryRow: DbTransaction | null = null;

  // All writes go in one SQLite transaction so the from-side, splits, and
  // to-side either all commit together or roll back together. Without this,
  // a failure between the primary UPDATE and the linked UPDATE would leave
  // the transfer pair desynchronized locally — the exact bug this module fixes.
  await db.withTransactionAsync(async () => {
    const setClauses: string[] = [];
    const params: any[] = [];

    if (input.txnDate !== undefined) {
      setClauses.push('txn_date = ?');
      params.push(input.txnDate);
    }
    if (input.payee !== undefined) {
      setClauses.push('payee = ?');
      params.push(input.payee);
    }
    if (input.amount !== undefined) {
      setClauses.push('amount = ?');
      params.push(input.amount);
    }
    if (input.checkNumber !== undefined) {
      setClauses.push('check_number = ?');
      params.push(input.checkNumber);
    }
    if (input.memo !== undefined) {
      setClauses.push('memo = ?');
      params.push(input.memo);
    }
    if (input.status !== undefined) {
      setClauses.push('status = ?');
      params.push(input.status);
    }

    setClauses.push('updated_at = ?');
    params.push(now);
    setClauses.push("_sync_status = 'pending'");
    params.push(input.id);

    await db.runAsync(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );

    if (input.splits !== undefined) {
      await db.runAsync(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
        [input.id]
      );
      for (const s of input.splits) {
        await db.runAsync(
          `INSERT INTO transaction_splits
             (id, transaction_id, amount, memo, _sync_status)
           VALUES (?, ?, ?, ?, 'pending')`,
          [newSplitId(), input.id, s.amount, s.memo]
        );
      }
    }

    const linkRow = await db.getFirstAsync<{
      transfer_link_id: string | null;
    }>('SELECT transfer_link_id FROM transactions WHERE id = ?', [input.id]);
    if (linkRow?.transfer_link_id) {
      const linked = await db.getFirstAsync<{
        id: string;
        account_id: string;
      }>(
        "SELECT id, account_id FROM transactions WHERE transfer_link_id = ? AND id != ? AND _sync_status != 'deleted'",
        [linkRow.transfer_link_id, input.id]
      );
      if (linked) {
        linkedAccountId = linked.account_id;
        linkedTransactionId = linked.id;
        const linkedFields = pickLinkedTransferUpdate(input);
        const linkedClauses: string[] = [];
        const linkedParams: any[] = [];
        if (linkedFields.txnDate !== undefined) {
          linkedClauses.push('txn_date = ?');
          linkedParams.push(linkedFields.txnDate);
        }
        if (linkedFields.amount !== undefined) {
          linkedClauses.push('amount = ?');
          linkedParams.push(linkedFields.amount);
        }
        if (linkedFields.memo !== undefined) {
          linkedClauses.push('memo = ?');
          linkedParams.push(linkedFields.memo);
        }
        if (linkedFields.status !== undefined) {
          linkedClauses.push('status = ?');
          linkedParams.push(linkedFields.status);
        }
        if (linkedClauses.length > 0) {
          linkedClauses.push('updated_at = ?');
          linkedParams.push(now);
          linkedClauses.push("_sync_status = 'pending'");
          linkedParams.push(linked.id);
          await db.runAsync(
            `UPDATE transactions SET ${linkedClauses.join(', ')} WHERE id = ?`,
            linkedParams
          );
        }
      }
    }

    primaryRow = await db.getFirstAsync<DbTransaction>(
      'SELECT * FROM transactions WHERE id = ?',
      [input.id]
    );
  });

  return {
    txn: mapTransaction(primaryRow!),
    linkedAccountId,
    linkedTransactionId,
  };
}

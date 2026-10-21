import {
  accountRefusalMessage,
  readAccountRefusal,
  type AccountRefusal,
} from './accountWriteGuard';
import { mapTransaction } from './mappers';
import type { DbTransaction, Transaction } from './types';

// The slice of the expo-sqlite API this module needs. Deliberately
// non-generic (unlike transactionUpdate's TxnDb) so the shared test fixture's
// better-sqlite3 adapter satisfies it as-is; the real SQLiteDatabase does too.
export interface TransferDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  getFirstAsync: (sql: string, params: any[]) => Promise<unknown>;
  getAllAsync: (sql: string, params: any[]) => Promise<unknown[]>;
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

/** The first account of a transfer that is not live here, and why (#163). */
interface TransferRefusal {
  role: 'from' | 'to';
  refusal: AccountRefusal;
}

/** How a transfer's refusal names the dead account: by its role. */
const TRANSFER_ROLE_SUBJECT = {
  from: 'The account you are transferring from',
  to: 'The account you are transferring to',
} as const;

const INSERT_LEG = `INSERT INTO transactions
     (id, user_id, account_id, txn_date, payee, amount, memo,
      status, transfer_link_id, created_at, updated_at, _sync_status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, 'pending')`;

/**
 * Writes both legs of a transfer, or neither.
 *
 * The legs share a transfer_link_id, which is what lets an edit or delete on
 * one side mirror to the other (transactionUpdate.ts, useDeleteTransaction).
 * As two bare INSERTs, a crash between them left one leg orphaned with a link
 * nothing resolves. One SQLite transaction closes that window on this device,
 * the same way applyTransactionUpdate does: both legs land, or neither. It
 * does not stop a push from reading between the two INSERTs. The push's reads
 * and its mark-synced are plain statements on the same connection, which the
 * transaction queue does not order (lib/transactionQueue.ts), so it can read
 * the first leg inside the open transaction and upload it alone. The second
 * leg goes up with the next push, and the link resolves then, unless this
 * transaction never commits (the app dies first, or a storage failure ends
 * it): the uploaded leg then stays alone.
 *
 * Both accounts must be live here and the user's own (#163, #177), or
 * nothing is written. The read is the transaction's first statement, so an
 * account delete -- itself a queued transaction (applyAccountDelete) -- runs
 * wholly before it or after both legs, and then marks them deleted with the
 * account. The Transfer screen opened from another account's register
 * (/transaction/transfer?fromAccountId=..., from the browser's history) took
 * that account as its From, which no list of the user's holds, and wrote a
 * leg under it; that account reads as missing now. Before #163, a register
 * re-opened on an account this device had deleted still offered its
 * transfer button: both legs went in, the server refused the dead account's
 * leg (23503, 005's inherit_account_tombstone), which stayed pending here
 * forever, and the other leg uploaded alone with its link dangling. A
 * refusal RETURNS from the task and is thrown once the transaction is over
 * (#127, #154): the transaction commits with nothing of the transfer's in
 * it, where a throw inside would roll back whatever plain statement joined
 * it (a pull's tombstone DELETE). What the read cannot stop is a plain
 * statement landing between it and the legs: a tombstone pulled from
 * another device that removes one of the accounts there leaves its leg to
 * the server's refusal, as any write into an account deleted elsewhere and
 * not yet pulled (#115).
 *
 * The refusal names the dead account by its role, the from account first,
 * each in its own case ("The account you are transferring from was deleted
 * on this device, so the transfer was not saved."). Once refused, the
 * account list refetches and the dead account leaves the form -- an empty
 * From box, or "Select account..." in To -- so words that did not say which
 * one would point at nothing on screen.
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
  let refused: TransferRefusal | null = null;

  await db.withTransactionAsync(async () => {
    const [from, to] = await readAccountRefusal(db, input.userId, [
      input.fromAccountId,
      input.toAccountId,
    ]);
    refused = from
      ? { role: 'from', refusal: from }
      : to
        ? { role: 'to', refusal: to }
        : null;
    if (refused) {
      return;
    }
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

  // Assigned inside the task, where TypeScript does not look: without the
  // cast it takes `refused` for null here.
  const refusal = refused as TransferRefusal | null;
  if (refusal) {
    throw new Error(
      accountRefusalMessage(
        refusal.refusal,
        TRANSFER_ROLE_SUBJECT[refusal.role],
        'the transfer was not saved'
      )
    );
  }
  return {
    linkId,
    from: mapTransaction(fromRow!),
    to: mapTransaction(toRow!),
  };
}

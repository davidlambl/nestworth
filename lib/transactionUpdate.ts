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
// runAsync resolves the statement's `changes` (expo-sqlite's SQLiteRunResult,
// better-sqlite3's RunResult): the parent UPDATE's tells whether the row is
// still here (#127) and not deleted here (#139).
export interface TxnDb {
  runAsync: (sql: string, params: any[]) => Promise<{ changes: number }>;
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
  let matched = false;
  let deletedHere = false;

  // All writes go in one SQLite transaction so the from-side, splits, and
  // to-side either all commit together or roll back together. Without this,
  // a failure between the primary UPDATE and the linked UPDATE would leave
  // the transfer pair desynchronized locally — the exact bug this module fixes.
  // An edit of a transaction that is no longer here (#127), or that this
  // device has deleted (#139), makes none of them: it is refused after the
  // primary UPDATE, before any other write.
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

    const updated = await db.runAsync(
      `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = ? AND _sync_status IS NOT 'deleted'`,
      params
    );
    // No row: the transaction is gone from this device (#127), or this
    // device has deleted it (#139). Gone: an update queued behind the reset's
    // wipe runs over the emptied store (#110), and the pull or realtime can
    // consume the row's tombstone just before this UPDATE. Nothing else may
    // be written then: split rows would commit under no parent, and once a
    // re-download restored it, the push would adopt them and upload them
    // beside the parent's own splits.
    //
    // Deleted here: a delete that ran first (applyTransactionDelete, or
    // applyAccountDelete's) left the row 'deleted' for the push to upload. An
    // edit still reaches it: offline, a Delete and then a Save on the edit
    // screen both wait for the network and run in turn when it returns;
    // online, a register that has not refetched since a delete still shows
    // the row's status toggle. Before #139 this UPDATE matched the row, set
    // it back to 'pending' and lost the delete: the push uploaded it live,
    // with no splits after a field edit (its own were 'deleted', so the push
    // replaced the server's with none), and of a transfer this leg alone,
    // while it tombstoned the other. Refused, the delete stands whichever of
    // the two runs first: an edit that runs before it is deleted with the
    // row. `IS NOT`, not `!=`: a NULL status (no writer makes one) is not a
    // delete, and `!=` would refuse that row as gone.
    //
    // Return, and throw below once the transaction is over, as wipeLocalData
    // refuses (#97): the transaction commits with nothing of this update's in
    // it. A throw here would roll back whatever joined it instead. A plain
    // write (the pull's, realtime's) runs inside any transaction open on the
    // shared connection, and expo-sqlite awaits each statement separately, so
    // the tombstone's two DELETEs can land between the BEGIN and this UPDATE:
    // rolled back, they bring back a transaction deleted elsewhere, while the
    // pull banks its cursor past the tombstone.
    //
    // The status read only picks the error's words, and it is a read. It
    // goes here, not after the transaction: the push hard-deletes a 'deleted'
    // row once it has uploaded the delete, and read after that, the error
    // would say the row no longer exists. Here narrows that, no more: the
    // push's DELETE is a plain statement, and can land between the two.
    //
    // `changes` counts every row the WHERE matched, even one whose values do
    // not change, so an edit that changes nothing is never refused.
    matched = updated.changes > 0;
    if (!matched) {
      const here = await db.getFirstAsync<{ _sync_status: string | null }>(
        'SELECT _sync_status FROM transactions WHERE id = ?',
        [input.id]
      );
      deletedHere = here?._sync_status === 'deleted';
      return;
    }

    if (input.splits !== undefined) {
      // Mark the old splits 'deleted', never drop them (#97). The push
      // replaces a parent's split set on the server only when one of its
      // local splits is unsynced, so a re-split must leave the rows it
      // replaced, and removing every split (`splits: []`) must leave
      // something, for the push to act on. The push leaves 'deleted' rows out
      // of the upload and hard-deletes them once the parent is marked synced;
      // every read filters them out. A row not pushed yet is marked too, and
      // goes the same way.
      await db.runAsync(
        `UPDATE transaction_splits SET _sync_status = 'deleted', updated_at = ?
         WHERE transaction_id = ? AND _sync_status != 'deleted'`,
        [now, input.id]
      );
      for (const s of input.splits) {
        await db.runAsync(
          `INSERT INTO transaction_splits
             (id, transaction_id, amount, memo, updated_at, _sync_status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [newSplitId(), input.id, s.amount, s.memo, now]
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

  // Assigned inside the task, where TypeScript does not look: without the
  // cast it takes primaryRow for null here. A row that vanishes after the
  // UPDATE matched is not expected. Every delete that can land inside this
  // transaction skips a pending row (the wipe's runs in a transaction of its
  // own, which waits for this one, #110), except the push's read-back drop,
  // and that would need a push that read this UPDATE's uncommitted row and
  // finished its upload before the read above. If it ever happens, the
  // writes above have committed by the time this throws, and the mutation
  // fails with this error, not a TypeError from mapTransaction.
  const row = primaryRow as DbTransaction | null;
  if (deletedHere) {
    // Not #127's words: the row is still here, and the user deleted it, or
    // its account, on this device. Nothing about the delete waiting to
    // upload, either, which would be stale when read: online the delete's
    // own push has sent it within the second, and offline the sync that
    // starts on reconnect, before this edit runs, or the push queued behind
    // that sync, sends it.
    throw new Error(
      'This transaction was deleted on this device, so this change was not saved.'
    );
  }
  if (!matched || !row) {
    throw new Error(
      'This transaction no longer exists on this device. It may have been deleted elsewhere or by a reset.'
    );
  }

  return {
    txn: mapTransaction(row),
    linkedAccountId,
    linkedTransactionId,
  };
}

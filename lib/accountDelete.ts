// The slice of the expo-sqlite API this module needs. Deliberately
// non-generic, as transactionDelete's TransactionDeleteDb, so the shared test
// fixture's better-sqlite3 adapter satisfies it as-is; the real SQLiteDatabase
// does too.
export interface AccountDeleteDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}

const MARK_TRANSACTIONS_DELETED =
  "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE account_id = ?";
const MARK_RULES_DELETED =
  "UPDATE recurring_rules SET _sync_status = 'deleted', updated_at = ? WHERE account_id = ?";
const MARK_ACCOUNT_DELETED =
  "UPDATE accounts SET _sync_status = 'deleted', updated_at = ? WHERE id = ?";

/**
 * Marks an account, its transactions and its recurring rules deleted, all or
 * nothing if the app is interrupted (#114).
 *
 * useDeleteAccount ran these as three separate statements, and an interruption
 * between them left a half-deleted account: its transactions, and perhaps its
 * rules, deleted under a live account, which the device showed as an emptied
 * account until the user deleted it again. One SQLite transaction closes that,
 * as it does for applyTransactionDelete.
 *
 * Every child is marked whatever its status, as before: one written offline
 * and never pushed goes too. The push's tombstone UPDATE then matches no server
 * row, which is its success case, and the local row is hard-deleted.
 *
 * Splits are deliberately left alone. The push's deleted-transactions path
 * removes a dead parent's splits, on the server and here, whatever their
 * status; the reset guard counts a split by its own status; the push adopts
 * orphaned unsynced splits only under a synced parent; and every read fetches
 * splits only for a live parent. Marking them would only add rows to the
 * guard's count until that same push cleared them.
 *
 * The other leg of a transfer out of this account stays live in its own
 * account, its transfer_link_id dangling. Nothing breaks: the linked-leg
 * lookups (applyTransactionUpdate, applyTransactionDelete) skip a deleted leg.
 *
 * Children first, the account last: an order pinned for the rollback tests.
 * Inside one transaction a failed statement is rolled back by expo-sqlite's
 * catch and a crash by SQLite's journal, whatever the order, and the queue in
 * lib/transactionQueue.ts means no other transaction can end this one early.
 * The tests fail the LAST statement, the account's, and can tell a transaction
 * from none only because the children's marks ran before it
 * (applyAccountDelete.test.ts). With the queue in, only SQLite abandoning the
 * transaction on a storage failure (a full disk, an I/O error) can let the
 * statements after that point commit alone, and then children first leaves the
 * account deleted over live children, stranding a never-pushed one among them
 * as the born-dead case in CONTRIBUTING's Known Issues, where account first
 * would leave an emptied, live account; the order stays children first because
 * the rollback tests pin it and that case needs a transient storage failure
 * mid-transaction while the delete's own later marks still succeed.
 */
export async function applyAccountDelete(
  db: AccountDeleteDb,
  id: string,
  opts: { now: string }
): Promise<void> {
  const { now } = opts;
  await db.withTransactionAsync(async () => {
    await db.runAsync(MARK_TRANSACTIONS_DELETED, [now, id]);
    await db.runAsync(MARK_RULES_DELETED, [now, id]);
    await db.runAsync(MARK_ACCOUNT_DELETED, [now, id]);
  });
}

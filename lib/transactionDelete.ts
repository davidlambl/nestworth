// The slice of the expo-sqlite API this module needs. Deliberately
// non-generic, as transferCreate's TransferDb, so the shared test fixture's
// better-sqlite3 adapter satisfies it as-is; the real SQLiteDatabase does too.
export interface TransactionDeleteDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  getFirstAsync: (sql: string, params: any[]) => Promise<unknown>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}

export interface DeleteTransactionResult {
  /** The other leg of a transfer, deleted with this one; null otherwise. */
  linkedTransactionId: string | null;
  linkedAccountId: string | null;
}

const MARK_SPLITS_DELETED =
  "UPDATE transaction_splits SET _sync_status = 'deleted', updated_at = ? WHERE transaction_id = ?";
const MARK_TRANSACTION_DELETED =
  "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = ?";

/**
 * Marks a transaction and its splits deleted, and the other leg of a transfer
 * with ITS splits, all or nothing if the app is interrupted (#97).
 *
 * useDeleteTransaction ran these as separate statements, and an interruption
 * after a split mark left 'deleted' splits under a live, 'synced' parent. The
 * push uploads splits only for a pending parent, so no push could clear them,
 * and "Reset & re-download" refused forever over a change it could never
 * upload. One SQLite transaction closes that, as it does for
 * applyTransactionUpdate and createTransfer. (The push also adopts any such
 * parent a pre-#97 build left behind; see pushChanges.)
 *
 * "All or nothing" holds for a crash or a failed statement. It does not hold
 * against another transaction on the shared connection: one whose BEGIN lands
 * in here fails, and its ROLLBACK ends THIS transaction, so the statements
 * after that point commit alone (see wipeLocalData). A transfer delete can
 * then be left with one leg deleted and the other live.
 *
 * That is why the splits go before their parent on each leg. A collision
 * landing between a leg's two marks rolls back the first and lets the second
 * commit alone. Splits first, that leaves a deleted parent over live splits,
 * which the push's deleted-transactions path clears; parent first, it would
 * leave deleted splits under a live parent, the very state #97 is about. The
 * rollback tests depend on the order too: they fail the parent's mark, and can
 * only tell a transaction from none because the split mark ran first
 * (applyTransactionDelete.test.ts).
 */
export async function applyTransactionDelete(
  db: TransactionDeleteDb,
  id: string,
  opts: { now: string }
): Promise<DeleteTransactionResult> {
  const { now } = opts;
  let linkedTransactionId: string | null = null;
  let linkedAccountId: string | null = null;

  await db.withTransactionAsync(async () => {
    const row = (await db.getFirstAsync(
      'SELECT transfer_link_id FROM transactions WHERE id = ?',
      [id]
    )) as { transfer_link_id: string | null } | null;

    await db.runAsync(MARK_SPLITS_DELETED, [now, id]);
    await db.runAsync(MARK_TRANSACTION_DELETED, [now, id]);

    if (row?.transfer_link_id) {
      // A leg already deleted is left as it is, stamp and all.
      const linked = (await db.getFirstAsync(
        "SELECT id, account_id FROM transactions WHERE transfer_link_id = ? AND id != ? AND _sync_status != 'deleted'",
        [row.transfer_link_id, id]
      )) as { id: string; account_id: string } | null;
      if (linked) {
        linkedTransactionId = linked.id;
        linkedAccountId = linked.account_id;
        await db.runAsync(MARK_SPLITS_DELETED, [now, linked.id]);
        await db.runAsync(MARK_TRANSACTION_DELETED, [now, linked.id]);
      }
    }
  });

  return { linkedTransactionId, linkedAccountId };
}

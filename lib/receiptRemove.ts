// The slice of the expo-sqlite API this module needs, as receiptAttach's
// ReceiptAttachDb has it. The shared test fixture's adapter satisfies it
// as-is; the real SQLiteDatabase does too.
export interface ReceiptRemoveDb {
  runAsync: (sql: string, params: any[]) => Promise<{ changes: number }>;
  getFirstAsync: (sql: string, params: any[]) => Promise<unknown>;
}

/**
 * Takes a receipt off its transaction and marks it pending, so the push
 * uploads `receipt_path: null` like any field edit (#23). Only while the
 * transaction still names THIS receipt: one replaced or removed meanwhile,
 * on another device and pulled here, keeps what it names now. And never a
 * row this device has marked deleted: setting it back to 'pending' would
 * make the push upload the edit instead of the delete (#139). `IS NOT`, not
 * `!=`, as the attach has it: a NULL status, which no writer sets, still
 * takes the removal.
 */
export const RECEIPT_REMOVE_SQL =
  "UPDATE transactions SET receipt_path = NULL, updated_at = ?, _sync_status = 'pending' WHERE id = ? AND receipt_path = ? AND _sync_status IS NOT 'deleted'";

/** What a zero match reads, to tell a gone row from one that moved on. */
export const RECEIPT_ROW_STATUS_SQL =
  'SELECT _sync_status FROM transactions WHERE id = ?';

/**
 * The words for a removal whose file went but whose transaction did not take
 * it: the row was removed from this device (a pulled tombstone, the reset's
 * wipe) or marked deleted here while the request was out.
 */
export const RECEIPT_REMOVED_BUT_GONE =
  'The receipt was removed, but this transaction no longer exists on this device, or was deleted here.';

/**
 * The same refusal when Storage had no file to remove: it was already gone
 * (removed on another device, or by an earlier removal whose answer was
 * lost), so nothing was removed, and the words say what was found.
 */
export const RECEIPT_ALREADY_GONE_AND_TXN_GONE =
  "The receipt's photo was already gone, and this transaction no longer exists on this device, or was deleted here.";

/**
 * The second half of removing a receipt: useRemoveReceipt has already removed
 * its file from Storage, or found it gone (`photoAlreadyGone`). Resolves true
 * when the transaction was cleared, and false when it no longer names `path`
 * (replaced or removed elsewhere): there is nothing to clear, and nothing to
 * push. Throws when this device no longer has the transaction, or has marked
 * it deleted, in words that say whether a file was removed.
 *
 * One plain statement, as the attach is, so the reset's wipe treats it the
 * same way (CONTRIBUTING, `resetLocalData`): landing before the transactions
 * DELETE it leaves the row pending without its receipt, which the wipe keeps
 * and the reset's drain pushes; landing after it, it matches nothing and
 * refuses, and the re-download brings the transaction back naming a file that
 * is gone, which the screen shows as missing until the receipt is removed
 * again.
 */
export async function applyReceiptRemove(
  db: ReceiptRemoveDb,
  id: string,
  path: string,
  opts: { now: string; photoAlreadyGone?: boolean }
): Promise<boolean> {
  const { changes } = await db.runAsync(RECEIPT_REMOVE_SQL, [
    opts.now,
    id,
    path,
  ]);
  if (changes > 0) {
    return true;
  }
  const row = (await db.getFirstAsync(RECEIPT_ROW_STATUS_SQL, [id])) as {
    _sync_status: string | null;
  } | null;
  if (!row || row._sync_status === 'deleted') {
    throw new Error(
      opts.photoAlreadyGone
        ? RECEIPT_ALREADY_GONE_AND_TXN_GONE
        : RECEIPT_REMOVED_BUT_GONE
    );
  }
  return false;
}

// The slice of the expo-sqlite API this module needs, as transactionUpdate's
// TxnDb has it: runAsync resolves the statement's `changes` (expo-sqlite's
// SQLiteRunResult, better-sqlite3's RunResult), which says whether the
// transaction took the receipt. The shared test fixture's adapter satisfies it
// as-is; the real SQLiteDatabase does too.
export interface ReceiptAttachDb {
  runAsync: (sql: string, params: any[]) => Promise<{ changes: number }>;
}

/**
 * Points a transaction at its uploaded receipt and marks it pending, unless
 * this device has marked it deleted: without the filter the UPDATE set a
 * deleted row back to 'pending', and the push uploaded a transaction the user
 * had deleted (#139). `IS NOT`, not `!=`: a NULL status, which no writer sets,
 * still takes the receipt, so a zero match means exactly "missing or deleted
 * here".
 */
export const RECEIPT_ATTACH_SQL =
  "UPDATE transactions SET receipt_path = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ? AND _sync_status IS NOT 'deleted'";

/**
 * Attaches an uploaded receipt to a transaction, or fails readably when this
 * device no longer has the transaction or has marked it deleted (#138).
 *
 * useReceiptPhoto uploads the photo first and attaches it after, and the
 * upload takes as long as the network does: a pulled tombstone or the reset's
 * wipe can remove the row meanwhile, and a delete on this device can mark it.
 * The attach used to report success in both cases, leaving the uploaded
 * object orphaned; the hook now removes it when this refuses.
 */
export async function applyReceiptAttach(
  db: ReceiptAttachDb,
  id: string,
  path: string,
  opts: { now: string }
): Promise<void> {
  const { changes } = await db.runAsync(RECEIPT_ATTACH_SQL, [
    path,
    opts.now,
    id,
  ]);
  if (changes === 0) {
    throw new Error(
      'The receipt was not attached: this transaction no longer exists on this device, or was deleted here.'
    );
  }
}

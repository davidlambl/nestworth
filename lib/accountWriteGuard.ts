/**
 * The account check every writer that creates a row under an account makes
 * (#163): a new transaction, a transfer, a CSV import and a new recurring
 * rule.
 *
 * None of them looked at the account. After an account delete
 * (applyAccountDelete marks the account and its children 'deleted', and the
 * push then removes the row), a screen that still held the account -- a
 * register re-opened on it (the browser's Forward, a stale link) or on
 * screen when another device deletes it, a form that keeps the account it
 * was given in its own state -- wrote a NEW row under it, 'pending'. The
 * server refuses a new child of a tombstoned account with 23503 and no hint
 * (005's inherit_account_tombstone), so the row stayed pending on this
 * device forever: retried on every push, shown in no register, and counted
 * by the reset guard, so "Reset & re-download" refused. For a transfer the
 * other leg uploaded alone, its link dangling.
 *
 * A live account is one this device holds and has not marked deleted:
 * `_sync_status IS NOT 'deleted'`, NULL-safe -- a NULL status (no writer
 * makes one) is not a delete, and a 'pending' account (created offline, not
 * yet pushed) is live. What this cannot know is an account another device
 * has deleted whose tombstone this device has not pulled yet: the write goes
 * in and the server refuses it, the born-dead row of CONTRIBUTING's Known
 * Issues, which #115 is to surface.
 *
 * And it is the signed-in user's own (#177). Several accounts sign in on one
 * device in turn and sign-out wipes no local rows, so another account's
 * account is here, live: the New Transaction and Transfer screens opened on
 * its id (the browser's history, a typed link) wrote the signed-in user's row
 * under it, and the server took it -- 001's foreign key and policy look at the
 * row's own user only. Another account's account reads as missing, in the
 * words for one that is not here: "was deleted on this device" would say it
 * is here, for someone else.
 */

/** The slice of the expo-sqlite API the read needs. */
export interface AccountReadDb {
  getAllAsync: (sql: string, params: any[]) => Promise<unknown[]>;
}

/**
 * The guard a single-row writer puts inside its INSERT, as
 * `INSERT … SELECT … WHERE ${LIVE_ACCOUNT}` with the account id and then the
 * user id bound last: one statement, so nothing -- not even an account
 * delete's queued transaction -- can land between the check and the write,
 * and the writer opens no transaction of its own. A refused INSERT changes no
 * row.
 */
export const LIVE_ACCOUNT =
  "EXISTS (SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND _sync_status IS NOT 'deleted')";

/**
 * useCreateTransaction's INSERT: a new transaction, 'pending', only while
 * its account is live here and the user's. Thirteen parameters: id, user_id,
 * account_id, txn_date, payee, amount, check_number, memo, status,
 * created_at, updated_at, then the account id and the user id again for the
 * guard. Exported so the wipe suite runs the hook's own statement.
 */
export const CREATE_TRANSACTION_SQL = `INSERT INTO transactions
     (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
      status, created_at, updated_at, _sync_status)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
   WHERE ${LIVE_ACCOUNT}`;

/**
 * useCreateRecurringRule's INSERT: a new rule, 'pending', only while its
 * account is live here and the user's. Eleven parameters: id, user_id,
 * account_id, frequency, next_date, end_date, template, created_at,
 * updated_at, then the account id and the user id again for the guard.
 * Exported for the wipe suite, as above.
 */
export const CREATE_RULE_SQL = `INSERT INTO recurring_rules
     (id, user_id, account_id, frequency, next_date, end_date, template,
      created_at, updated_at, _sync_status)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
   WHERE ${LIVE_ACCOUNT}`;

/** Why a write into an account must be refused. */
export type AccountRefusal = 'deleted' | 'missing';

/**
 * Each account's refusal, in the order given: 'deleted' when this device has
 * marked it deleted, 'missing' when it is not on this device at all (this
 * device's own delete once its push has removed the row, a tombstone pulled
 * from another device, or the reset's wipe before its re-download) or is
 * another account's (#177), or null while it is live and `userId`'s. One
 * statement reads them all. A multi-row writer reads it as the first
 * statement of its transaction, before any INSERT (createTransfer, both
 * accounts at once; applyTransactionImport); a single-row writer reads it
 * only to word a refusal its guarded INSERT has already made.
 */
export async function readAccountRefusal(
  db: AccountReadDb,
  userId: string,
  accountIds: string[]
): Promise<(AccountRefusal | null)[]> {
  const ids = Array.from(new Set(accountIds));
  const rows = (await db.getAllAsync(
    `SELECT id, _sync_status FROM accounts WHERE id IN (${ids.map(() => '?').join(', ')}) AND user_id = ?`,
    [...ids, userId]
  )) as { id: string; _sync_status: string | null }[];
  const status = new Map(rows.map((r) => [r.id, r._sync_status]));
  return accountIds.map((id) =>
    !status.has(id)
      ? 'missing'
      : status.get(id) === 'deleted'
        ? 'deleted'
        : null
  );
}

/**
 * The refusal's words, in the house's shape: what happened to the account,
 * then what was not written ("…, so the transaction was not saved."). The
 * mutation cache shows them as "Save failed: <words>" on the sync indicator.
 */
export function accountRefusalMessage(
  refusal: AccountRefusal,
  subject: string,
  outcome: string
): string {
  return refusal === 'deleted'
    ? `${subject} was deleted on this device, so ${outcome}.`
    : `${subject} no longer exists on this device, so ${outcome}.`;
}

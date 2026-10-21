import {
  accountRefusalMessage,
  type AccountRefusal,
} from './accountWriteGuard';
import type { RefusedTable } from './syncRefusals';

// The two writers for a row the push can never upload as it is (#115;
// lib/syncRefusals.ts): move it to a live account, or discard it. Their only
// callers are lib/hooks/useRefusedRows.ts's hooks, for the list Settings
// opens (app/unsynced.tsx), whose third way out, Edit, is the register's own
// edit screen.

// The slice of the expo-sqlite API these writers need, as recurringRuleDelete's
// has it: runAsync resolves the statement's `changes` (expo-sqlite's
// SQLiteRunResult, better-sqlite3's RunResult). The shared test fixture's
// adapter satisfies it as-is; the real SQLiteDatabase does too.
export interface RefusedRowDb {
  runAsync: (sql: string, params: any[]) => Promise<{ changes: number }>;
  getFirstAsync: (sql: string, params: any[]) => Promise<unknown>;
}

/** The row as Settings showed it: the version the push was refused. */
export interface RefusedRowRef {
  table: RefusedTable;
  id: string;
  /** The `updated_at` the push read; the write takes only that version. */
  updatedAt: string | null;
  userId: string;
}

/**
 * The first writer of `account_id` in the app (CONTRIBUTING's Known Issues:
 * no edit path writes it). One statement, so nothing can land between its
 * checks and its write, and no transaction of its own:
 *
 *  - the row is this user's, still 'pending', and still the version the push
 *    was refused (`updated_at IS ?`, NULL-safe): one edited, discarded or
 *    uploaded since the list was read is left alone;
 *  - the account it goes to is this user's and live here (`IS NOT 'deleted'`,
 *    NULL-safe, as lib/accountWriteGuard.ts's LIVE_ACCOUNT, with the user
 *    added): one deleted here, or gone, is refused, and the write would only
 *    be refused again by the server if another device has deleted it since;
 *  - for a transfer leg, the other leg is not in that account (unless it is
 *    deleted here; `IS NOT`, NULL-safe as the account guard): a transfer
 *    into the account it comes from is no transfer.
 *
 * It sets the row 'pending' with a fresh stamp, so the next push uploads it
 * as a new row under the account it names; its split lines, keyed by the
 * transaction, go with it unchanged, and a transfer keeps its link: the
 * other leg is not touched. Eight parameters: the account, the stamp, the
 * row's id, the user, the version read, then the account, the user and the
 * account again for the two guards.
 */
export const MOVE_TRANSACTION_SQL = `UPDATE transactions
   SET account_id = ?, updated_at = ?, _sync_status = 'pending'
 WHERE id = ? AND user_id = ? AND _sync_status = 'pending' AND updated_at IS ?
   AND EXISTS (SELECT 1 FROM accounts
                WHERE id = ? AND user_id = ? AND _sync_status IS NOT 'deleted')
   AND NOT EXISTS (SELECT 1 FROM transactions o
                    WHERE o.transfer_link_id = transactions.transfer_link_id
                      AND o.id != transactions.id AND o.account_id = ?
                      AND o._sync_status IS NOT 'deleted')`;

/** MOVE_TRANSACTION_SQL for a recurring rule, which has no transfer: seven parameters. */
export const MOVE_RULE_SQL = `UPDATE recurring_rules
   SET account_id = ?, updated_at = ?, _sync_status = 'pending'
 WHERE id = ? AND user_id = ? AND _sync_status = 'pending' AND updated_at IS ?
   AND EXISTS (SELECT 1 FROM accounts
                WHERE id = ? AND user_id = ? AND _sync_status IS NOT 'deleted')`;

/**
 * Discards a refused row: marks it 'deleted', as the app's own deletes do,
 * under the same version guard as the move. The push then sends its
 * tombstone, which matches nothing on the server for a row the server never
 * held (a child of a deleted account, a row whose upload never went in), and
 * removes it here, its split lines first (the push's deleted-transactions
 * path takes a deleted parent's splits whatever their status, #137). Only the
 * row: a transfer's other leg, live in its own account, stays as it is.
 * Four parameters: the stamp, the row's id, the user, then the version read.
 */
export const DISCARD_TRANSACTION_SQL = `UPDATE transactions SET _sync_status = 'deleted', updated_at = ?
 WHERE id = ? AND user_id = ? AND _sync_status = 'pending' AND updated_at IS ?`;

/** DISCARD_TRANSACTION_SQL for a recurring rule. */
export const DISCARD_RULE_SQL = `UPDATE recurring_rules SET _sync_status = 'deleted', updated_at = ?
 WHERE id = ? AND user_id = ? AND _sync_status = 'pending' AND updated_at IS ?`;

const NOUN = { transactions: 'transaction', recurring_rules: 'rule' } as const;

/** What a zero match found: the row's state now, and the account's. */
interface MoveState {
  status: string | null;
  updated_at: string | null;
  target: string | null;
  target_here: number;
  same_side: number;
}

/**
 * Moves a refused row to another account, or fails readably (one sentence,
 * the house's shape) when the row or the account is not what the list showed.
 * The statement's `changes` decides; a read after a zero match only picks
 * the words.
 */
export async function applyRefusedRowMove(
  db: RefusedRowDb,
  row: RefusedRowRef,
  accountId: string,
  opts: { now: string }
): Promise<void> {
  const { changes } =
    row.table === 'transactions'
      ? await db.runAsync(MOVE_TRANSACTION_SQL, [
          accountId,
          opts.now,
          row.id,
          row.userId,
          row.updatedAt,
          accountId,
          row.userId,
          accountId,
        ])
      : await db.runAsync(MOVE_RULE_SQL, [
          accountId,
          opts.now,
          row.id,
          row.userId,
          row.updatedAt,
          accountId,
          row.userId,
        ]);
  if (changes > 0) {
    return;
  }
  const noun = NOUN[row.table];
  const transfer = row.table === 'transactions';
  const state = (await db.getFirstAsync(
    `SELECT r._sync_status AS status, r.updated_at,
            (SELECT _sync_status FROM accounts WHERE id = ? AND user_id = ?) AS target,
            EXISTS (SELECT 1 FROM accounts WHERE id = ? AND user_id = ?) AS target_here,
            ${
              transfer
                ? `(SELECT COUNT(*) FROM transactions o
                     WHERE o.transfer_link_id = r.transfer_link_id AND o.id != r.id
                       AND o.account_id = ? AND o._sync_status IS NOT 'deleted')`
                : '0'
            } AS same_side
       FROM ${row.table} r WHERE r.id = ? AND r.user_id = ?`,
    [
      accountId,
      row.userId,
      accountId,
      row.userId,
      ...(transfer ? [accountId] : []),
      row.id,
      row.userId,
    ]
  )) as MoveState | null;
  if (!state) {
    throw new Error(
      `This ${noun} no longer exists on this device, so it was not moved.`
    );
  }
  if (state.status === 'deleted') {
    throw new Error(
      `This ${noun} was deleted on this device, so it was not moved.`
    );
  }
  if (state.status !== 'pending' || state.updated_at !== row.updatedAt) {
    throw new Error(
      `This ${noun} changed on this device since the list was shown, so it was not moved.`
    );
  }
  if (!state.target_here || state.target === 'deleted') {
    const refusal: AccountRefusal = state.target_here ? 'deleted' : 'missing';
    throw new Error(
      accountRefusalMessage(
        refusal,
        'The account you chose',
        `the ${noun} was not moved`
      )
    );
  }
  if (state.same_side) {
    throw new Error(
      'The other side of this transfer is in the account you chose, so the transaction was not moved.'
    );
  }
  // Unreachable while the statement's guards are the ones read above.
  throw new Error(`This ${noun} could not be moved.`);
}

/**
 * Discards a refused row, or fails readably when it changed since the list
 * was shown (edited, or uploaded after all). Resolves `false`, writing
 * nothing, when the row is already deleted here or gone: a second tap, or one
 * after the push has removed it, has nothing left to do.
 */
export async function applyRefusedRowDiscard(
  db: RefusedRowDb,
  row: RefusedRowRef,
  opts: { now: string }
): Promise<boolean> {
  const { changes } = await db.runAsync(
    row.table === 'transactions' ? DISCARD_TRANSACTION_SQL : DISCARD_RULE_SQL,
    [opts.now, row.id, row.userId, row.updatedAt]
  );
  if (changes > 0) {
    return true;
  }
  const state = (await db.getFirstAsync(
    `SELECT _sync_status AS status FROM ${row.table} WHERE id = ? AND user_id = ?`,
    [row.id, row.userId]
  )) as { status: string | null } | null;
  if (!state || state.status === 'deleted') {
    return false;
  }
  throw new Error(
    `This ${NOUN[row.table]} changed on this device since the list was shown, so it was not discarded.`
  );
}

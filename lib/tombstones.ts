// Server-side tombstones (backlog #18).
//
// A remote delete is no longer a hard DELETE: the pushing device stamps
// `deleted_at` on the server row, which makes the delete an ordinary UPDATE
// that the existing `updated_at > cursor` incremental pull already sees. That
// is what lets pulls stop enumerating every remote (id, updated_at) on every
// sync just to notice what another device removed.
//
// There is no `deleted_at` column in local SQLite (see CONTRIBUTING.md,
// "Soft-delete pattern"): consuming a tombstone means hard-deleting the local
// row. Every consumer routes through the helpers below so the "only touch rows
// that are already synced" scoping is written once.
//
// This module deliberately imports NOTHING from './sync'. `lib/hooks/
// useRealtimeSync.ts` imports both, so a cycle here would leave one of the two
// modules half-initialised at evaluation time (an `undefined` import at the
// exact moment a realtime event arrives).

/**
 * True when the server has stamped `deleted_at` on a row.
 *
 * `row?.` because realtime payloads do not always carry the record this asks
 * about (a DELETE event has `old` but no `new`), and `!= null` because the key
 * may be absent rather than null: PostgREST omits it from a narrowed
 * `.select('id, updated_at')` and returns an explicit null from `.select('*')`.
 * Both mean "live".
 */
export function isTombstone(row: any): boolean {
  return row?.deleted_at != null;
}

/**
 * Consume a transaction tombstone: hard-delete the local row, but ONLY while it
 * is 'synced'.
 *
 * The 'synced' scope is the whole point. A 'pending' row holds a local edit
 * that has not reached the server yet, and a 'deleted' row is a local delete
 * still queued for push; dropping either would silently discard work the user
 * did offline and lose the queue entry that would have told the server about
 * it. Those rows are resolved by push instead, which learns the server's answer
 * (its edit lands on the tombstone, so delete wins) rather than guessing here.
 *
 * The splits are deleted only when the parent delete actually changed a row.
 * Deleting them unconditionally would strip the splits off a 'pending' parent
 * we just refused to touch — silently mangling the very unsynced edit the scope
 * exists to protect. `transaction_splits` has no tombstone of its own: splits
 * ride their parent and stay hard-deleted.
 *
 * @returns true when a local row was actually removed.
 */
export async function deleteLocalTransactionIfSynced(
  db: any,
  id: string
): Promise<boolean> {
  const res = await db.runAsync(
    "DELETE FROM transactions WHERE id = ? AND _sync_status = 'synced'",
    [id]
  );
  if (!res?.changes) return false;
  await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [
    id,
  ]);
  return true;
}

/**
 * Consume an account tombstone. Scoped to 'synced' for the same reason as
 * deleteLocalTransactionIfSynced: a 'pending'/'deleted' local row is unsynced
 * work that only push may resolve.
 *
 * Children are NOT cascaded locally. The server's `accounts_tombstone_children`
 * trigger stamps the account's transactions and rules, so each child arrives as
 * its own tombstone and is removed through its own scoped delete — which keeps
 * a child carrying a pending local edit from being destroyed as collateral.
 *
 * @returns true when a local row was actually removed.
 */
export async function deleteLocalAccountIfSynced(
  db: any,
  id: string
): Promise<boolean> {
  const res = await db.runAsync(
    "DELETE FROM accounts WHERE id = ? AND _sync_status = 'synced'",
    [id]
  );
  return !!res?.changes;
}

/**
 * Consume a recurring-rule tombstone. Scoped to 'synced' for the same reason as
 * deleteLocalTransactionIfSynced: never destroy an unsynced local edit or a
 * queued local delete.
 *
 * @returns true when a local row was actually removed.
 */
export async function deleteLocalRuleIfSynced(
  db: any,
  id: string
): Promise<boolean> {
  const res = await db.runAsync(
    "DELETE FROM recurring_rules WHERE id = ? AND _sync_status = 'synced'",
    [id]
  );
  return !!res?.changes;
}

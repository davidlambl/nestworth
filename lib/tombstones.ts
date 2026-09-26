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
// exact moment a realtime event arrives). lib/db.ts imports it too, for the
// launch sweep below, so it must not import './db' either.

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
 * The splits go FIRST, and only while the parent is still 'synced': their
 * DELETE carries the parent's own condition. Deleting them unconditionally
 * would strip the splits off a 'pending' parent we refuse to touch, silently
 * mangling the very unsynced edit the scope exists to protect. First, because
 * the statements are plain and separate (#137). The app killed between the
 * split DELETE and the parent DELETE, or the parent DELETE throwing, used to
 * leave the splits with no parent: invisible, and never cleaned up. Now it
 * leaves the parent, still synced, without its splits, and the next pull
 * deletes it, or at the latest the daily reconcile (when the pull cursor is
 * already past the tombstone, or a purge left none).
 *
 * Splits first opens one window of its own, which the third statement closes.
 * Realtime runs this beside a sync that holds the lock, and between the two
 * DELETEs the parent is still synced, so upsertRemoteSplit's guard lets in a
 * server split the sync writes for it right then (step 3, the reconcile's
 * refresh, the refresh after a push, the first-login download). Once the
 * parent DELETE has removed the row, the third statement deletes any split
 * still pointing at it. What is left to sweepOrphanSyncedSplits at the next
 * launch: such a split when the app is killed just before that third
 * statement, and whatever a storage failure strands by rolling back a
 * transaction one of these statements joined, in either order.
 * `transaction_splits` has no tombstone of its own: splits ride their parent
 * and stay hard-deleted.
 *
 * @returns true when a local row was actually removed.
 */
export async function deleteLocalTransactionIfSynced(
  db: any,
  id: string
): Promise<boolean> {
  await db.runAsync(
    `DELETE FROM transaction_splits WHERE transaction_id = ?
       AND EXISTS (SELECT 1 FROM transactions
                    WHERE id = ? AND _sync_status = 'synced')`,
    [id, id]
  );
  const res = await db.runAsync(
    "DELETE FROM transactions WHERE id = ? AND _sync_status = 'synced'",
    [id]
  );
  if (!res?.changes) return false;
  // A server split a sync wrote between the two statements above, while the
  // parent was still synced, has no parent now (see the docblock).
  await db.runAsync(
    `DELETE FROM transaction_splits WHERE transaction_id = ?
       AND NOT EXISTS (SELECT 1 FROM transactions WHERE id = ?)`,
    [id, id]
  );
  return true;
}

/**
 * Delete every 'synced' split whose transaction row is gone, and return how
 * many went (#137). lib/db.ts runs it at every launch, after the migration
 * ladder and before any caller has the connection. It is not a ladder step:
 * a step raises the schema version, and no older build could open the
 * database again, for a DELETE that needs no version at all.
 *
 * Such a split is garbage whenever it exists. Every split read is keyed on a
 * loaded parent or joined to one, so nothing shows it; nothing counts it for
 * the reset guard, pushes it or wipes it (the wipe finds splits through their
 * parent); and its parent is dead on the server: tombstoned, absent from the
 * reconcile's enumeration, or purged. Were the parent ever to come back, the
 * reconcile would download it together with its splits, so nothing is lost.
 * No writer makes one on purpose: a server split is written only under a
 * synced parent (upsertRemoteSplit), and a local writer writes its parent
 * first and its splits 'pending'. They come from:
 *
 *  - builds before v1.1.8 (#125): a realtime tombstone of the parent landing
 *    during a split read (the pull's step 3, the reconcile's refresh, the
 *    post-push refresh) left the server's splits inserted under a parent
 *    already deleted here;
 *  - builds before v1.1.7 (#110): a delete colliding with the reset's wipe on
 *    the shared connection could leave "the parents gone and their splits
 *    left behind" (lib/transactionQueue.ts);
 *  - builds before #137: deleteLocalTransactionIfSynced above, and the push's
 *    read-back drop and deleted-transactions batch (lib/sync.ts), deleted the
 *    parent first, so the app killed between their two plain statements, or
 *    the second one throwing, stranded its splits. All three now go splits
 *    first;
 *  - still now, rarely: a storage failure (a full disk, an I/O error) that
 *    rolls back a hook's transaction one of those plain DELETEs had joined
 *    undoes that DELETE with it, which strands splits in either order; and
 *    the app killed just before deleteLocalTransactionIfSynced's third
 *    statement, when a sync wrote a server split between its first two (see
 *    there).
 *
 * 'synced' only. A 'pending' or 'deleted' split with no parent row looks
 * exactly like what the reset's wipe keeps on purpose (an unsynced split
 * outlives its synced parent, which the re-download restores and the next
 * push adopts: wipeLocalData, #126), so it is left alone, and so is a NULL
 * status, which the wipe skips as well.
 *
 * NOT EXISTS rather than `transaction_id NOT IN (SELECT id FROM
 * transactions)`: transactions.id is TEXT PRIMARY KEY without NOT NULL, and a
 * single NULL id would make that NOT IN NULL for every split, so the sweep
 * would delete nothing. The correlated probe rides the primary key: one scan
 * of transaction_splits per launch, and splits are few.
 *
 * @returns how many splits were deleted.
 */
export async function sweepOrphanSyncedSplits(db: any): Promise<number> {
  const res = await db.runAsync(
    `DELETE FROM transaction_splits
     WHERE _sync_status = 'synced'
       AND NOT EXISTS (SELECT 1 FROM transactions t
                        WHERE t.id = transaction_splits.transaction_id)`
  );
  return res?.changes ?? 0;
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

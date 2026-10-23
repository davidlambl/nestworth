// What a realtime row event means for the local DB (backlog #18).
//
// Extracted from `lib/hooks/useRealtimeSync.ts` and kept free of React and of
// the react-query client on purpose: the routing decision below is the part
// with the data-loss failure modes in it, and as a plain function it can be
// unit-tested against a real SQLite adapter instead of only through a rendered
// hook. The hook keeps what is genuinely hook-shaped — the channel
// subscription, the try/catch, and cache invalidation.
//
// Why the routing had to change: a delete is now a server-side tombstone, so it
// reaches this file as an ordinary UPDATE carrying `deleted_at`, not as a
// DELETE event. The pre-tombstone handler only branched on
// `eventType === 'DELETE'`, so every tombstone fell through to the upsert
// branch. `upsertRemote*` refuses tombstones (lib/sync.ts), which is what stops
// the row being re-INSERTed — but refusing is not the same as acting: with only
// that guard, a row another device deleted would sit on screen until the next
// pull happened to notice. The branches below consume the tombstone instead.

import {
  upsertRemoteAccount,
  upsertRemoteRule,
  upsertRemoteTransaction,
} from './sync';
import {
  isTombstone,
  deleteLocalAccountIfSynced,
  deleteLocalRuleIfSynced,
  deleteLocalTransactionIfSynced,
} from './tombstones';

/**
 * The slice of Supabase's `RealtimePostgresChangesPayload` these handlers read.
 *
 * Declared structurally rather than imported from supabase-js so this module
 * pulls in no realtime client at all, and so the tests can hand in plain object
 * literals. Every field is optional because the shape genuinely varies by
 * event: a DELETE carries `old` and an empty `new`, an INSERT the reverse.
 */
export interface RealtimeRowEvent {
  eventType?: string;
  new?: any;
  old?: any;
}

/**
 * Shared routing for one table's realtime event. Both public handlers differ
 * only in which table's helpers they pass in, so the three cases — and the
 * reasoning behind them — are written once here.
 *
 * Case order is load-bearing: the DELETE check must come first because a DELETE
 * payload carries no `new` record, so the tombstone check would have nothing to
 * read and the event would fall through to the upsert branch.
 */
async function applyRowEvent(
  payload: RealtimeRowEvent,
  deleteLocalIfSynced: (id: string) => Promise<boolean>,
  upsertRemote: (row: any) => Promise<void>
): Promise<void> {
  if (payload.eventType === 'DELETE') {
    // `purge_tombstones()` hard-deletes expired tombstones, and any client
    // that predates #18 hard-deletes on every user delete; both broadcast a
    // real DELETE. None of them reaches these handlers today, though: every
    // listener they serve is filtered on user_id, and a DELETE carries only
    // the primary key while the table keeps the default replica identity, so
    // Realtime cannot match the filter and drops it (read from production's
    // realtime.apply_rls and Supabase's Postgres Changes guide, 2026-10-23:
    // "You can only filter Delete events ... if the table has the replica
    // identity set to full"). The branch stays for a table that ever gets
    // that replica identity, and so that a DELETE never falls through to the
    // upsert.
    //
    // What did change is the scope. The previous unconditional
    // `DELETE FROM ... WHERE id = ?` destroyed the local row even when it held
    // a pending offline edit or a queued local delete, silently discarding work
    // that had never reached the server (issue #21, first bullet). Those rows
    // are push's to resolve, not realtime's.
    const id = payload.old?.id;
    if (id) {
      await deleteLocalIfSynced(id);
    }
    return;
  }

  if (isTombstone(payload.new)) {
    // The tombstone path. Usually an UPDATE; an INSERT can carry `deleted_at`
    // too, because the server's `inherit_account_tombstone` trigger stamps a
    // row born into an already-deleted account.
    const id = payload.new?.id;
    if (id) {
      await deleteLocalIfSynced(id);
    }
    return;
  }

  // A live row: unchanged from the pre-tombstone handler. The upsert does its
  // own 'synced'-and-not-older guarding, so no extra checks belong here.
  if (payload.new) {
    await upsertRemote(payload.new);
  }
}

/** Apply one realtime `accounts` event to the local DB. */
export async function applyAccountEvent(
  db: any,
  payload: RealtimeRowEvent
): Promise<void> {
  await applyRowEvent(
    payload,
    (id) => deleteLocalAccountIfSynced(db, id),
    (row) => upsertRemoteAccount(db, row)
  );
}

/**
 * Apply one realtime `transactions` event to the local DB.
 *
 * It writes the parent alone. A tombstone takes the splits with it:
 * `deleteLocalTransactionIfSynced` drops them first, while the parent is
 * still synced, and then the parent. A live parent's splits arrive through
 * their own events, which name the parent for refreshSplitsFromServer (see
 * splitEventParent): the server writes a parent before its splits, so a
 * parent another device created or re-split is here a little before its
 * set is (#21).
 */
export async function applyTransactionEvent(
  db: any,
  payload: RealtimeRowEvent
): Promise<void> {
  await applyRowEvent(
    payload,
    (id) => deleteLocalTransactionIfSynced(db, id),
    (row) => upsertRemoteTransaction(db, row)
  );
}

/**
 * Apply one realtime `recurring_rules` event to the local DB (#21): the same
 * three cases as the other two tables. A live rule goes through
 * `upsertRemoteRule`, the statement the pull writes every rule with, so a
 * rule this device holds 'pending' or 'deleted' (an edit, a post's advance,
 * a delete not pushed yet) is never overwritten, and an older one never
 * replaces a newer one; a tombstone is consumed by `deleteLocalRuleIfSynced`,
 * which spares the same unsynced rows. A rule another device advanced by
 * posting arrives here as an UPDATE of its `next_date`, beside the posted
 * transaction's own INSERT.
 */
export async function applyRuleEvent(
  db: any,
  payload: RealtimeRowEvent
): Promise<void> {
  await applyRowEvent(
    payload,
    (id) => deleteLocalRuleIfSynced(db, id),
    (row) => upsertRemoteRule(db, row)
  );
}

/**
 * The transaction a realtime `transaction_splits` event is about, for
 * refreshSplitsFromServer to read again (#21), or null when the event is
 * nothing of `userId`'s to act on.
 *
 * The split listener cannot be filtered: the table has no `user_id`. An
 * INSERT or an UPDATE reaches it only when RLS lets the user read the row
 * (001's split policy, through the parent), and carries the whole row, so
 * its `transaction_id` is the parent; whether this device holds that parent,
 * synced, is the refresh's question, asked when it runs. A DELETE skips RLS,
 * so every user's split deletes reach every subscriber, and with RLS on its
 * `old` carries the split's id alone: it is tied to a parent only through a
 * split this device holds under one of `userId`'s transactions, and dropped
 * otherwise (another account's split, one never held here, one already gone).
 * Nothing is written here.
 */
export async function splitEventParent(
  db: any,
  userId: string,
  payload: RealtimeRowEvent
): Promise<string | null> {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id;
    if (!id) return null;
    const row = await db.getFirstAsync(
      `SELECT t.id FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
        WHERE s.id = ? AND t.user_id = ?`,
      [id, userId]
    );
    return row?.id ?? null;
  }
  const parentId = payload.new?.transaction_id;
  return typeof parentId === 'string' && parentId !== '' ? parentId : null;
}

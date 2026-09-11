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

import { upsertRemoteAccount, upsertRemoteTransaction } from './sync';
import {
  isTombstone,
  deleteLocalAccountIfSynced,
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
    // Still reachable after #18, so this branch stays: `purge_tombstones()`
    // hard-deletes expired tombstones, and any client that predates this change
    // hard-deletes on every user delete. Both broadcast a real DELETE.
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
 * Splits are not handled separately: `deleteLocalTransactionIfSynced` drops
 * them along with the parent, and only when the parent was actually removed.
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

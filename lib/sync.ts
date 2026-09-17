import { supabase } from './supabase';
import { getDb, getSyncMeta, setSyncMeta } from './db';
import {
  deleteLocalAccountIfSynced,
  deleteLocalRuleIfSynced,
  deleteLocalTransactionIfSynced,
  isTombstone,
} from './tombstones';
import { refreshSyncState, setLastError, setSyncing } from './syncStatus';

/**
 * How stale `last_txn_reconcile_at:<userId>` may get before pullTransactions
 * pays for a full remote enumeration again.
 *
 * Before tombstones every sync enumerated every remote (id, updated_at) just to
 * notice what another device had deleted, which made the cost of a sync
 * proportional to total history rather than to what changed (#18). A delete is
 * now an UPDATE the incremental pull sees for itself, so the enumeration is
 * demoted to a periodic safety net for the two things it alone can catch: a row
 * that vanished without a tombstone (purge_tombstones ran, or an old client
 * hard-deleted it) and drift corrected to a timestamp OLDER than our cursor.
 *
 * 24 h must stay comfortably below the server's tombstone retention (30 days in
 * 005_tombstones.sql): a device offline longer than that retention misses the
 * purged tombstone entirely and has nothing but this pass to fall back on.
 */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let _syncInProgress = false;
// Work requested while the lock was held. finishSync drains both before the
// holder releases the lock, so a request that arrives mid-sync is never lost.
let _pushQueued = false;
let _fullSyncQueued = false;
// Settles once the current lock holder has released the lock. Sync failures
// never reject it (every holder catches them, and resetLocalData's rethrow is
// swallowed here); only a throwing status listener could. It is assigned just
// after run() starts, so a listener that re-entered the engine synchronously
// from setSyncing(true) would see the previous value. None does today.
let _inFlight: Promise<void> | null = null;
// How many queued follow-ups one holder drains before handing the rest to the
// next trigger. A bound, not a target: it only matters if something keeps
// requesting syncs faster than they complete.
const MAX_QUEUED_DRAINS = 10;

async function notifySyncState(userId: string) {
  try {
    await refreshSyncState(userId);
  } catch (e) {
    console.warn('[sync] refresh status failed:', e);
  }
}

/**
 * Every lock holder ends here, from its finally block.
 *
 * Drains whatever was requested while the lock was held — using the lock-free
 * primitives, so there is no release/re-acquire gap for a request to fall
 * into — then refreshes the pending count, and only then publishes
 * isSyncing=false and releases the lock, with no await between the last
 * empty-queue check and the release. Two invariants follow:
 *
 *   - A requestPush() or fullSync() that found the lock held always results in
 *     one more push (and pull) before the holder's promise resolves. Before
 *     this helper, initialPull deliberately skipped the drain and left it to
 *     the fullSync that useSyncEngine ran next — and that fullSync was skipped
 *     whenever the effect had been torn down and re-run mid-bootstrap, which
 *     happened on nearly every launch. Anything created during the first sync
 *     then sat `pending` until the next AppState/NetInfo event (#55).
 *   - The sidebar label reads `Synced` only when nothing is in flight AND the
 *     count was refreshed after the last write. The Playwright helpers wait on
 *     that exact word to prove a delete was pushed (#54).
 */
async function finishSync(userId: string): Promise<void> {
  try {
    let drained = 0;
    let capped = false;
    do {
      while (!capped && (_pushQueued || _fullSyncQueued)) {
        if (drained >= MAX_QUEUED_DRAINS) {
          console.warn(
            `[sync] drained ${drained} queued follow-ups and more keep arriving; leaving the rest for the next trigger`
          );
          capped = true;
          break;
        }
        drained++;
        const full = _fullSyncQueued;
        _pushQueued = false;
        _fullSyncQueued = false;
        console.log(`[sync] draining queued ${full ? 'full sync' : 'push'}`);
        setLastError(null);
        try {
          await pushChanges(userId);
          if (full) {
            await pullChanges(userId);
          }
        } catch (e) {
          console.warn('[sync] queued follow-up failed:', e);
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }
      // Refresh the count while the lock is still held. If a request lands
      // during the refresh, go round again so it is drained before release.
      await notifySyncState(userId);
    } while (!capped && (_pushQueued || _fullSyncQueued));
  } finally {
    _syncInProgress = false;
    setSyncing(false);
  }
}

export async function requestPush(userId: string): Promise<void> {
  if (_syncInProgress) {
    _pushQueued = true;
    console.log('[sync] push queued: a sync is in flight');
    return;
  }
  const run = async () => {
    try {
      _syncInProgress = true;
      setSyncing(true);
      setLastError(null);
      await pushChanges(userId);
    } catch (e) {
      console.warn('[sync] push failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  _inFlight = run();
  await _inFlight;
}

export async function fullSync(userId: string): Promise<void> {
  if (_syncInProgress) {
    // Queue rather than drop: the holder's finishSync runs a push and a pull
    // before it releases the lock, and awaiting it gives callers (syncNow,
    // promptSignOut, the startup sequence) the sync they asked for.
    _fullSyncQueued = true;
    console.warn('[sync] fullSync requested while a sync is in flight; queued');
    await _inFlight;
    return;
  }
  const run = async () => {
    try {
      _syncInProgress = true;
      setSyncing(true);
      setLastError(null);
      await pushChanges(userId);
      await pullChanges(userId);
    } catch (e) {
      console.warn('[sync] full sync failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  _inFlight = run();
  await _inFlight;
}

/**
 * The startup sequence for a signed-in user: open the database, bootstrap if
 * this device has never pulled, then run one full sync. It lives here rather
 * than in useSyncEngine so tests can drive it directly; the hook supplies the
 * cancellation and cache-invalidation callbacks.
 */
export async function startSyncSession(
  userId: string,
  hooks: { onBootstrapped?: () => void; isCancelled?: () => boolean } = {}
): Promise<void> {
  await getDb();
  if (hooks.isCancelled?.()) {
    return;
  }
  if (await needsInitialPull(userId)) {
    // Never throws: initialPull reports through setLastError.
    await initialPull(userId);
  }
  hooks.onBootstrapped?.();
  if (hooks.isCancelled?.()) {
    return;
  }
  await fullSync(userId);
}

export async function needsInitialPull(userId: string): Promise<boolean> {
  const v = await getSyncMeta(`last_pull_at:${userId}`);
  return !v;
}

/**
 * Clears every local table plus the sync cursor. FK-safe order; sync_meta last
 * so a cleared cursor forces a full re-pull. Exported for direct testing.
 */
export async function wipeLocalData(db: any): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(
      `DELETE FROM transaction_splits;
       DELETE FROM transactions;
       DELETE FROM recurring_rules;
       DELETE FROM accounts;
       DELETE FROM sync_meta;`
    );
  });
}

/**
 * Nuclear recovery: discard this device's local cache and re-download from the
 * cloud. The escape hatch for a local store that drifted past what the normal
 * sync can heal (e.g. an OPFS file "Clear site data" won't drop).
 *
 * Correctness hinges on holding the _syncInProgress lock for the WHOLE
 * operation, and on calling the lock-free primitives (pushChanges/pullChanges)
 * rather than fullSync/initialPull. Calling the lock-managing variants would
 * release and re-acquire the lock between steps, letting an AppState/NetInfo
 * triggered fullSync slip into the gap and either (a) race wipeLocalData on the
 * same DB connection or (b) hold the lock when the re-bootstrap runs — making
 * initialPull early-return and leaving the device wiped-but-empty.
 *
 * Order, with each step guarding against data loss:
 *   1. Flush unsynced edits UP, then REFUSE to proceed if anything is still
 *      pending — pushChanges swallows per-row errors, so a silently-failed
 *      upload would otherwise be wiped away.
 *   2. Confirm the cloud is reachable before wiping (an offline reset must not
 *      empty a device it can't refill).
 *   3. Wipe, then re-download with throwOnError so a mid-download failure is
 *      reported as a failed reset rather than a silently half-empty cache. A
 *      failure there leaves the cursor unset, so the next launch re-bootstraps
 *      via initialPull (needsInitialPull turns true).
 */
export async function resetLocalData(userId: string): Promise<void> {
  if (_syncInProgress) {
    throw new Error(
      'A sync is already in progress — please try again in a moment.'
    );
  }
  const run = async () => {
    try {
      _syncInProgress = true;
      setSyncing(true);
      setLastError(null);
      const db = await getDb();

      // 1) Flush unsynced local edits up first so the wipe can't lose them.
      await pushChanges(userId);

      // 1b) pushChanges swallows per-row Supabase errors (leaving rows 'pending'),
      //     so confirm nothing is still unsynced before we wipe. If a push
      //     silently failed (RLS, intermittent write), abort rather than discard
      //     an edit that never reached the cloud.
      const pendingRow: any = await db.getFirstAsync(
        `SELECT
         (SELECT COUNT(*) FROM accounts WHERE _sync_status IN ('pending','deleted')) +
         (SELECT COUNT(*) FROM transactions WHERE _sync_status IN ('pending','deleted')) +
         (SELECT COUNT(*) FROM transaction_splits WHERE _sync_status IN ('pending','deleted')) +
         (SELECT COUNT(*) FROM recurring_rules WHERE _sync_status IN ('pending','deleted')) AS c`
      );
      if (pendingRow && pendingRow.c > 0) {
        throw new Error(
          `Couldn't upload ${pendingRow.c} unsynced change(s) — reset cancelled so they aren't lost. Check your connection and try again.`
        );
      }

      // 2) Confirm the cloud is reachable BEFORE destroying the local copy.
      //    supabase-js returns an error (not a throw) when offline or the
      //    session has expired; a clean read is our go-ahead to wipe.
      const probe = await supabase
        .from('accounts')
        .select('id')
        .eq('user_id', userId)
        .limit(1);
      if (probe.error) {
        throw new Error(
          `Can't reach the cloud — reset cancelled, your local data is unchanged. (${probe.error.message})`
        );
      }

      // 3) Drop the local cache + sync cursor, then fully re-download. throwOnError
      //    turns a failed download into a thrown reset (cursor stays unset → the
      //    next launch re-bootstraps) instead of a silent, partially-empty cache.
      await wipeLocalData(db);
      await pullChanges(userId, { throwOnError: true });
    } catch (e) {
      console.warn('[sync] reset failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      await finishSync(userId);
    }
  };
  const p = run();
  // The reset's rejection is for its caller; queued callers awaiting the lock
  // holder must never see it.
  _inFlight = p.catch(() => {});
  await p;
}

export async function initialPull(userId: string): Promise<void> {
  // Participate in the _syncInProgress lock the same way fullSync does.
  // Without this, requestPush() called from a mutation hook (e.g. an
  // optimistic create that fires while initialPull is still iterating
  // remote rows) runs concurrently with the pull. The pull's
  // upsertRemoteX writes can then race the push's mark-as-synced
  // statement, and the row ends up either with stale remote data or
  // marked synced before the push actually committed remotely.
  if (_syncInProgress) {
    // A bootstrap requested while another sync holds the lock becomes a queued
    // full sync, which the holder drains before it releases the lock. That
    // beats what used to happen here — a silent return that left the bootstrap
    // to whichever trigger came next, if any — but with the cursors unset it is
    // a pullChanges, not an initialPull, and the two differ:
    //
    //   - It swallows a failed read where initialPull throws, and stamps
    //     last_pull_at anyway, so needsInitialPull turns false over a partial
    //     download. That is safe only because, with no cursor, every read
    //     pullChanges swallows is retried by the next sync: accounts and rules
    //     are read whole on every pull, a failed reconcile does not bank its
    //     key, and last_txn_pull_at is held back over a failed transaction page
    //     or a failed split batch (the guard at the end of pullTransactions).
    //     No remote read is keyed on last_pull_at; it only answers
    //     needsInitialPull and feeds the "Last synced" line in Settings.
    //   - It costs more. With no cursor the incremental read has no deleted_at
    //     filter, so every tombstoned transaction comes down too, and the
    //     reconcile enumeration runs in the same pull. For a user with no
    //     remote transactions that enumeration can never bank its key (an
    //     empty read is not authoritative), so it repeats, one empty page per
    //     sync, until the first transaction exists.
    //
    // Waiting for the lock and running the real bootstrap instead would buy
    // only that cost back, and would not protect a fresh device: when
    // initialPull gives up, startSyncSession runs this same pull straight after
    // it. The cursor guard is what makes both paths converge.
    _fullSyncQueued = true;
    console.warn(
      '[sync] initialPull requested while a sync is in flight; queued a full sync'
    );
    await _inFlight;
    return;
  }
  const run = async () => {
    try {
      _syncInProgress = true;
      setSyncing(true);
      setLastError(null);
      const startedMs = Date.now();
      console.log('[sync] initialPull start');
      const db = await getDb();

      // Every remote read below checks `error` and throws on failure. A
      // swallowed error here is catastrophic: initialPull would load a
      // partial (or empty) dataset, then set the cursor meta at the end,
      // marking the local DB "fully pulled as of now" — and nothing ever
      // back-fills the missing rows (incremental pull only fetches
      // updated_at > cursor; reconciliation only deletes). Throwing leaves
      // the cursor unset so needsInitialPull stays true and the next launch
      // retries from scratch.
      //
      // `.is('deleted_at', null)` on all three reads below: a bootstrap starts
      // from an empty local DB, so a tombstone carries no information here — it
      // is a delete instruction for a row this device has never had. Loading one
      // would be strictly worse than skipping it, because the upsert guards drop
      // it anyway and it would only pad the pages we walk.
      const bootstrapStartedAt = new Date().toISOString();

      const { data: accounts, error: acctErr } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null);

      if (acctErr) {
        throw new Error(`initialPull accounts failed: ${acctErr.message}`);
      }
      if (accounts) {
        for (const row of accounts) {
          await upsertRemoteAccount(db, row);
        }
      }

      const { data: rules, error: ruleErr } = await supabase
        .from('recurring_rules')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null);

      if (ruleErr) {
        throw new Error(
          `initialPull recurring_rules failed: ${ruleErr.message}`
        );
      }
      if (rules) {
        for (const row of rules) {
          await upsertRemoteRule(db, row);
        }
      }

      let txnOffset = 0;
      const PAGE = 1000;
      const allTxnIds: string[] = [];
      while (true) {
        const { data: txns, error: txnErr } = await supabase
          .from('transactions')
          .select('*')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .order('id')
          .range(txnOffset, txnOffset + PAGE - 1);

        if (txnErr) {
          throw new Error(
            `initialPull transactions page @${txnOffset} failed: ${txnErr.message}`
          );
        }
        if (!txns || txns.length === 0) {
          break;
        }
        for (const row of txns) {
          await upsertRemoteTransaction(db, row);
          allTxnIds.push(row.id);
        }
        if (txns.length < PAGE) {
          break;
        }
        txnOffset += PAGE;
      }

      if (allTxnIds.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < allTxnIds.length; i += BATCH) {
          const batch = allTxnIds.slice(i, i + BATCH);
          const { data: splits, error: splitErr } = await supabase
            .from('transaction_splits')
            .select('*')
            .in('transaction_id', batch);

          if (splitErr) {
            throw new Error(
              `initialPull splits batch failed: ${splitErr.message}`
            );
          }
          if (splits) {
            for (const row of splits) {
              await upsertRemoteSplit(db, row);
            }
          }
        }
      }

      console.log(
        `[sync] initialPull loaded ${allTxnIds.length} transactions in ${Date.now() - startedMs} ms`
      );

      // Stamp the cursors from the snapshot taken BEFORE the first remote read,
      // never from "now". A bootstrap of a large history takes many round trips,
      // and anything another device commits during them is already in the pages we
      // read or it is not — banking an end-of-pull timestamp declares that whole
      // window pulled, so `gt('updated_at', cursor)` skips it forever. The same
      // reasoning is why pullTransactions advances to pullStartedAt.
      const now = bootstrapStartedAt;
      await setSyncMeta(`last_pull_at:${userId}`, now);
      await setSyncMeta(`last_txn_pull_at:${userId}`, now);
      // A bootstrap just walked every live remote transaction, which is exactly
      // what the periodic reconcile does — so record it as one. Without this the
      // very next pull would repeat that full enumeration for nothing.
      await setSyncMeta(`last_txn_reconcile_at:${userId}`, now);
    } catch (e) {
      console.warn('[sync] initial pull failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  _inFlight = run();
  await _inFlight;
}

/**
 * Reads back the `updated_at` the server actually stored for a row we just
 * pushed.
 *
 * Postgres has a BEFORE UPDATE trigger that overwrites `updated_at` with
 * `now()` on every edit (supabase/migrations/001_initial.sql). Pushing without
 * reading the row back therefore left the local copy holding the client's
 * timestamp while the server held a different one — a guaranteed disagreement
 * on every edit-then-push, not an edge case. The reconcile pass then saw that
 * drift, declared the row stale, and re-fetched it on the next sync. That is
 * what the force-refresh/self-heal machinery was built to tolerate.
 *
 * Returns null when the server didn't report one, in which case callers keep
 * the local value rather than writing a null over it.
 */
function serverUpdatedAt(data: any): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row?.updated_at ?? null;
}

/**
 * Reads back the `deleted_at` the server holds for a row we just pushed.
 *
 * Non-null means another device tombstoned the row while we were editing it:
 * our upsert landed ON the tombstone. PostgREST writes only the keys the
 * payload carries and an edit never carries `deleted_at`, so the tombstone
 * survives our upsert and the row stays dead server-side. The caller must drop
 * the row locally rather than mark it 'synced' — DELETE WINS OVER A CONCURRENT
 * EDIT.
 *
 * That is a deliberate semantic, and it is strictly better than what it
 * replaces: against hard deletes the same race RESURRECTED the row server-side
 * (our upsert re-inserted what the other device had just removed), and every
 * other device then pulled the zombie back down. Losing the in-flight edit is a
 * smaller harm than silently undoing a delete everywhere.
 *
 * Returns null both when the key is absent and when it is an explicit null —
 * PostgREST renders "live" either way depending on the select (see isTombstone).
 */
function serverDeletedAt(data: any): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row?.deleted_at ?? null;
}

/**
 * Ids per tombstone UPDATE. Chunked rather than unbounded because PostgREST
 * encodes `in.(...)` into the query string and intermediaries cap URL length;
 * 200 keeps a single request comfortably well-formed while collapsing a
 * 10k-row account delete from 10k sequential round trips to 50.
 */
const TOMBSTONE_BATCH_SIZE = 200;

/**
 * The newest server migration this build requires, named in the message below.
 * One constant so the instruction cannot drift from the file it names — it went
 * stale silently the moment a second migration became load-bearing.
 */
const REQUIRED_MIGRATION = '006_split_updated_at.sql';

/**
 * Does this PostgREST error mean the server is missing a column this build
 * needs, rather than something transient?
 *
 * It matters because the failure is otherwise completely silent and total. Push
 * swallows per-row errors by design (a row stays 'pending' and is retried), so
 * deploying this client against a database where 005_tombstones.sql has NOT run
 * makes EVERY push fail — the read-back selects deleted_at and the delete path
 * writes it — while the UI reports only "N pending changes", forever, with no
 * hint that the server is the problem. Surfacing it once turns a mystery into an
 * instruction.
 *
 * 006_split_updated_at.sql has the same shape and a worse blast radius: the
 * split upload sends `updated_at` and selects it back, and a failed split
 * upload leaves the PARENT transaction 'pending' too, so one missing column on
 * a child table stops every transaction from syncing.
 */
function isMissingColumnError(error: any): boolean {
  const code = error?.code;
  if (code === '42703' || code === 'PGRST204' || code === 'PGRST202') {
    return true;
  }
  // Deliberately narrow: matching a bare column name anywhere in the message
  // would misreport ordinary failures as a missing migration and send the user
  // to fix a database that is already correct. Only these two columns are ever
  // added by a migration this client needs — and an `updated_at ... does not
  // exist` can only be about transaction_splits, since the other three tables
  // have carried it since 001.
  return /(deleted_at|updated_at)[\s\S]{0,40}does not exist/i.test(
    error?.message ?? ''
  );
}

/**
 * Uploads every local 'pending'/'deleted' row. Lock-free: callers hold the
 * _syncInProgress lock. Exported for direct testing — the post-push state is
 * what matters here, and fullSync's pull would mask it by re-fetching.
 *
 * Deletes are pushed as TOMBSTONES (backlog #18): instead of
 * `.delete().eq('id', id)`, the row gets `.update({ deleted_at })`, which is an
 * ordinary UPDATE and so bumps `updated_at` through the server trigger. That is
 * the entire point — a delete now appears in the cheap `updated_at > cursor`
 * incremental pull, so pulls stop enumerating every remote row on every sync
 * just to notice what another device removed.
 *
 * Two invariants that every tombstoning write below holds:
 *
 *  - `.is('deleted_at', null)` on the update. Without it, a retried push — or a
 *    row the server's `accounts_tombstone_children` trigger already stamped —
 *    gets re-stamped, which re-fires the `updated_at` trigger and re-broadcasts
 *    the same long-dead row to every other device on every sync. With it, the
 *    second write matches nothing and is a genuine no-op.
 *  - Never chain `.single()` on it. Zero matched rows is SUCCESS here (the row
 *    was never pushed, was already purged, or the cascade tombstoned it first)
 *    and must fall through to the local hard delete. `.single()` answers
 *    PGRST116 on zero rows, which reads as failure and would strand the row as
 *    'deleted' locally forever, retried on every single sync.
 *
 * Push order stays accounts → rules → transactions, and the client keeps
 * pushing child tombstones itself instead of relying on the server cascade
 * trigger. Both orders must end correct — the trigger may have run first, or
 * may not exist on an older database — and the `.is('deleted_at', null)` no-op
 * is exactly what makes the client's own write harmless when it did.
 */
export async function pushChanges(userId: string): Promise<void> {
  const db = await getDb();
  // Collected rather than thrown: a per-row failure must not abort the rest of
  // the push. Reported once at the end — see isMissingColumnError.
  let missingColumn: any = null;
  const note = (error: any) => {
    if (!missingColumn && isMissingColumnError(error)) {
      missingColumn = error;
    }
  };

  await pushTable(
    db,
    'accounts',
    userId,
    (row) => ({
      ...row,
      is_archived: !!row.is_archived,
      exclude_from_total: !!row.exclude_from_total,
    }),
    note
  );

  // NOTE: there is deliberately no separate deleted-rules loop further down in
  // this function. There used to be one and it was dead code — this pushTable
  // call has already tombstoned and hard-deleted every 'deleted' rule by the
  // time it returns, so that later SELECT could never return a row.
  await pushTable(
    db,
    'recurring_rules',
    userId,
    (row) => ({
      ...row,
      template:
        typeof row.template === 'string'
          ? JSON.parse(row.template)
          : row.template,
    }),
    note
  );

  const pendingTxns = await db.getAllAsync<any>(
    `SELECT * FROM transactions WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pendingTxns) {
    const { _sync_status, ...data } = row;
    const { data: saved, error } = await supabase
      .from('transactions')
      .upsert(data, { onConflict: 'id' })
      .select('id, updated_at, deleted_at')
      .single();
    if (error) {
      console.warn(
        `[sync] push transactions ${row.id} rejected:`,
        error.code,
        error.message
      );
      note(error);
      continue;
    }

    // Our edit landed on a row another device tombstoned (see serverDeletedAt).
    // Delete wins: drop the row locally instead of marking it 'synced', and
    // skip the split upload below, which would otherwise re-populate splits for
    // a parent that is dead server-side.
    //
    // The local delete carries the SAME guard as mark-synced further down (id +
    // the updated_at we read + still 'pending'), so a newer local edit that
    // landed during the round trip is not destroyed on the strength of a read
    // that predates it: it stays pending and meets the tombstone again on the
    // next push.
    if (serverDeletedAt(saved) != null) {
      const res = await db.runAsync(
        `DELETE FROM transactions
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
      );
      // Splits go only when the parent actually went. Dropping them
      // unconditionally would strip the splits off the very mid-flight edit the
      // guard above just refused to touch.
      if (res?.changes) {
        await db.runAsync(
          'DELETE FROM transaction_splits WHERE transaction_id = ?',
          [row.id]
        );
      }
      continue;
    }

    const savedAt = serverUpdatedAt(saved);

    let splitsSynced = true;
    // The splits as they were when we uploaded them, and the timestamp the
    // server rendered back for each. Both are needed below: the first supplies
    // the guard's "the value we read", the second the value to adopt.
    let uploadedSplits: any[] = [];
    let savedSplitAt = new Map<string, string | null>();
    const { error: delSplitErr } = await supabase
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', row.id);
    if (delSplitErr) {
      note(delSplitErr);
      splitsSynced = false;
    } else {
      const localSplits = await db.getAllAsync<any>(
        'SELECT * FROM transaction_splits WHERE transaction_id = ?',
        [row.id]
      );
      if (localSplits.length > 0) {
        // OMIT updated_at rather than sending null when a local row has none
        // (a split the migration-2 backfill could not reach, or one pulled from
        // a pre-006 server). The server column is `not null default now()`: an
        // absent key takes the default — the same shape an older client sends —
        // while an explicit null is rejected outright, which would strand the
        // parent 'pending' forever.
        //
        // The decision is made ONCE for the whole batch, not per row. For an
        // array, postgrest-js sends `?columns=` set to the union of the rows'
        // keys, and PostgREST fills a listed key that a row omits with NULL
        // (it does not reject mismatched keys when `columns` is given). So a
        // per-row omission beside a stamped sibling still arrives as an
        // explicit null, the insert fails with 23502, and that is not a
        // missing column, so it would stall the parent with no message at all.
        // Omitting the column for every row when ANY row lacks it costs only
        // that the server restamps siblings that did have a value — and the
        // read-back adopts the new stamp, so all of them heal in one push.
        const anySplitUnstamped = localSplits.some(
          (s: any) => s.updated_at == null
        );
        const splitData = localSplits.map(
          ({ _sync_status: _s, updated_at, ...s }: any) =>
            anySplitUnstamped ? s : { ...s, updated_at }
        );
        const { data: savedSplits, error: insSplitErr } = await supabase
          .from('transaction_splits')
          .insert(splitData)
          .select('id, updated_at');
        if (insSplitErr) {
          note(insSplitErr);
          splitsSynced = false;
        } else {
          uploadedSplits = localSplits;
          savedSplitAt = new Map(
            (savedSplits ?? []).map((s: any) => [s.id, s.updated_at ?? null])
          );
        }
      }
    }

    if (splitsSynced) {
      // See pushTable comment: guard the transaction's status update on
      // updated_at AND the still-pending status, so a newer local edit
      // that landed during the in-flight upsert doesn't get clobbered.
      // Adopt the server's timestamp as part of the same guarded write, so
      // the local row agrees with the server the moment it becomes 'synced'.
      // The guard still compares against the value we READ, so a local edit
      // that landed mid-flight is left pending for the next push.
      await db.runAsync(
        `UPDATE transactions
         SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [savedAt, row.id, row.updated_at]
      );
      // Splits carry the SAME guard as their parent (#20): per id, on the
      // updated_at we uploaded, and still 'pending'. This used to be a blanket
      // `WHERE transaction_id = ?`, which could not tell whether the rows it
      // was marking were the ones it had just sent — so a split edit landing
      // during the round trip had its 'pending' overwritten by the reply to the
      // previous upload and was never replayed.
      //
      // An edit replaces splits (delete + reinsert under fresh ids), so the
      // rows we uploaded simply no longer exist and every statement here
      // matches nothing; the replacements stay 'pending' for the next push,
      // which is the correct outcome. `IS` rather than `=` because a local
      // updated_at may legitimately be NULL and SQLite's `=` is not NULL-safe
      // (`NULL = NULL` is NULL, so the guard would silently never match).
      for (const s of uploadedSplits) {
        await db.runAsync(
          `UPDATE transaction_splits
           SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
           WHERE id = ? AND updated_at IS ? AND _sync_status = 'pending'`,
          [savedSplitAt.get(s.id) ?? null, s.id, s.updated_at ?? null]
        );
      }
    }
  }

  const deletedTxns = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  // One UPDATE per batch, not per row. This loop was a round trip per id, which
  // was survivable only because deleting an account took its children with it
  // through the FK cascade and left nothing here to push. A tombstone does not
  // cascade at the FK level, so deleting a busy account now queues a real write
  // per child transaction — thousands of sequential requests at one id each.
  const deletedAt = new Date().toISOString();
  for (let i = 0; i < deletedTxns.length; i += TOMBSTONE_BATCH_SIZE) {
    const batch = deletedTxns
      .slice(i, i + TOMBSTONE_BATCH_SIZE)
      .map((r) => r.id);

    // Parent FIRST, splits second. The old order (splits, then parent) left a
    // live parent stripped of its splits whenever the parent write failed, and
    // nothing ever refetched it to repair the damage because the parent's
    // updated_at never moved. Tombstoning first makes the worst case a dead
    // parent whose splits linger until the purge cascades them out — invisible
    // rather than corrupt.
    const { error } = await supabase
      .from('transactions')
      .update({ deleted_at: deletedAt })
      .in('id', batch)
      .is('deleted_at', null);
    if (error) {
      console.warn(
        `[sync] tombstone transactions batch of ${batch.length} rejected:`,
        error.code,
        error.message
      );
      note(error);
      continue;
    }
    // Best effort. Splits carry no tombstone of their own (no user_id, and no
    // deleted_at — they ride their parent) so they stay hard-deleted, and a
    // failure here is not fatal: the parent already reads as deleted on every
    // other device, and purge_tombstones() takes the orphans out via the FK.
    await supabase
      .from('transaction_splits')
      .delete()
      .in('transaction_id', batch);

    const ph = batch.map(() => '?').join(',');
    // `AND _sync_status = 'deleted'` so a row somehow re-dirtied while this
    // push was in flight keeps its unsent edit instead of being dropped.
    await db.runAsync(
      `DELETE FROM transactions WHERE id IN (${ph}) AND _sync_status = 'deleted'`,
      batch
    );
    // Orphans only, for the same reason as the pending path above: a parent the
    // guard just spared still needs its splits.
    //
    // The inner SELECT repeats the id list rather than reading the whole table:
    // SQLite materialises a bare `NOT IN (SELECT id FROM transactions)` into an
    // ephemeral index over EVERY row, once per batch, so emptying a large
    // account would scan the register tens of times over. Bounded this way both
    // halves ride the primary key.
    await db.runAsync(
      `DELETE FROM transaction_splits
       WHERE transaction_id IN (${ph})
         AND transaction_id NOT IN (SELECT id FROM transactions WHERE id IN (${ph}))`,
      [...batch, ...batch]
    );
  }

  if (missingColumn) {
    // Deliberately the LAST thing the push does, so a real transient error that
    // requestPush/fullSync catches and reports still wins. Nothing here throws:
    // the rows stay 'pending' and retry, exactly as they would for any other
    // failure — the only change is that the user is told why they never drain.
    setLastError(
      'This app needs a database update that has not been applied yet: run ' +
        `supabase/migrations/${REQUIRED_MIGRATION}, and any earlier migration ` +
        'your database is still missing, through the migration workflow. ' +
        'Your changes are saved on this device and will sync once it is applied.'
    );
  }
}

async function pushTable(
  db: any,
  table: string,
  userId: string,
  transform: (row: any) => any,
  onError?: (error: any) => void
): Promise<void> {
  const pending = await db.getAllAsync(
    `SELECT * FROM ${table} WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pending) {
    const { _sync_status, ...raw } = row;
    const data = transform(raw);
    const { data: saved, error } = await supabase
      .from(table)
      .upsert(data, { onConflict: 'id' })
      .select('id, updated_at, deleted_at')
      .single();
    if (error) {
      console.warn(
        `[sync] push ${table} ${row.id} rejected:`,
        error.code,
        error.message
      );
      onError?.(error);
      continue;
    }

    // Edit landed on another device's tombstone: delete wins (serverDeletedAt).
    // Guarded identically to mark-synced below, so a newer mid-flight local
    // edit stays 'pending' and meets the tombstone again next push rather than
    // being thrown away here.
    if (serverDeletedAt(saved) != null) {
      await db.runAsync(
        `DELETE FROM ${table}
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
      );
      continue;
    }

    // Only mark synced if updated_at still matches what we read AND the
    // row is still 'pending'. If a newer local edit lands while the
    // network upsert above is in flight, that edit bumps updated_at and
    // re-marks the row 'pending' — and we must NOT clobber it back to
    // 'synced', or the next push won't see it and a later pull can
    // overwrite the unsynced edit.
    // See serverUpdatedAt: adopt the server's timestamp here so the row
    // doesn't become 'synced' while still disagreeing with the server.
    await db.runAsync(
      `UPDATE ${table}
       SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
       WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
      [serverUpdatedAt(saved), row.id, row.updated_at]
    );
  }

  const deleted = await db.getAllAsync(
    `SELECT id FROM ${table} WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  const deletedAt = new Date().toISOString();
  for (const row of deleted) {
    // Both invariants from pushChanges' header apply here: `.is('deleted_at',
    // null)` stops a re-pushed or already-cascaded tombstone from re-stamping
    // updated_at and re-broadcasting a dead row, and there is deliberately no
    // `.single()` — zero matched rows is success and must reach the local
    // delete below.
    const { error } = await supabase
      .from(table)
      .update({ deleted_at: deletedAt })
      .eq('id', row.id)
      .is('deleted_at', null);
    if (error) {
      console.warn(
        `[sync] tombstone ${table} ${row.id} rejected:`,
        error.code,
        error.message
      );
      onError?.(error);
    } else {
      // `AND _sync_status = 'deleted'` so a row re-dirtied mid-push keeps its
      // unsent edit instead of being dropped.
      await db.runAsync(
        `DELETE FROM ${table} WHERE id = ? AND _sync_status = 'deleted'`,
        [row.id]
      );
    }
  }
}

/**
 * Downloads everything that changed remotely since the cursors. Lock-free:
 * callers hold the _syncInProgress lock. Exported for direct testing — what
 * matters here is the post-pull local state and which remote reads were issued
 * at all, and going through fullSync would hide both behind a push.
 */
export async function pullChanges(
  userId: string,
  opts: { throwOnError?: boolean } = {}
): Promise<void> {
  const db = await getDb();

  await pullTableFull(
    db,
    'accounts',
    userId,
    upsertRemoteAccount,
    forceUpsertRemoteAccount,
    deleteLocalAccountIfSynced,
    opts
  );
  await pullTableFull(
    db,
    'recurring_rules',
    userId,
    upsertRemoteRule,
    forceUpsertRemoteRule,
    deleteLocalRuleIfSynced,
    opts
  );
  await pullTransactions(db, userId, opts);

  await setSyncMeta(`last_pull_at:${userId}`, new Date().toISOString());
}

async function pullTableFull(
  db: any,
  table: string,
  userId: string,
  upsertFn: (db: any, row: any) => Promise<void>,
  forceFn: (db: any, row: any) => Promise<void>,
  deleteFn: (db: any, id: string) => Promise<unknown>,
  opts: { throwOnError?: boolean } = {}
): Promise<void> {
  // Capture this BEFORE the remote select so the deletion reconciliation
  // below only considers rows that already existed locally at the start
  // of the pull. Otherwise: a row created locally + pushed AFTER our
  // remote snapshot becomes synced but isn't in `remoteIds`, so the
  // reconciliation step deletes it as if it had been remotely deleted.
  const pullStartedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId);

  if (error) {
    if (opts.throwOnError) {
      throw new Error(`Failed to download ${table}: ${error.message ?? error}`);
    }
    console.warn(`[sync] pull ${table} failed:`, error.code, error.message);
    return;
  }
  if (!data) {
    console.warn(`[sync] pull ${table} returned no data`);
    return;
  }

  // A tombstone is a delete, not data. Partitioning here (rather than at each
  // use) keeps the two halves from drifting apart: a tombstoned row must be
  // kept out of the upsert loop (feeding one to upsertFn re-INSERTs the row the
  // user just deleted) AND out of `remoteIds`, because counting it as present
  // is exactly what would stop the delete loop below from removing the local
  // copy. Accounts and rules stay full-table reads — both are tiny, and an
  // incremental read keyed off last_pull_at would skip mid-pull changes, since
  // that cursor is set to "now" after the pull finishes.
  const live = data.filter((r: any) => !isTombstone(r));

  const remoteIds = new Set(live.map((r: any) => r.id));

  // Synced local rows that existed at pull start, with timestamps — drives both
  // deletion reconciliation and drift detection. 'pending'/'deleted' rows are
  // excluded so unsynced edits are never force-overwritten or deleted.
  const locals = await db.getAllAsync(
    `SELECT id, updated_at FROM ${table}
     WHERE user_id = ?
       AND _sync_status = 'synced'
       AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))`,
    [userId, pullStartedAt]
  );
  const localUpdatedById = new Map<string, string | null>(
    locals.map((l: any) => [l.id, l.updated_at])
  );

  for (const row of live) {
    if (
      localUpdatedById.has(row.id) &&
      localUpdatedById.get(row.id) !== row.updated_at
    ) {
      // Synced locally but drifted from the server in EITHER direction —
      // including a correction whose updated_at is OLDER than ours, which the
      // guarded upsert refuses forever. Same self-heal as transactions (see
      // planTransactionReconcile / forceUpsertRemoteTransaction).
      await forceFn(db, row);
    } else {
      await upsertFn(db, row);
    }
  }

  // #19: a clean-but-EMPTY read is not authority to delete. An expired session
  // that degraded to anon, a mis-scoped RLS policy, or a server-side filter bug
  // all return `{ data: [], error: null }` — indistinguishable here from "the
  // user deleted every account" — and the loop below would then wipe the local
  // copy of every synced row in this table. Refusing costs a user who genuinely
  // emptied the table one "Reset & re-download"; honouring it costs everyone
  // else their data.
  //
  // The test is on raw `data`, not on `live`: a read that returns only
  // tombstones IS authoritative (the server answered, and its answer is "all
  // deleted"), so those rows must still fall through to the delete loop.
  if (data.length === 0 && localUpdatedById.size > 0) {
    console.warn(
      `[sync] ${table} deletion reconcile skipped: the server returned no rows ` +
        `while ${localUpdatedById.size} synced row(s) exist locally; refusing to ` +
        'treat an empty read as authoritative'
    );
    return;
  }

  // Tombstoned rows arrive here by absence: they were filtered out of
  // `remoteIds` above, so this loop consumes them. It is already scoped to
  // synced rows that predate the pull (that is all localUpdatedById holds), so
  // a pending local edit or a queued local delete is never collateral.
  for (const [id] of localUpdatedById) {
    if (!remoteIds.has(id)) {
      // Re-check _sync_status in the DELETE itself rather than trusting the
      // localUpdatedById snapshot taken above. The snapshot is read before the
      // remote rows are upserted, and a mutation hook can mark a row 'pending'
      // during those awaits (the hooks write straight to SQLite and are not
      // gated by _syncInProgress). Deleting on the strength of the stale
      // snapshot would drop that edit AND the push that would have saved it.
      // Tombstones make this the ordinary path for every account/rule delete,
      // not the rare purge case it used to be.
      await deleteFn(db, id);
    }
  }
}

export interface ReconcileRemoteRow {
  id: string;
  updated_at: string | null;
}

export interface ReconcileLocalRow {
  id: string;
  updated_at: string | null;
  _sync_status: string;
  // synced AND not newer than the pull's start snapshot — i.e. safe to delete
  // if absent remotely (won't drop a row created/pushed mid-pull).
  reconcilable: boolean;
}

export interface ReconcilePlan {
  toRefresh: string[];
  toDelete: string[];
}

/**
 * Pure decision for the transaction reconcile pass.
 *
 * The server is authoritative for 'synced' rows, so a synced local row whose
 * updated_at differs from the server's — in EITHER direction — is stale and
 * must be re-fetched. This is what makes the client self-heal: the incremental
 * pull only sees `updated_at > cursor`, so a server row corrected with an OLDER
 * timestamp than the device's cursor is invisible to it forever; comparing
 * against the LOCAL timestamp (not the cursor) catches it. Rows the server no
 * longer has are deleted; rows missing locally are fetched. Local rows with
 * unsynced edits ('pending'/'deleted') are never touched — push resolves those.
 */
export function planTransactionReconcile(
  remote: ReconcileRemoteRow[],
  local: ReconcileLocalRow[],
  /**
   * Did the enumeration actually come back with rows — counting tombstones,
   * which `remote` deliberately excludes? Defaults to `remote.length > 0`, which
   * is the honest answer whenever the caller has no separate signal.
   */
  remoteReadReturnedRows: boolean = remote.length > 0
): ReconcilePlan {
  // #19: an empty enumeration is never authoritative. Reaching here with no
  // rows back means either "the user deleted everything" or "the read silently
  // returned nothing" (expired session, mis-scoped RLS, filter bug). Deleting on
  // that guess wipes the device; refusing costs a genuinely-emptied account one
  // "Reset & re-download". Returning early rather than only suppressing toDelete
  // also skips the pointless refresh pass over an empty list.
  //
  // A caller that CAN tell the two apart — pullTransactions enumerates
  // tombstones rather than filtering them away, so "every row is deleted" comes
  // back as rows — says so via remoteReadReturnedRows, and then an all-deleted
  // answer is honoured instead of being refused forever.
  if (!remoteReadReturnedRows) {
    return { toRefresh: [], toDelete: [] };
  }

  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const localById = new Map(local.map((l) => [l.id, l]));

  const toDelete: string[] = [];
  for (const l of local) {
    if (l.reconcilable && !remoteById.has(l.id)) {
      toDelete.push(l.id);
    }
  }

  const toRefresh: string[] = [];
  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) {
      // Server has a row we've never stored locally — pull it.
      toRefresh.push(r.id);
    } else if (l._sync_status === 'synced' && l.updated_at !== r.updated_at) {
      // Synced locally but drifted from the server (incl. older-timestamp fixes).
      toRefresh.push(r.id);
    }
    // 'pending'/'deleted' local rows: leave for push to resolve.
  }

  return { toRefresh, toDelete };
}

async function pullTransactions(
  db: any,
  userId: string,
  opts: { throwOnError?: boolean } = {}
): Promise<void> {
  // See pullTableFull for the pullStartedAt rationale. Captured before any
  // remote read so the reconciliation pass below ignores transactions
  // created locally + pushed mid-pull.
  const pullStartedAt = new Date().toISOString();
  const lastPull = await getSyncMeta(`last_txn_pull_at:${userId}`);
  const PAGE = 1000;

  // 1) Incremental fast-path: full rows changed since the cursor. A fresh query
  //    builder per page — supabase-js builders are single-use, and reusing one
  //    across .range() calls silently refetches page 0.
  //
  //    This page deliberately does NOT filter `deleted_at`: a tombstone is the
  //    delete, and seeing it here is the whole point of #18 — it rides the same
  //    `updated_at > cursor` read every other change does, so deletes stop
  //    needing a full enumeration to be noticed.
  let offset = 0;
  // Set when a page read fails. The cursor must not be banked on a pull that
  // silently skipped a window of changes — see the guard at the end.
  let incrementalError = false;
  const pulledTxnIds: string[] = [];
  while (true) {
    let q = supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('id');
    if (lastPull) {
      q = q.gt('updated_at', lastPull);
    }
    const { data, error } = await q.range(offset, offset + PAGE - 1);
    if (error && opts.throwOnError) {
      throw new Error(
        `Failed to download transactions: ${error.message ?? error}`
      );
    }
    if (error) {
      console.warn(
        '[sync] pull transactions (incremental) failed:',
        error.code,
        error.message
      );
      incrementalError = true;
      break;
    }
    if (!data || data.length === 0) {
      break;
    }
    for (const row of data) {
      if (isTombstone(row)) {
        // Scoped to synced rows inside the helper: a 'pending' local edit or a
        // queued local 'deleted' row is unsynced work that only push may
        // resolve (its upsert lands on the already-tombstoned server row, so
        // delete still wins — but the queue entry survives until then).
        //
        // Unlike the reconcile below, this needs no pullStartedAt guard: a
        // tombstone is an explicit assertion about ONE id that the server has
        // already committed, not an inference drawn from a row's absence from a
        // snapshot, so a row created and pushed mid-pull cannot be caught by it.
        //
        // The id must not join pulledTxnIds: that list drives step 3's split
        // refresh, and the row (with its splits) is gone — re-fetching splits
        // for it would query a parent that no longer exists locally.
        await deleteLocalTransactionIfSynced(db, row.id);
        continue;
      }
      await upsertRemoteTransaction(db, row);
      pulledTxnIds.push(row.id);
    }
    if (data.length < PAGE) {
      break;
    }
    offset += PAGE;
  }

  // 2) Reconcile pass: enumerate ALL remote (id, updated_at) to delete rows the
  //    server dropped and heal rows that drifted but weren't caught above.
  //
  //    This is now PERIODIC rather than per-sync. It is O(total history) every
  //    time it runs, and running it on every sync was the single largest
  //    scaling problem in the pull path (#18). Tombstones made it redundant for
  //    ordinary deletes, which step 1 now sees incrementally; what is left is
  //    the narrow set of cases no incremental read can reach — a row that
  //    disappeared with no tombstone to broadcast (purge_tombstones ran while
  //    this device was offline, or an old client hard-deleted it), and a
  //    correction stamped with an updated_at OLDER than our cursor. Those are
  //    rare and self-healing on a one-day horizon, so pay for them once a day.
  const reconcileKey = `last_txn_reconcile_at:${userId}`;
  const lastReconcile = await getSyncMeta(reconcileKey);
  const reconcileAge =
    Date.parse(pullStartedAt) - Date.parse(lastReconcile ?? '');
  // Fail towards running it. A missing key (fresh install, or wipeLocalData
  // cleared sync_meta), an unparseable one, or one stamped in the FUTURE
  // (the device's clock moved backwards) all mean "due now" — treating any of
  // them as "reconciled recently" would disable the safety net for as long as
  // the bad value survives, which for a future timestamp could be years.
  const dueForReconcile =
    !Number.isFinite(reconcileAge) ||
    reconcileAge < 0 ||
    reconcileAge >= RECONCILE_INTERVAL_MS;

  let toRefresh: string[] = [];
  let refreshFailed = false;
  if (dueForReconcile) {
    const remote: ReconcileRemoteRow[] = [];
    let reconError = false;
    let sawAnyRemoteRow = false;
    let reconOffset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, updated_at, deleted_at')
        .eq('user_id', userId)
        .order('id')
        .range(reconOffset, reconOffset + PAGE - 1);
      if (error) {
        // Never reconcile against a failed enumeration — an empty/partial result
        // would delete real local rows. Bail; the incremental upserts still stand.
        reconError = true;
        break;
      }
      if (!data || data.length === 0) {
        break;
      }
      // `sawAnyRemoteRow` counts RAW rows, tombstones included, while `remote`
      // holds only the live ones. Keeping them apart is what lets the #19 guard
      // below mean "the read told us nothing" rather than "the answer was
      // nothing". Filtering tombstones out server-side would collapse the two:
      // a user who legitimately deleted every transaction would look identical
      // to a mis-scoped RLS policy, and the guard would then refuse that honest
      // answer forever, stranding the local copies.
      sawAnyRemoteRow = true;
      for (const r of data) {
        if (isTombstone(r)) {
          // Absent, so the planner deletes the local copy. That is how a device
          // whose cursor is too old to have seen the incremental UPDATE still
          // converges.
          continue;
        }
        remote.push({ id: r.id, updated_at: r.updated_at });
      }
      if (data.length < PAGE) {
        break;
      }
      reconOffset += PAGE;
    }

    if (reconError) {
      // A transient remote read must never be interpreted as "the server is
      // empty"; skip the whole reconcile (no deletes, no refreshes) this round.
      console.warn(
        '[sync] transaction reconcile skipped: remote enumeration failed; ' +
          'leaving local rows intact to avoid spurious deletion'
      );
    } else {
      const localRows = await db.getAllAsync(
        `SELECT id, updated_at, _sync_status,
         CASE WHEN _sync_status = 'synced'
                   AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))
              THEN 1 ELSE 0 END AS reconcilable
       FROM transactions WHERE user_id = ?`,
        [pullStartedAt, userId]
      );
      const local: ReconcileLocalRow[] = localRows.map((r: any) => ({
        id: r.id,
        updated_at: r.updated_at,
        _sync_status: r._sync_status,
        reconcilable: !!r.reconcilable,
      }));

      if (!sawAnyRemoteRow && local.some((l) => l.reconcilable)) {
        // planTransactionReconcile refuses to delete on an empty remote (#19);
        // say so out loud, because from here it is indistinguishable from a
        // mis-scoped RLS policy and the user would otherwise see nothing.
        console.warn(
          '[sync] transaction deletion reconcile skipped: the server returned ' +
            'no rows while synced rows exist locally; refusing to treat an ' +
            'empty enumeration as authoritative'
        );
      }

      const plan = planTransactionReconcile(remote, local, sawAnyRemoteRow);
      toRefresh = plan.toRefresh;

      for (const id of plan.toDelete) {
        // Scoped for the same reason as the pullTableFull loop: `reconcilable`
        // was computed from a snapshot taken before the refresh awaits, so a
        // local edit landing mid-pull must still be spared here.
        await deleteLocalTransactionIfSynced(db, id);
      }

      const REFRESH_BATCH = 200;
      for (let i = 0; i < toRefresh.length; i += REFRESH_BATCH) {
        const batch = toRefresh.slice(i, i + REFRESH_BATCH);
        const { data, error } = await supabase
          .from('transactions')
          .select('*')
          .in('id', batch)
          // A row tombstoned in the window between the enumeration and this
          // re-read must not come back as data. forceUpsertRemoteTransaction
          // would refuse it anyway, but filtering server-side keeps a delete
          // from arriving dressed as a refresh.
          .is('deleted_at', null);
        if (error || !data) {
          // The pass identified these rows as stale and then failed to fetch
          // them, so it did NOT complete — see the banking guard below.
          console.warn(
            '[sync] pull transactions (refresh batch) failed:',
            error?.code,
            error?.message ?? 'no data returned'
          );
          refreshFailed = true;
          continue;
        }
        for (const row of data) {
          await forceUpsertRemoteTransaction(db, row);
        }
      }
    }

    // Only a pass that actually COMPLETED may bank the interval. Advancing the
    // key after a failed enumeration, or after the #19 empty-read guard
    // suppressed the deletes, would record a reconcile that never happened and
    // hide a mis-scoped RLS policy for a full day. Leaving it unset makes the
    // next sync retry, at a cost of one empty page.
    if (!reconError && !refreshFailed && sawAnyRemoteRow) {
      await setSyncMeta(reconcileKey, pullStartedAt);
    }
  }

  // 3) Refresh splits for every transaction we pulled or healed, EXCEPT those
  //    whose local parent is unsynced. Fetch BEFORE deleting the local copies —
  //    deleting first and then failing the fetch would drop synced splits with
  //    nothing to reinsert (and the parent isn't "touched" again until it next
  //    drifts, so they'd stay missing).
  //
  //    The `_sync_status = 'synced'` filter on the PARENT is the same guard
  //    every other pull path uses, and here it prevents a duplicate rather than
  //    a lost edit. `pulledTxnIds` collects every id the incremental pass read,
  //    including ones whose upsertRemoteTransaction was a guarded no-op because
  //    the local row is 'pending' — and our own push bumps the parent's server
  //    updated_at, so a transaction we just pushed is in that list on the very
  //    next pull. Without this filter the refresh then reinserts the server's
  //    splits alongside the local pending ones (the delete below spares those,
  //    and the server's rows carry ids that no longer exist locally, so they
  //    insert cleanly) — and the next push uploads BOTH, since it sends every
  //    local split for the parent regardless of status. The split edit is no
  //    longer lost; it is permanently duplicated instead, which is worse.
  //
  //    Nothing is given up by skipping them: a pending parent's splits are
  //    replaced wholesale on the next push (delete every remote split, reinsert
  //    every local one), so a server-side split correction for such a parent is
  //    discarded either way. Pulling it first only widens the window in which
  //    the local store holds a mix of both.
  const touched = Array.from(new Set([...pulledTxnIds, ...toRefresh]));
  const SPLIT_BATCH = 200;
  // Set when a split batch cannot be read. Holds the transaction cursor back,
  // just as a failed page read does — see the guard at the end.
  let splitRefreshFailed = false;
  for (let i = 0; i < touched.length; i += SPLIT_BATCH) {
    const candidates = touched.slice(i, i + SPLIT_BATCH);
    // Filtered per batch so the IN list stays bounded and rides the primary key.
    const ph = candidates.map(() => '?').join(',');
    const syncedParents: { id: string }[] = await db.getAllAsync(
      `SELECT id FROM transactions WHERE id IN (${ph}) AND _sync_status = 'synced'`,
      candidates
    );
    const batch = syncedParents.map((r) => r.id);
    if (batch.length === 0) continue;
    const { data: splits, error } = await supabase
      .from('transaction_splits')
      .select('*')
      .in('transaction_id', batch);
    if (error || !splits) {
      if (opts.throwOnError) {
        throw new Error(
          `Failed to download splits: ${error?.message ?? 'no data returned'}`
        );
      }
      console.warn(
        '[sync] pull transaction_splits failed:',
        error?.code,
        error?.message ?? 'no data returned'
      );
      splitRefreshFailed = true;
      continue; // leave existing local splits intact rather than lose them
    }
    for (const txnId of batch) {
      await db.runAsync(
        "DELETE FROM transaction_splits WHERE transaction_id = ? AND _sync_status = 'synced'",
        [txnId]
      );
    }
    for (const row of splits) {
      await upsertRemoteSplit(db, row);
    }
  }

  // Advance the cursor to the pull-start snapshot (not "now"): anything the
  // server changed during this pull is re-examined next time rather than skipped.
  //
  // Never advance it when a page read failed. Banking the cursor over a window
  // this pull never actually read means `gt('updated_at', cursor)` can never
  // return those rows again: an edit made elsewhere stays invisible and, worse,
  // a later local edit pushes over it and destroys it. This used to be harmless
  // only because the full reconcile ran on EVERY pull and back-filled the gap in
  // the same pass; now that the reconcile is periodic (#18) the compensation can
  // be up to a day away, so the advance has to be earned. Re-reading the window
  // next sync is idempotent: upserts are guarded and tombstone deletes are
  // scoped to 'synced'.
  //
  // A failed split batch holds it back too, and for splits nothing else repairs
  // the damage. The synced parents in that batch were upserted above, so their
  // local updated_at already matches the server: once the cursor passes them no
  // incremental read returns them, and the reconcile finds nothing to refresh.
  // Their splits stay missing or stale until the parent is next edited — and
  // when this pull is a device's first download (a bootstrap that found the
  // lock held, or the fullSync startSyncSession runs after initialPull gave up)
  // that can be every split the user has. Held back, the next sync re-reads
  // those parents and fetches their splits again; while split reads keep
  // failing, every sync re-reads the whole window. It cannot help a parent that
  // only the reconcile refreshed: that row is no newer than the cursor, so no
  // incremental read returns it whether the cursor moves or not.
  if (!incrementalError && !splitRefreshFailed) {
    await setSyncMeta(`last_txn_pull_at:${userId}`, pullStartedAt);
  }
}

export async function upsertRemoteAccount(db: any, row: any): Promise<void> {
  // A tombstone is a delete, not data: refuse it here rather than writing it.
  // The deleting device receives its OWN tombstone straight back as a realtime
  // UPDATE, and the ON CONFLICT statement below leaves its INSERT branch
  // unguarded — so without this early return that echo re-INSERTs the row the
  // user just deleted, and it stays resurrected on screen until the next pull
  // notices. Consuming a tombstone is deleteLocal*IfSynced's job
  // (lib/tombstones.ts); an upsert only ever applies live rows.
  if (isTombstone(row)) return;

  // Guard: only overwrite local rows that are 'synced' AND whose remote
  // copy is at least as fresh. The 'synced' check alone is insufficient: a
  // pull that started before a local write completes can capture stale
  // remote data, and by the time its iteration reaches a row, that row may
  // have been pushed and re-marked 'synced' — passing the status guard but
  // overwriting the just-pushed values with the older snapshot.
  //
  // NULL handling is asymmetric on purpose: if the local row lacks an
  // updated_at we accept the remote (we have no basis to reject), but a
  // remote row with NULL updated_at is NEVER allowed to overwrite a dated
  // local row — that direction is almost certainly stale or malformed.
  // julianday() handles ISO-8601 strings consistently; raw string compare
  // would silently drift if the local and remote timestamp formats ever
  // diverge.
  await db.runAsync(
    `INSERT INTO accounts
       (id, user_id, name, type, icon, initial_balance, exclude_from_total,
        sort_order, is_archived, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, icon = excluded.icon,
       initial_balance = excluded.initial_balance,
       exclude_from_total = excluded.exclude_from_total,
       sort_order = excluded.sort_order, is_archived = excluded.is_archived,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE accounts._sync_status = 'synced'
       AND (
         accounts.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(accounts.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.name,
      row.type,
      row.icon ?? null,
      row.initial_balance,
      row.exclude_from_total ? 1 : 0,
      row.sort_order,
      row.is_archived ? 1 : 0,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative account refresh for the reconcile pass — overwrites a 'synced'
 * local row regardless of updated_at ordering (heals an older-timestamp server
 * correction the guarded upsert would skip forever). Never touches
 * 'pending'/'deleted' rows. See forceUpsertRemoteTransaction for the rationale.
 */
export async function forceUpsertRemoteAccount(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  await db.runAsync(
    `INSERT INTO accounts
       (id, user_id, name, type, icon, initial_balance, exclude_from_total,
        sort_order, is_archived, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, icon = excluded.icon,
       initial_balance = excluded.initial_balance,
       exclude_from_total = excluded.exclude_from_total,
       sort_order = excluded.sort_order, is_archived = excluded.is_archived,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE accounts._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.name,
      row.type,
      row.icon ?? null,
      row.initial_balance,
      row.exclude_from_total ? 1 : 0,
      row.sort_order,
      row.is_archived ? 1 : 0,
      row.created_at,
      row.updated_at,
    ]
  );
}

export async function upsertRemoteTransaction(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  // See upsertRemoteAccount for the rationale on the updated_at guard.
  await db.runAsync(
    `INSERT INTO transactions
       (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
        status, transfer_link_id, receipt_path, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, txn_date = excluded.txn_date,
       payee = excluded.payee, amount = excluded.amount,
       check_number = excluded.check_number, memo = excluded.memo,
       status = excluded.status, transfer_link_id = excluded.transfer_link_id,
       receipt_path = excluded.receipt_path,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transactions._sync_status = 'synced'
       AND (
         transactions.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(transactions.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.txn_date,
      row.payee,
      row.amount,
      row.check_number ?? null,
      row.memo ?? null,
      row.status,
      row.transfer_link_id ?? null,
      row.receipt_path ?? null,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative refresh used only by the reconcile pass. Unlike
 * upsertRemoteTransaction, it overwrites a 'synced' local row regardless of the
 * updated_at ordering — the server is the source of truth for synced rows, so a
 * server correction with an OLDER updated_at than the local copy (which the
 * normal `excluded.updated_at >= local` guard would skip forever) is applied.
 *
 * It still refuses to touch 'pending'/'deleted' rows (unsynced local edits), and
 * the reconcile caller only invokes it for ids that are missing locally or whose
 * synced local copy genuinely differs from the freshly-read remote row — so a
 * concurrently-pushed edit (which would already match remote) is never clobbered.
 */
export async function forceUpsertRemoteTransaction(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  await db.runAsync(
    `INSERT INTO transactions
       (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
        status, transfer_link_id, receipt_path, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, txn_date = excluded.txn_date,
       payee = excluded.payee, amount = excluded.amount,
       check_number = excluded.check_number, memo = excluded.memo,
       status = excluded.status, transfer_link_id = excluded.transfer_link_id,
       receipt_path = excluded.receipt_path,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transactions._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.txn_date,
      row.payee,
      row.amount,
      row.check_number ?? null,
      row.memo ?? null,
      row.status,
      row.transfer_link_id ?? null,
      row.receipt_path ?? null,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Splits have no tombstone and no cursor of their own — they ride their parent
 * (see pullTransactions step 3). What they do have since #20 is an updated_at,
 * so the last-write-wins guard is the same one every other table uses.
 *
 * NULL-tolerant on both sides: `row.updated_at` is undefined for every split
 * read from a server without 006_split_updated_at.sql, and the local value is
 * NULL for a split the migration-2 backfill could not reach.
 *
 * The last-write-wins comparison itself is UNREACHABLE today, and is here for
 * consistency with the other three tables rather than because anything hits it:
 * both callers delete the parent's 'synced' local splits immediately before
 * upserting, so a conflicting row can only be an unsynced one — which the
 * `_sync_status = 'synced'` condition already refuses. Do not read its presence
 * as evidence that split timestamps are ordered server-side.
 *
 * They are not: 006 adds only a BEFORE UPDATE trigger, and splits are never
 * UPDATEd (they are deleted and reinserted), so in practice every split's
 * updated_at is the value the CLIENT stamped and the server merely re-rendered.
 * A #21 realtime split handler must therefore not use it to order events
 * against another device's clock.
 */
async function upsertRemoteSplit(db: any, row: any): Promise<void> {
  await db.runAsync(
    `INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       transaction_id = excluded.transaction_id, amount = excluded.amount,
       memo = excluded.memo, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transaction_splits._sync_status = 'synced'
       AND (
         transaction_splits.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(transaction_splits.updated_at)
         )
       )`,
    [
      row.id,
      row.transaction_id,
      row.amount,
      row.memo ?? null,
      row.updated_at ?? null,
    ]
  );
}

async function upsertRemoteRule(db: any, row: any): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  const templateStr =
    typeof row.template === 'string'
      ? row.template
      : JSON.stringify(row.template ?? {});

  // See upsertRemoteAccount for the rationale on the updated_at guard.
  await db.runAsync(
    `INSERT INTO recurring_rules
       (id, user_id, account_id, frequency, next_date, end_date, template,
        created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, frequency = excluded.frequency,
       next_date = excluded.next_date, end_date = excluded.end_date,
       template = excluded.template,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE recurring_rules._sync_status = 'synced'
       AND (
         recurring_rules.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(recurring_rules.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.frequency,
      row.next_date,
      row.end_date ?? null,
      templateStr,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative recurring-rule refresh for the reconcile pass — see
 * forceUpsertRemoteAccount.
 */
async function forceUpsertRemoteRule(db: any, row: any): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  const templateStr =
    typeof row.template === 'string'
      ? row.template
      : JSON.stringify(row.template ?? {});

  await db.runAsync(
    `INSERT INTO recurring_rules
       (id, user_id, account_id, frequency, next_date, end_date, template,
        created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, frequency = excluded.frequency,
       next_date = excluded.next_date, end_date = excluded.end_date,
       template = excluded.template,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE recurring_rules._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.frequency,
      row.next_date,
      row.end_date ?? null,
      templateStr,
      row.created_at,
      row.updated_at,
    ]
  );
}

import { supabase } from './supabase';
import { getDb, getSyncMeta, setSyncMeta } from './db';
import { refreshSyncState, setLastError, setSyncing } from './syncStatus';

let _syncInProgress = false;
let _pushQueued = false;

async function notifySyncState(userId: string) {
  try {
    await refreshSyncState(userId);
  } catch (e) {
    console.warn('[sync] refresh status failed:', e);
  }
}

export async function requestPush(userId: string): Promise<void> {
  if (_syncInProgress) {
    _pushQueued = true;
    return;
  }
  try {
    _syncInProgress = true;
    setSyncing(true);
    setLastError(null);
    await pushChanges(userId);
  } catch (e) {
    console.warn('[sync] push failed:', e);
    setLastError(e instanceof Error ? e.message : String(e));
  } finally {
    _syncInProgress = false;
    setSyncing(false);
    await notifySyncState(userId);
    if (_pushQueued) {
      _pushQueued = false;
      requestPush(userId);
    }
  }
}

export async function fullSync(userId: string): Promise<void> {
  if (_syncInProgress) {
    return;
  }
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
    _syncInProgress = false;
    setSyncing(false);
    await notifySyncState(userId);
    if (_pushQueued) {
      _pushQueued = false;
      requestPush(userId);
    }
  }
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
    _syncInProgress = false;
    setSyncing(false);
    await notifySyncState(userId);
    if (_pushQueued) {
      _pushQueued = false;
      requestPush(userId);
    }
  }
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
    return;
  }
  try {
    _syncInProgress = true;
    setSyncing(true);
    setLastError(null);
    const db = await getDb();

    // Every remote read below checks `error` and throws on failure. A
    // swallowed error here is catastrophic: initialPull would load a
    // partial (or empty) dataset, then set the cursor meta at the end,
    // marking the local DB "fully pulled as of now" — and nothing ever
    // back-fills the missing rows (incremental pull only fetches
    // updated_at > cursor; reconciliation only deletes). Throwing leaves
    // the cursor unset so needsInitialPull stays true and the next launch
    // retries from scratch.
    const { data: accounts, error: acctErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId);

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
      .eq('user_id', userId);

    if (ruleErr) {
      throw new Error(`initialPull recurring_rules failed: ${ruleErr.message}`);
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

    console.log(`[sync] initialPull loaded ${allTxnIds.length} transactions`);

    const now = new Date().toISOString();
    await setSyncMeta(`last_pull_at:${userId}`, now);
    await setSyncMeta(`last_txn_pull_at:${userId}`, now);
  } catch (e) {
    console.warn('[sync] initial pull failed:', e);
    setLastError(e instanceof Error ? e.message : String(e));
  } finally {
    _syncInProgress = false;
    setSyncing(false);
    await notifySyncState(userId);
    // We're deferring (not skipping) the _pushQueued drain to the
    // fullSync that useSyncEngine.init runs immediately after. fullSync's
    // pushChanges will pick up any rows whose requestPush queued during
    // the pull, then its own finally block drains _pushQueued. If we
    // drained here we'd re-acquire _syncInProgress and force the
    // following fullSync to early-return (skipping its pull).
  }
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
 * Uploads every local 'pending'/'deleted' row. Lock-free: callers hold the
 * _syncInProgress lock. Exported for direct testing — the post-push state is
 * what matters here, and fullSync's pull would mask it by re-fetching.
 */
export async function pushChanges(userId: string): Promise<void> {
  const db = await getDb();

  await pushTable(db, 'accounts', userId, (row) => ({
    ...row,
    is_archived: !!row.is_archived,
    exclude_from_total: !!row.exclude_from_total,
  }));

  await pushTable(db, 'recurring_rules', userId, (row) => ({
    ...row,
    template:
      typeof row.template === 'string'
        ? JSON.parse(row.template)
        : row.template,
  }));

  const pendingTxns = await db.getAllAsync<any>(
    `SELECT * FROM transactions WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pendingTxns) {
    const { _sync_status, ...data } = row;
    const { data: saved, error } = await supabase
      .from('transactions')
      .upsert(data, { onConflict: 'id' })
      .select('id, updated_at')
      .single();
    if (error) {
      continue;
    }
    const savedAt = serverUpdatedAt(saved);

    let splitsSynced = true;
    const { error: delSplitErr } = await supabase
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', row.id);
    if (delSplitErr) {
      splitsSynced = false;
    } else {
      const localSplits = await db.getAllAsync<any>(
        'SELECT * FROM transaction_splits WHERE transaction_id = ?',
        [row.id]
      );
      if (localSplits.length > 0) {
        const splitData = localSplits.map(
          ({ _sync_status: _s, ...s }: any) => s
        );
        const { error: insSplitErr } = await supabase
          .from('transaction_splits')
          .insert(splitData);
        if (insSplitErr) {
          splitsSynced = false;
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
      // KNOWN GAP: transaction_splits has no updated_at, so we can't
      // confirm whether the split rows we're marking 'synced' are still
      // the ones we just uploaded. If a local split edit landed between
      // the SELECT above and this UPDATE, this clobbers its 'pending'
      // status and the next push won't replay it. Adding updated_at to
      // the splits schema is the proper fix; for now the only mitigation
      // is that splits are deleted-then-reinserted on push, which makes
      // the window narrower (the local edit has to land specifically
      // during the network round-trip). At least require pending so an
      // already-synced row isn't gratuitously rewritten.
      await db.runAsync(
        "UPDATE transaction_splits SET _sync_status = 'synced' WHERE transaction_id = ? AND _sync_status = 'pending'",
        [row.id]
      );
    }
  }

  const deletedTxns = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  for (const row of deletedTxns) {
    await supabase
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', row.id);
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', row.id);
    if (!error) {
      await db.runAsync(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
        [row.id]
      );
      await db.runAsync('DELETE FROM transactions WHERE id = ?', [row.id]);
    }
  }

  const deletedRules = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM recurring_rules WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  for (const row of deletedRules) {
    const { error } = await supabase
      .from('recurring_rules')
      .delete()
      .eq('id', row.id);
    if (!error) {
      await db.runAsync('DELETE FROM recurring_rules WHERE id = ?', [row.id]);
    }
  }
}

async function pushTable(
  db: any,
  table: string,
  userId: string,
  transform: (row: any) => any
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
      .select('id, updated_at')
      .single();
    if (!error) {
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
  }

  const deleted = await db.getAllAsync(
    `SELECT id FROM ${table} WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  for (const row of deleted) {
    const { error } = await supabase.from(table).delete().eq('id', row.id);
    if (!error) {
      await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [row.id]);
    }
  }
}

async function pullChanges(
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
    opts
  );
  await pullTableFull(
    db,
    'recurring_rules',
    userId,
    upsertRemoteRule,
    forceUpsertRemoteRule,
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
    return;
  }
  if (!data) {
    return;
  }

  const remoteIds = new Set(data.map((r: any) => r.id));

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

  for (const row of data) {
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

  for (const [id] of localUpdatedById) {
    if (!remoteIds.has(id)) {
      await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [id]);
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
  local: ReconcileLocalRow[]
): ReconcilePlan {
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
  let offset = 0;
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
    if (error || !data || data.length === 0) {
      break;
    }
    for (const row of data) {
      await upsertRemoteTransaction(db, row);
      pulledTxnIds.push(row.id);
    }
    if (data.length < PAGE) {
      break;
    }
    offset += PAGE;
  }

  // 2) Reconcile pass. Enumerate ALL remote (id, updated_at) so we can both
  //    delete rows the server dropped AND heal rows that drifted but weren't
  //    caught above (the older-than-cursor correction case).
  const remote: ReconcileRemoteRow[] = [];
  let reconError = false;
  let reconOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, updated_at')
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
    for (const r of data) {
      remote.push({ id: r.id, updated_at: r.updated_at });
    }
    if (data.length < PAGE) {
      break;
    }
    reconOffset += PAGE;
  }

  let toRefresh: string[] = [];
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

    const plan = planTransactionReconcile(remote, local);
    toRefresh = plan.toRefresh;

    for (const id of plan.toDelete) {
      await db.runAsync(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
        [id]
      );
      await db.runAsync('DELETE FROM transactions WHERE id = ?', [id]);
    }

    const REFRESH_BATCH = 200;
    for (let i = 0; i < toRefresh.length; i += REFRESH_BATCH) {
      const batch = toRefresh.slice(i, i + REFRESH_BATCH);
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .in('id', batch);
      if (error || !data) {
        continue;
      }
      for (const row of data) {
        await forceUpsertRemoteTransaction(db, row);
      }
    }
  }

  // 3) Refresh splits for every transaction we pulled or healed. Fetch BEFORE
  //    deleting the local copies — deleting first and then failing the fetch
  //    would drop synced splits with nothing to reinsert (and the parent isn't
  //    "touched" again until it next drifts, so they'd stay missing).
  const touched = Array.from(new Set([...pulledTxnIds, ...toRefresh]));
  const SPLIT_BATCH = 200;
  for (let i = 0; i < touched.length; i += SPLIT_BATCH) {
    const batch = touched.slice(i, i + SPLIT_BATCH);
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
  await setSyncMeta(`last_txn_pull_at:${userId}`, pullStartedAt);
}

export async function upsertRemoteAccount(db: any, row: any): Promise<void> {
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

async function upsertRemoteSplit(db: any, row: any): Promise<void> {
  await db.runAsync(
    `INSERT INTO transaction_splits (id, transaction_id, amount, memo, _sync_status)
     VALUES (?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       transaction_id = excluded.transaction_id, amount = excluded.amount,
       memo = excluded.memo, _sync_status = 'synced'
     WHERE transaction_splits._sync_status = 'synced'`,
    [row.id, row.transaction_id, row.amount, row.memo ?? null]
  );
}

async function upsertRemoteRule(db: any, row: any): Promise<void> {
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

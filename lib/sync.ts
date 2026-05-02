import { supabase } from './supabase';
import { getDb, getSyncMeta, setSyncMeta } from './db';
import {
  refreshSyncState,
  setLastError,
  setSyncing,
} from './syncStatus';

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

    const { data: accounts } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId);

    if (accounts) {
      for (const row of accounts) {
        await upsertRemoteAccount(db, row);
      }
    }

    const { data: rules } = await supabase
      .from('recurring_rules')
      .select('*')
      .eq('user_id', userId);

    if (rules) {
      for (const row of rules) {
        await upsertRemoteRule(db, row);
      }
    }

    let txnOffset = 0;
    const PAGE = 1000;
    const allTxnIds: string[] = [];
    while (true) {
      const { data: txns } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('id')
        .range(txnOffset, txnOffset + PAGE - 1);

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
        const { data: splits } = await supabase
          .from('transaction_splits')
          .select('*')
          .in('transaction_id', batch);

        if (splits) {
          for (const row of splits) {
            await upsertRemoteSplit(db, row);
          }
        }
      }
    }

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

async function pushChanges(userId: string): Promise<void> {
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
    const { error } = await supabase
      .from('transactions')
      .upsert(data, { onConflict: 'id' });
    if (error) {
      continue;
    }

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
      await db.runAsync(
        `UPDATE transactions
         SET _sync_status = 'synced'
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
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
  const pending = await db.getAllAsync<any>(
    `SELECT * FROM ${table} WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pending) {
    const { _sync_status, ...raw } = row;
    const data = transform(raw);
    const { error } = await supabase
      .from(table)
      .upsert(data, { onConflict: 'id' });
    if (!error) {
      // Only mark synced if updated_at still matches what we read AND the
      // row is still 'pending'. If a newer local edit lands while the
      // network upsert above is in flight, that edit bumps updated_at and
      // re-marks the row 'pending' — and we must NOT clobber it back to
      // 'synced', or the next push won't see it and a later pull can
      // overwrite the unsynced edit.
      await db.runAsync(
        `UPDATE ${table}
         SET _sync_status = 'synced'
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
      );
    }
  }

  const deleted = await db.getAllAsync<{ id: string }>(
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

async function pullChanges(userId: string): Promise<void> {
  const db = await getDb();

  await pullTableFull(db, 'accounts', userId, upsertRemoteAccount);
  await pullTableFull(db, 'recurring_rules', userId, upsertRemoteRule);
  await pullTransactions(db, userId);

  await setSyncMeta(`last_pull_at:${userId}`, new Date().toISOString());
}

async function pullTableFull(
  db: any,
  table: string,
  userId: string,
  upsertFn: (db: any, row: any) => Promise<void>
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

  if (error || !data) {
    return;
  }

  const remoteIds = new Set(data.map((r: any) => r.id));

  for (const row of data) {
    await upsertFn(db, row);
  }

  const locals = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM ${table}
     WHERE user_id = ?
       AND _sync_status = 'synced'
       AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))`,
    [userId, pullStartedAt]
  );
  for (const local of locals) {
    if (!remoteIds.has(local.id)) {
      await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [local.id]);
    }
  }
}

async function pullTransactions(db: any, userId: string): Promise<void> {
  // See pullTableFull for the pullStartedAt rationale. Captured before any
  // remote read so the reconciliation pass below ignores transactions
  // created locally + pushed mid-pull.
  const pullStartedAt = new Date().toISOString();
  const lastPull = await getSyncMeta(`last_txn_pull_at:${userId}`);

  let query = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('id');

  if (lastPull) {
    query = query.gt('updated_at', lastPull);
  }

  let offset = 0;
  const PAGE = 1000;
  const pulledTxnIds: string[] = [];

  while (true) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);
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

  if (pulledTxnIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < pulledTxnIds.length; i += BATCH) {
      const batch = pulledTxnIds.slice(i, i + BATCH);
      for (const txnId of batch) {
        await db.runAsync(
          "DELETE FROM transaction_splits WHERE transaction_id = ? AND _sync_status = 'synced'",
          [txnId]
        );
      }
      const { data: splits } = await supabase
        .from('transaction_splits')
        .select('*')
        .in('transaction_id', batch);
      if (splits) {
        for (const row of splits) {
          await upsertRemoteSplit(db, row);
        }
      }
    }
  }

  const remoteIds = new Set<string>();
  let reconOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', userId)
      .order('id')
      .range(reconOffset, reconOffset + PAGE - 1);
    if (error || !data || data.length === 0) {
      break;
    }
    for (const r of data) {
      remoteIds.add(r.id);
    }
    if (data.length < PAGE) {
      break;
    }
    reconOffset += PAGE;
  }

  const localSynced = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions
     WHERE user_id = ?
       AND _sync_status = 'synced'
       AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))`,
    [userId, pullStartedAt]
  );
  for (const local of localSynced) {
    if (!remoteIds.has(local.id)) {
      await db.runAsync(
        "DELETE FROM transaction_splits WHERE transaction_id = ?",
        [local.id]
      );
      await db.runAsync('DELETE FROM transactions WHERE id = ?', [local.id]);
    }
  }

  await setSyncMeta(`last_txn_pull_at:${userId}`, new Date().toISOString());
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
      row.id, row.user_id, row.name, row.type, row.icon ?? null,
      row.initial_balance, row.exclude_from_total ? 1 : 0,
      row.sort_order, row.is_archived ? 1 : 0,
      row.created_at, row.updated_at,
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
      row.id, row.user_id, row.account_id, row.txn_date, row.payee,
      row.amount, row.check_number ?? null, row.memo ?? null,
      row.status, row.transfer_link_id ?? null, row.receipt_path ?? null,
      row.created_at, row.updated_at,
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
      row.id, row.user_id, row.account_id, row.frequency,
      row.next_date, row.end_date ?? null, templateStr,
      row.created_at, row.updated_at,
    ]
  );
}

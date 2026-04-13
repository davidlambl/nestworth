import { supabase } from './supabase';
import { getDb, getSyncMeta, setSyncMeta } from './db';

let _syncInProgress = false;
let _pushQueued = false;

export async function requestPush(userId: string): Promise<void> {
  if (_syncInProgress) {
    _pushQueued = true;
    return;
  }
  try {
    _syncInProgress = true;
    await pushChanges(userId);
  } catch (e) {
    console.warn('[sync] push failed:', e);
  } finally {
    _syncInProgress = false;
    if (_pushQueued) {
      _pushQueued = false;
      requestPush(userId);
    }
  }
}

export async function fullSync(userId: string): Promise<boolean> {
  if (_syncInProgress) {
    return false;
  }
  let success = false;
  try {
    _syncInProgress = true;
    await pushChanges(userId);
    await pullChanges(userId);
    success = true;
  } catch (e) {
    console.warn('[sync] full sync failed:', e);
  } finally {
    _syncInProgress = false;
    if (_pushQueued) {
      _pushQueued = false;
      requestPush(userId);
    }
  }
  return success;
}

export async function needsInitialPull(userId: string): Promise<boolean> {
  const v = await getSyncMeta(`last_pull_at:${userId}`);
  return !v;
}

export async function initialPull(userId: string): Promise<void> {
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
      await db.runAsync(
        "UPDATE transactions SET _sync_status = 'synced' WHERE id = ?",
        [row.id]
      );
      await db.runAsync(
        "UPDATE transaction_splits SET _sync_status = 'synced' WHERE transaction_id = ?",
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
      await db.runAsync(
        `UPDATE ${table} SET _sync_status = 'synced' WHERE id = ?`,
        [row.id]
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
    `SELECT id FROM ${table} WHERE user_id = ? AND _sync_status = 'synced'`,
    [userId]
  );
  for (const local of locals) {
    if (!remoteIds.has(local.id)) {
      await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [local.id]);
    }
  }
}

async function pullTransactions(db: any, userId: string): Promise<void> {
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
    "SELECT id FROM transactions WHERE user_id = ? AND _sync_status = 'synced'",
    [userId]
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
      row.id, row.user_id, row.account_id, row.frequency,
      row.next_date, row.end_date ?? null, templateStr,
      row.created_at, row.updated_at,
    ]
  );
}

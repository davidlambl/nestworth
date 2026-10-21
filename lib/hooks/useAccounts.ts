import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapAccount } from '../mappers';
import { applyAccountDelete } from '../accountDelete';
import { applyMove, moveAccount } from '../accountOrder';
import { QUERY_RETRY } from '../queryRetry';
import type {
  Account,
  AccountType,
  AccountWithBalance,
  DbAccount,
} from '../types';

const ACCOUNTS_KEY = ['accounts'];

export function useAccounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: async (): Promise<AccountWithBalance[]> => {
      const db = await getDb();

      const rows = await db.getAllAsync<DbAccount>(
        `SELECT * FROM accounts
         WHERE user_id = ? AND _sync_status != 'deleted'
         ORDER BY sort_order, created_at`,
        [user!.id]
      );

      const mapped = rows.map(mapAccount);

      const sums = await db.getAllAsync<{
        account_id: string;
        total: number;
      }>(
        `SELECT account_id, SUM(amount) as total
         FROM transactions
         WHERE user_id = ? AND _sync_status != 'deleted'
         GROUP BY account_id`,
        [user!.id]
      );

      const sumByAccount = new Map<string, number>();
      for (const s of sums) {
        sumByAccount.set(s.account_id, s.total);
      }

      return mapped.map((acct) => ({
        ...acct,
        currentBalance: acct.initialBalance + (sumByAccount.get(acct.id) ?? 0),
      }));
    },
    enabled: !!user,
  });
}

/** What useAccount's query fails with when the account is not live here. */
export const ACCOUNT_NOT_FOUND = 'Account not found';

/**
 * Whether a useAccount error says the account is no longer live on this
 * device (#163): deleted here, or gone (a pushed delete, a pulled
 * tombstone, a reset before its re-download), or another account's (#177).
 * Any other error -- a failed read -- is not that, and says nothing about the
 * account.
 */
export function isAccountNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === ACCOUNT_NOT_FOUND;
}

export function useAccount(id: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['account', id],
    queryFn: async (): Promise<Account> => {
      const db = await getDb();
      // The signed-in user's, not any row with this id (#177): a register
      // opened on another account's id (the browser's history, a typed link)
      // showed that account's name, its archived banner and Unarchive. It now
      // says the account is gone, and offers nothing that writes into it.
      const row = await db.getFirstAsync<DbAccount>(
        "SELECT * FROM accounts WHERE id = ? AND user_id = ? AND _sync_status != 'deleted'",
        [id, user!.id]
      );
      if (!row) {
        throw new Error(ACCOUNT_NOT_FOUND);
      }
      return mapAccount(row);
    },
    // Not found is this device's own answer, and a retry a second later reads
    // the same row: failing at once flips a register re-opened on a dead
    // account to its gone state without a second of live "+" (#163). Any
    // other error keeps the app's retries (QUERY_RETRY, lib/query.tsx's
    // default).
    retry: (failureCount, error) =>
      !isAccountNotFound(error) && failureCount < QUERY_RETRY,
    enabled: !!user && !!id,
  });
}

interface CreateAccountInput {
  name: string;
  type: AccountType;
  icon?: string | null;
  initialBalance: number;
  excludeFromTotal?: boolean;
}

export function useCreateAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['accounts', 'create'],
    mutationFn: async (input: CreateAccountInput) => {
      const db = await getDb();
      const id = Crypto.randomUUID();
      const now = new Date().toISOString();

      const maxRow = await db.getFirstAsync<{ max_order: number | null }>(
        'SELECT MAX(sort_order) as max_order FROM accounts WHERE user_id = ?',
        [user!.id]
      );
      const nextOrder = (maxRow?.max_order ?? -1) + 1;

      await db.runAsync(
        `INSERT INTO accounts
           (id, user_id, name, type, icon, initial_balance, exclude_from_total,
            sort_order, is_archived, created_at, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`,
        [
          id,
          user!.id,
          input.name,
          input.type,
          input.icon ?? null,
          input.initialBalance,
          input.excludeFromTotal ? 1 : 0,
          nextOrder,
          now,
          now,
        ]
      );

      const row = await db.getFirstAsync<DbAccount>(
        'SELECT * FROM accounts WHERE id = ?',
        [id]
      );
      if (!row) {
        throw new Error(`createAccount: row ${id} not found after insert`);
      }
      requestPush(user!.id);
      return mapAccount(row);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
}

interface UpdateAccountInput {
  id: string;
  name?: string;
  type?: AccountType;
  icon?: string | null;
  initialBalance?: number;
  excludeFromTotal?: boolean;
  isArchived?: boolean;
  sortOrder?: number;
}

export function useUpdateAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['accounts', 'update'],
    mutationFn: async (input: UpdateAccountInput) => {
      const db = await getDb();
      const setClauses: string[] = [];
      const params: any[] = [];

      if (input.name !== undefined) {
        setClauses.push('name = ?');
        params.push(input.name);
      }
      if (input.type !== undefined) {
        setClauses.push('type = ?');
        params.push(input.type);
      }
      if (input.icon !== undefined) {
        setClauses.push('icon = ?');
        params.push(input.icon);
      }
      if (input.initialBalance !== undefined) {
        setClauses.push('initial_balance = ?');
        params.push(input.initialBalance);
      }
      if (input.excludeFromTotal !== undefined) {
        setClauses.push('exclude_from_total = ?');
        params.push(input.excludeFromTotal ? 1 : 0);
      }
      if (input.isArchived !== undefined) {
        setClauses.push('is_archived = ?');
        params.push(input.isArchived ? 1 : 0);
      }
      if (input.sortOrder !== undefined) {
        setClauses.push('sort_order = ?');
        params.push(input.sortOrder);
      }

      setClauses.push('updated_at = ?');
      params.push(new Date().toISOString());
      setClauses.push("_sync_status = 'pending'");
      // The signed-in user's own account (#177). The Accounts tab's Edit
      // Account sheet and icon picker keep the account they opened in their
      // own state: left open in one tab of the app while another tab signed a
      // second account in over the first (auth-js tells this tab SIGNED_IN
      // alone, so it never passes through "signed out"), the sheet saved the
      // second account's edit into the first one's account.
      params.push(input.id, user!.id);

      // Skips an account this device has marked deleted (#153). An account
      // delete (applyAccountDelete) marks the account, its transactions and
      // its rules 'deleted' for the push to upload, and until that upload an
      // edit can still reach the account: from an Accounts list that has not
      // refetched since the delete, or a register re-opened on it (the
      // browser's Forward, a stale link) before its refetch has said the
      // account is gone (#163), while the push is in flight or failing. Before
      // #153 this UPDATE matched the row and set it back to 'pending': the
      // push uploaded the account live, archived or renamed, while it
      // tombstoned its transactions and rules, an account delete half undone
      // on every device. `IS NOT`, not `!=`: a NULL status (no writer makes
      // one) is not a delete, and `!=` would refuse that row.
      const res = await db.runAsync(
        `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ? AND _sync_status IS NOT 'deleted'`,
        params
      );
      if (__DEV__) {
        console.log('[accounts] update', input.id, 'changes=', res.changes);
      }
      // A silent zero here is exactly the failure #55 could not explain:
      // the modal closes on the same tick, so nothing else would notice.
      // Nothing of the edit's was written, and no transaction is open here,
      // so it throws at once. The status read only picks the words: a row
      // still here is one this device deleted and has not uploaded yet; a
      // missing one keeps #55's words. The commonest missing row is this
      // device's own delete once the push has uploaded it and removed the
      // row (a register re-opened on the account reaches it, before its
      // refetch says the account is gone); the others are the wipe's late
      // UPDATE and a pulled tombstone. The push's hard delete is a plain
      // statement and can land between the UPDATE and this read, which then
      // finds no row.
      if (res.changes === 0) {
        // Another account's reads as missing, never as "deleted on this
        // device" (#177).
        const here = await db.getFirstAsync<{ _sync_status: string | null }>(
          'SELECT _sync_status FROM accounts WHERE id = ? AND user_id = ?',
          [input.id, user!.id]
        );
        if (here?._sync_status === 'deleted') {
          throw new Error(
            'This account was deleted on this device, so this change was not saved.'
          );
        }
        throw new Error(`updateAccount: no local row matched ${input.id}`);
      }

      const row = await db.getFirstAsync<DbAccount>(
        'SELECT * FROM accounts WHERE id = ?',
        [input.id]
      );
      if (!row) {
        throw new Error(`updateAccount: row ${input.id} vanished after update`);
      }
      requestPush(user!.id);
      return mapAccount(row);
    },
    // Settled, not only succeeded: a refused edit came from a list that
    // still shows the account, and the refetch drops its card (#153). A
    // register re-opened on it refetches ['account', id] below: the read
    // fails with 'Account not found', and the register shows the account is
    // gone (#163) -- TanStack keeps the last data on a failed refetch, which
    // the register used to keep showing, Unarchive and all.
    onSettled: (_data, _error, input) => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      // The register screen reads ['account', id], not ['accounts'], so
      // archiving or renaming from anywhere has to invalidate that key too —
      // otherwise the register's archived banner lags a mutation behind.
      qc.invalidateQueries({ queryKey: ['account', input.id] });
    },
  });
}

// iOS chevron-reorder "chop" fix — load-bearing pieces here, plus two outside
// this file. Each looks unmotivated in isolation; together they keep rapid-fire
// reorders from visually chopping the FlatList. Don't remove any piece without
// reproducing the chop on a physical iOS device first.
//
// In this hook:
//   1. `scope: { id: 'reorder-accounts' }` serializes concurrent mutationFns
//      so per-row UPDATEs can't interleave and produce non-deterministic
//      sort_order.
//   2. `db.withTransactionAsync` wraps the N UPDATEs in one commit — atomic on
//      disk and one JSI round-trip instead of N (big iOS win).
//   3. `setTimeout(() => requestPush, 0)` defers sync-state emits off the
//      chevron tap's tick so the header sync indicator doesn't re-render
//      mid-reorder.
//   4. `move()` writes an optimistic cache update via `applyMove` for instant
//      UI feedback, then calls `mutate({ id, direction })`. The `mutationFn`
//      reads the current order FROM DISK inside the serialized transaction and
//      computes the swap there, so each write sees the previous commit — disk
//      is correct regardless of what the cache says. Computing on disk is
//      essential because a sync-engine pull can invalidate the accounts query
//      mid-burst; if the resulting refetch reads SQLite before the queued
//      transaction commits, it overwrites the optimistic cache with stale
//      data, and a cache-derived second tap would compute from that stale
//      snapshot (the post-merge flake on #69).
//   5. `onSettled` invalidates ONLY when this is the last reorder in the burst
//      (`isMutating <= 1`). This does NOT reintroduce the chop: when this was
//      the last write, no next serialized write exists to race against; the
//      refetch re-renders once with an identical active order (new references
//      from the updated `updated_at` timestamps, but same ids in the same
//      positions), so there is no layout change to animate or chop, and
//      `RefreshControl` is decoupled from `isRefetching` via `isPulling`.
//      Mid-burst, the guard skips the invalidate so a refetch can't read
//      pre-commit disk and clobber the optimistic cache.
//
// Outside this file:
//   - app/(tabs)/index.tsx: `RefreshControl.refreshing` is bound to a local
//     `isPulling` state, NOT `useAccounts().isRefetching`. Otherwise any
//     background refetch makes iOS reserve the spinner band and chops the
//     list downward.
//   - lib/syncStatus.ts `refreshSyncState`: coalesced into a single emit per
//     call so a sync cycle produces fewer header re-renders.
export function useReorderAccounts() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationKey: ['accounts', 'reorder'],
    // Same scope id → TanStack Query runs concurrent calls strictly serially.
    // Without this, rapid-fire chevron taps fire parallel mutationFns whose
    // per-row UPDATEs interleave and produce non-deterministic sort_order.
    scope: { id: 'reorder-accounts' },
    mutationFn: async (intent: { id: string; direction: -1 | 1 }) => {
      const db = await getDb();
      const now = new Date().toISOString();
      let wrote = false;
      await db.withTransactionAsync(async () => {
        // Read the current active order from disk inside the serialized
        // transaction — this is the source of truth, not the cache. Its
        // `!= 'deleted'` also keeps an account this device deleted out of the
        // rewrite, so a move from a list that still shows it never sets it
        // back to 'pending' (#153).
        const rows = await db.getAllAsync<{ id: string }>(
          `SELECT id FROM accounts
           WHERE user_id = ? AND _sync_status != 'deleted' AND is_archived = 0
           ORDER BY sort_order, created_at`,
          [user!.id]
        );
        const moved = moveAccount(rows, intent.id, intent.direction);
        if (!moved) return;
        for (let i = 0; i < moved.length; i++) {
          await db.runAsync(
            "UPDATE accounts SET sort_order = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ?",
            [i, now, moved[i].id]
          );
        }
        wrote = true;
      });
      // Defer the push so its sync-state emits (setSyncing(true), then
      // setSyncing(false), then refreshSyncState) don't fire on the same
      // tick as the chevron tap. Otherwise the navigation-header sync
      // indicator re-renders mid-reorder and visibly chops the FlatList.
      // The push is best-effort anyway — fullSync will pick it up too.
      if (wrote) {
        setTimeout(() => requestPush(user!.id), 0);
      }
    },
    onSettled: () => {
      // Invalidate only when this is the last reorder in the burst. Mid-burst,
      // a refetch would read disk before the queued writes commit and clobber
      // the optimistic cache with stale data. When this was the last write, no
      // next serialized write exists to race against; the refetch re-renders
      // once with an identical active order (new references from updated
      // timestamps, but same ids in the same positions), so there is no layout
      // change to animate or chop, and RefreshControl is decoupled from
      // isRefetching via isPulling.
      // (isMutating counts status==='pending'; the settling mutation has not
      // yet transitioned to 'success' or 'error' when onSettled fires, so it
      // is still counted.)
      if (qc.isMutating({ mutationKey: ['accounts', 'reorder'] }) <= 1) {
        qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      }
    },
  });

  const move = async (
    id: string,
    direction: -1 | 1,
    onWillWrite?: () => void
  ): Promise<boolean> => {
    await qc.cancelQueries({ queryKey: ACCOUNTS_KEY });
    const current = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY);
    if (!current) return false;
    const result = applyMove(current, id, direction);
    // If the cache says it's a no-op, don't mutate. The cache being stale in
    // the other direction (cache says no-op but disk says movable) is not worth
    // a write — a later sync pull or the next successful reorder's onSettled
    // will reconcile the cache with disk.
    if (!result) return false;
    onWillWrite?.();
    qc.setQueryData<AccountWithBalance[]>(ACCOUNTS_KEY, result.next);
    mutation.mutate({ id, direction });
    return true;
  };

  return { move, isPending: mutation.isPending };
}

export function useDeleteAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['accounts', 'delete'],
    mutationFn: async (id: string) => {
      const db = await getDb();
      // One SQLite transaction: marked separately, an interruption could
      // leave the account's children deleted under a live account (#114).
      await applyAccountDelete(db, id, { now: new Date().toISOString() });
      requestPush(user!.id);
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      qc.invalidateQueries({ queryKey: ['recurring_rules'] });
      qc.invalidateQueries({ queryKey: ['transactions', id] });
      qc.invalidateQueries({ queryKey: ['transactions', '__all__'] });
      // A register re-opened on the account within the cache's staleTime
      // (the browser's Forward) read ['account', id] from the cache, with
      // "+" and the transfer button. Invalidated here, it refetches as it
      // opens: the read fails with 'Account not found', and the register
      // shows the account is gone instead of offering to write into it
      // (#163).
      qc.invalidateQueries({ queryKey: ['account', id] });
    },
  });
}

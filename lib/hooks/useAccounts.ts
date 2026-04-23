import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapAccount } from '../mappers';
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
         ORDER BY sort_order`,
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
        currentBalance:
          acct.initialBalance + (sumByAccount.get(acct.id) ?? 0),
      }));
    },
    enabled: !!user,
  });
}

export function useAccount(id: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['account', id],
    queryFn: async (): Promise<Account> => {
      const db = await getDb();
      const row = await db.getFirstAsync<DbAccount>(
        "SELECT * FROM accounts WHERE id = ? AND _sync_status != 'deleted'",
        [id]
      );
      if (!row) {
        throw new Error('Account not found');
      }
      return mapAccount(row);
    },
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
          id, user!.id, input.name, input.type, input.icon ?? null,
          input.initialBalance, input.excludeFromTotal ? 1 : 0,
          nextOrder, now, now,
        ]
      );

      const row = await db.getFirstAsync<DbAccount>(
        'SELECT * FROM accounts WHERE id = ?',
        [id]
      );
      requestPush(user!.id);
      return mapAccount(row!);
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
      params.push(input.id);

      await db.runAsync(
        `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = ?`,
        params
      );

      const row = await db.getFirstAsync<DbAccount>(
        'SELECT * FROM accounts WHERE id = ?',
        [input.id]
      );
      requestPush(user!.id);
      return mapAccount(row!);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
}

export function useReorderAccounts() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    // Same scope id → TanStack Query runs concurrent calls strictly serially.
    // Without this, rapid-fire chevron taps fire parallel mutationFns whose
    // per-row UPDATEs interleave and produce non-deterministic sort_order.
    scope: { id: 'reorder-accounts' },
    mutationFn: async (ordered: AccountWithBalance[]) => {
      const db = await getDb();
      const now = new Date().toISOString();
      // Single transaction: atomic on disk, and one commit instead of N — a
      // big win on iOS where each runAsync round-trips through JSI.
      await db.withTransactionAsync(async () => {
        for (let i = 0; i < ordered.length; i++) {
          await db.runAsync(
            "UPDATE accounts SET sort_order = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ?",
            [i, now, ordered[i].id]
          );
        }
      });
      requestPush(user!.id);
    },
    onMutate: async (ordered) => {
      await qc.cancelQueries({ queryKey: ACCOUNTS_KEY });
      const prev = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY);
      // `ordered` is the active-account view; preserve archived rows in the
      // cache so they don't flicker out until the post-mutation refetch.
      const orderedIds = new Set(ordered.map((a) => a.id));
      const archived = (prev ?? []).filter((a) => !orderedIds.has(a.id));
      qc.setQueryData<AccountWithBalance[]>(ACCOUNTS_KEY, [...ordered, ...archived]);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(ACCOUNTS_KEY, ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
}

export function useDeleteAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const db = await getDb();
      const now = new Date().toISOString();
      await db.runAsync(
        "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE account_id = ?",
        [now, id]
      );
      await db.runAsync(
        "UPDATE recurring_rules SET _sync_status = 'deleted', updated_at = ? WHERE account_id = ?",
        [now, id]
      );
      await db.runAsync(
        "UPDATE accounts SET _sync_status = 'deleted', updated_at = ? WHERE id = ?",
        [now, id]
      );
      requestPush(user!.id);
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      qc.invalidateQueries({ queryKey: ['recurring_rules'] });
      qc.invalidateQueries({ queryKey: ['transactions', id] });
      qc.invalidateQueries({ queryKey: ['transactions', '__all__'] });
    },
  });
}

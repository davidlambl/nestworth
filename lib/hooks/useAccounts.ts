import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { mapAccount } from '../mappers';
import type { Account, AccountType, AccountWithBalance, DbAccount } from '../types';

const ACCOUNTS_KEY = ['accounts'];

export function useAccounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: async (): Promise<AccountWithBalance[]> => {
      const { data: accounts, error: accErr } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', user!.id)
        .order('sort_order', { ascending: true });

      if (accErr) {
        throw accErr;
      }

      const mapped = (accounts as DbAccount[]).map(mapAccount);
      const balances = await Promise.all(
        mapped.map(async (acct) => {
          const { data, error } = await supabase
            .from('transactions')
            .select('amount')
            .eq('account_id', acct.id);

          if (error) {
            throw error;
          }

          const txnSum = (data ?? []).reduce(
            (sum: number, t: { amount: number }) => sum + t.amount,
            0
          );
          return {
            ...acct,
            currentBalance: acct.initialBalance + txnSum,
          };
        })
      );

      return balances;
    },
    enabled: !!user,
  });
}

export function useAccount(id: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['account', id],
    queryFn: async (): Promise<Account> => {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        throw error;
      }

      return mapAccount(data as DbAccount);
    },
    enabled: !!user && !!id,
  });
}

interface CreateAccountInput {
  name: string;
  type: AccountType;
  initialBalance: number;
}

export function useCreateAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateAccountInput) => {
      const { data: existing } = await supabase
        .from('accounts')
        .select('sort_order')
        .eq('user_id', user!.id)
        .order('sort_order', { ascending: false })
        .limit(1);

      const nextOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

      const { data, error } = await supabase
        .from('accounts')
        .insert({
          user_id: user!.id,
          name: input.name,
          type: input.type,
          initial_balance: input.initialBalance,
          sort_order: nextOrder,
          is_archived: false,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return mapAccount(data as DbAccount);
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
  initialBalance?: number;
  isArchived?: boolean;
  sortOrder?: number;
}

export function useUpdateAccount() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateAccountInput) => {
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.type !== undefined) {
        updates.type = input.type;
      }
      if (input.initialBalance !== undefined) {
        updates.initial_balance = input.initialBalance;
      }
      if (input.isArchived !== undefined) {
        updates.is_archived = input.isArchived;
      }
      if (input.sortOrder !== undefined) {
        updates.sort_order = input.sortOrder;
      }

      const { data, error } = await supabase
        .from('accounts')
        .update(updates)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return mapAccount(data as DbAccount);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('accounts').delete().eq('id', id);
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { fetchAll, fetchWithBatchedIn } from '../supabaseHelpers';
import { useAuth } from '../auth';
import { mapTransaction, mapTransactionSplit } from '../mappers';
import type {
  Transaction,
  TransactionStatus,
  TransactionWithSplits,
  DbTransaction,
  DbTransactionSplit,
} from '../types';

function txnKeys(accountId: string) {
  return ['transactions', accountId];
}

export function useTransactions(accountId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: txnKeys(accountId),
    queryFn: async (): Promise<TransactionWithSplits[]> => {
      const rows = await fetchAll<DbTransaction>(
        'transactions',
        (b) =>
          b
            .select('*')
            .eq('account_id', accountId)
            .order('txn_date', { ascending: false })
            .order('created_at', { ascending: false })
      );

      const txns = rows.map(mapTransaction);

      const ids = txns.map((t) => t.id);
      if (ids.length === 0) {
        return [];
      }

      const splitRows = await fetchWithBatchedIn<DbTransactionSplit>(
        'transaction_splits',
        'transaction_id',
        ids
      );

      const splits = splitRows.map(mapTransactionSplit);
      const splitsByTxn = new Map<string, typeof splits>();
      for (const s of splits) {
        const arr = splitsByTxn.get(s.transactionId) ?? [];
        arr.push(s);
        splitsByTxn.set(s.transactionId, arr);
      }

      return txns.map((t) => ({
        ...t,
        splits: splitsByTxn.get(t.id) ?? [],
      }));
    },
    enabled: !!user && !!accountId,
  });
}

const ALL_TXNS_KEY = ['transactions', '__all__'];

export function useAllTransactions() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ALL_TXNS_KEY,
    queryFn: async (): Promise<TransactionWithSplits[]> => {
      const rows = await fetchAll<DbTransaction>(
        'transactions',
        (b) =>
          b
            .select('*')
            .order('txn_date', { ascending: false })
            .order('created_at', { ascending: false })
      );

      const txns = rows.map(mapTransaction);

      const ids = txns.map((t) => t.id);
      if (ids.length === 0) {
        return [];
      }

      const splitRows = await fetchWithBatchedIn<DbTransactionSplit>(
        'transaction_splits',
        'transaction_id',
        ids
      );

      const splits = splitRows.map(mapTransactionSplit);
      const splitsByTxn = new Map<string, typeof splits>();
      for (const s of splits) {
        const arr = splitsByTxn.get(s.transactionId) ?? [];
        arr.push(s);
        splitsByTxn.set(s.transactionId, arr);
      }

      return txns.map((t) => ({
        ...t,
        splits: splitsByTxn.get(t.id) ?? [],
      }));
    },
    enabled: !!user,
  });
}

export function useTransaction(id: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['transaction', id],
    queryFn: async (): Promise<TransactionWithSplits> => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        throw error;
      }

      const txn = mapTransaction(data as DbTransaction);

      const { data: splitRows, error: splitErr } = await supabase
        .from('transaction_splits')
        .select('*')
        .eq('transaction_id', id);

      if (splitErr) {
        throw splitErr;
      }

      return {
        ...txn,
        splits: (splitRows as DbTransactionSplit[]).map(mapTransactionSplit),
      };
    },
    enabled: !!user && !!id,
  });
}

interface CreateTransactionInput {
  accountId: string;
  txnDate: string;
  payee: string;
  amount: number;
  checkNumber?: string | null;
  memo?: string | null;
  status?: TransactionStatus;
  splits?: { amount: number; memo: string | null }[];
}

export function useCreateTransaction() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateTransactionInput) => {
      const { data, error } = await supabase
        .from('transactions')
        .insert({
          user_id: user!.id,
          account_id: input.accountId,
          txn_date: input.txnDate,
          payee: input.payee,
          amount: input.amount,
          check_number: input.checkNumber ?? null,
          memo: input.memo ?? null,
          status: input.status ?? 'pending',
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      const txn = mapTransaction(data as DbTransaction);

      if (input.splits && input.splits.length > 0) {
        const { error: splitErr } = await supabase
          .from('transaction_splits')
          .insert(
            input.splits.map((s) => ({
              transaction_id: txn.id,
              amount: s.amount,
              memo: s.memo,
            }))
          );
        if (splitErr) {
          throw splitErr;
        }
      }

      return txn;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.accountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

interface UpdateTransactionInput {
  id: string;
  accountId: string;
  txnDate?: string;
  payee?: string;
  amount?: number;
  checkNumber?: string | null;
  memo?: string | null;
  status?: TransactionStatus;
  splits?: { amount: number; memo: string | null }[];
}

export function useUpdateTransaction() {
  const qc = useQueryClient();

  const applyOptimistic = (
    old: TransactionWithSplits[] | undefined,
    input: UpdateTransactionInput
  ) => {
    if (!old) {
      return old;
    }
    return old.map((t) => {
      if (t.id !== input.id) {
        return t;
      }
      const patched = { ...t };
      if (input.status !== undefined) {
        patched.status = input.status;
      }
      if (input.payee !== undefined) {
        patched.payee = input.payee;
      }
      if (input.amount !== undefined) {
        patched.amount = input.amount;
      }
      if (input.txnDate !== undefined) {
        patched.txnDate = input.txnDate;
      }
      if (input.memo !== undefined) {
        patched.memo = input.memo;
      }
      if (input.checkNumber !== undefined) {
        patched.checkNumber = input.checkNumber;
      }
      return patched;
    });
  };

  return useMutation({
    mutationFn: async (input: UpdateTransactionInput) => {
      const updates: Record<string, unknown> = {};
      if (input.txnDate !== undefined) {
        updates.txn_date = input.txnDate;
      }
      if (input.payee !== undefined) {
        updates.payee = input.payee;
      }
      if (input.amount !== undefined) {
        updates.amount = input.amount;
      }
      if (input.checkNumber !== undefined) {
        updates.check_number = input.checkNumber;
      }
      if (input.memo !== undefined) {
        updates.memo = input.memo;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }

      const { data, error } = await supabase
        .from('transactions')
        .update(updates)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      if (input.splits !== undefined) {
        await supabase
          .from('transaction_splits')
          .delete()
          .eq('transaction_id', input.id);

        if (input.splits.length > 0) {
          const { error: splitErr } = await supabase
            .from('transaction_splits')
            .insert(
              input.splits.map((s) => ({
                transaction_id: input.id,
                amount: s.amount,
                memo: s.memo,
              }))
            );
          if (splitErr) {
            throw splitErr;
          }
        }
      }

      return mapTransaction(data as DbTransaction);
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: txnKeys(input.accountId) });
      await qc.cancelQueries({ queryKey: ALL_TXNS_KEY });

      const prevAccount = qc.getQueryData<TransactionWithSplits[]>(
        txnKeys(input.accountId)
      );
      const prevAll = qc.getQueryData<TransactionWithSplits[]>(ALL_TXNS_KEY);

      qc.setQueryData<TransactionWithSplits[]>(
        txnKeys(input.accountId),
        (old) => applyOptimistic(old, input)
      );
      qc.setQueryData<TransactionWithSplits[]>(
        ALL_TXNS_KEY,
        (old) => applyOptimistic(old, input)
      );

      return { prevAccount, prevAll };
    },
    onError: (_err, input, context) => {
      if (context?.prevAccount) {
        qc.setQueryData(txnKeys(input.accountId), context.prevAccount);
      }
      if (context?.prevAll) {
        qc.setQueryData(ALL_TXNS_KEY, context.prevAll);
      }
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.accountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['transaction', vars.id] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId: string }) => {
      await supabase.from('transaction_splits').delete().eq('transaction_id', id);
      const { error } = await supabase.from('transactions').delete().eq('id', id);
      if (error) {
        throw error;
      }
      return accountId;
    },
    onSuccess: (accountId) => {
      qc.invalidateQueries({ queryKey: txnKeys(accountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapTransaction, mapTransactionSplit } from '../mappers';
import {
  applyTransactionUpdate,
  type UpdateTransactionInput,
} from '../transactionUpdate';
import type {
  TransactionStatus,
  TransactionWithSplits,
  DbTransaction,
  DbTransactionSplit,
} from '../types';

export type { UpdateTransactionInput } from '../transactionUpdate';

function txnKeys(accountId: string) {
  return ['transactions', accountId];
}

const ALL_TXNS_KEY = ['transactions', '__all__'];

export function useTransactions(accountId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: txnKeys(accountId),
    queryFn: async (): Promise<TransactionWithSplits[]> => {
      const db = await getDb();

      const rows = await db.getAllAsync<DbTransaction>(
        `SELECT * FROM transactions
         WHERE account_id = ? AND _sync_status != 'deleted'
         ORDER BY txn_date DESC, created_at DESC`,
        [accountId]
      );
      const txns = rows.map(mapTransaction);
      if (txns.length === 0) {
        return [];
      }

      const ids = txns.map((t) => t.id);
      const placeholders = ids.map(() => '?').join(',');
      const splitRows = await db.getAllAsync<DbTransactionSplit>(
        `SELECT * FROM transaction_splits
         WHERE transaction_id IN (${placeholders}) AND _sync_status != 'deleted'`,
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

export function useAllTransactions() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ALL_TXNS_KEY,
    queryFn: async (): Promise<TransactionWithSplits[]> => {
      const db = await getDb();

      const rows = await db.getAllAsync<DbTransaction>(
        `SELECT * FROM transactions
         WHERE user_id = ? AND _sync_status != 'deleted'
         ORDER BY txn_date DESC, created_at DESC`,
        [user!.id]
      );
      const txns = rows.map(mapTransaction);
      if (txns.length === 0) {
        return [];
      }

      const ids = txns.map((t) => t.id);
      const placeholders = ids.map(() => '?').join(',');
      const splitRows = await db.getAllAsync<DbTransactionSplit>(
        `SELECT * FROM transaction_splits
         WHERE transaction_id IN (${placeholders}) AND _sync_status != 'deleted'`,
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
      const db = await getDb();

      const row = await db.getFirstAsync<DbTransaction>(
        "SELECT * FROM transactions WHERE id = ? AND _sync_status != 'deleted'",
        [id]
      );
      if (!row) {
        throw new Error('Transaction not found');
      }
      const txn = mapTransaction(row);

      const splitRows = await db.getAllAsync<DbTransactionSplit>(
        "SELECT * FROM transaction_splits WHERE transaction_id = ? AND _sync_status != 'deleted'",
        [id]
      );

      return {
        ...txn,
        splits: splitRows.map(mapTransactionSplit),
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
      const db = await getDb();
      const id = Crypto.randomUUID();
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT INTO transactions
           (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
            status, created_at, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          id, user!.id, input.accountId, input.txnDate, input.payee,
          input.amount, input.checkNumber ?? null, input.memo ?? null,
          input.status ?? 'pending', now, now,
        ]
      );

      if (input.splits && input.splits.length > 0) {
        for (const s of input.splits) {
          await db.runAsync(
            `INSERT INTO transaction_splits
               (id, transaction_id, amount, memo, _sync_status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [Crypto.randomUUID(), id, s.amount, s.memo]
          );
        }
      }

      const row = await db.getFirstAsync<DbTransaction>(
        'SELECT * FROM transactions WHERE id = ?',
        [id]
      );
      requestPush(user!.id);
      return mapTransaction(row!);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.accountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useUpdateTransaction() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const applyOptimistic = (
    old: TransactionWithSplits[] | undefined,
    input: UpdateTransactionInput
  ) => {
    if (!old) {
      return old;
    }
    const primary = old.find((t) => t.id === input.id);
    const linkId = primary?.transferLinkId ?? null;
    return old.map((t) => {
      const isPrimary = t.id === input.id;
      const isLinked =
        !isPrimary && linkId !== null && t.transferLinkId === linkId;
      if (!isPrimary && !isLinked) {
        return t;
      }
      const patched = { ...t };
      if (input.status !== undefined) {
        patched.status = input.status;
      }
      if (input.payee !== undefined && isPrimary) {
        patched.payee = input.payee;
      }
      if (input.amount !== undefined) {
        patched.amount = isPrimary ? input.amount : -input.amount;
      }
      if (input.txnDate !== undefined) {
        patched.txnDate = input.txnDate;
      }
      if (input.memo !== undefined) {
        patched.memo = input.memo;
      }
      if (input.checkNumber !== undefined && isPrimary) {
        patched.checkNumber = input.checkNumber;
      }
      return patched;
    });
  };

  return useMutation({
    mutationFn: async (input: UpdateTransactionInput) => {
      const db = await getDb();
      const result = await applyTransactionUpdate(db, input, {
        now: new Date().toISOString(),
        newSplitId: () => Crypto.randomUUID(),
      });
      requestPush(user!.id);
      return result;
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
      qc.setQueryData<TransactionWithSplits[]>(ALL_TXNS_KEY, (old) =>
        applyOptimistic(old, input)
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
    onSettled: (data, _err, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.accountId) });
      if (data?.linkedAccountId) {
        qc.invalidateQueries({ queryKey: txnKeys(data.linkedAccountId) });
      }
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['transaction', vars.id] });
      if (data?.linkedTransactionId) {
        qc.invalidateQueries({
          queryKey: ['transaction', data.linkedTransactionId],
        });
      }
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useDeleteTransaction() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      accountId,
    }: {
      id: string;
      accountId: string;
    }) => {
      const db = await getDb();
      const now = new Date().toISOString();

      const row = await db.getFirstAsync<{
        transfer_link_id: string | null;
      }>('SELECT transfer_link_id FROM transactions WHERE id = ?', [id]);

      await db.runAsync(
        "UPDATE transaction_splits SET _sync_status = 'deleted' WHERE transaction_id = ?",
        [id]
      );
      await db.runAsync(
        "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = ?",
        [now, id]
      );

      let linkedAccountId: string | null = null;
      if (row?.transfer_link_id) {
        const linked = await db.getFirstAsync<{ id: string; account_id: string }>(
          "SELECT id, account_id FROM transactions WHERE transfer_link_id = ? AND id != ? AND _sync_status != 'deleted'",
          [row.transfer_link_id, id]
        );
        if (linked) {
          linkedAccountId = linked.account_id;
          await db.runAsync(
            "UPDATE transaction_splits SET _sync_status = 'deleted' WHERE transaction_id = ?",
            [linked.id]
          );
          await db.runAsync(
            "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = ?",
            [now, linked.id]
          );
        }
      }

      requestPush(user!.id);
      return { accountId, linkedAccountId };
    },
    onSuccess: ({ accountId, linkedAccountId }) => {
      qc.invalidateQueries({ queryKey: txnKeys(accountId) });
      if (linkedAccountId) {
        qc.invalidateQueries({ queryKey: txnKeys(linkedAccountId) });
      }
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

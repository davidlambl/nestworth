import {
  useQuery,
  useMutation,
  useQueryClient,
  type FetchStatus,
} from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapTransaction, mapTransactionSplit } from '../mappers';
import {
  accountRefusalMessage,
  CREATE_TRANSACTION_SQL,
  readAccountRefusal,
} from '../accountWriteGuard';
import { applyTransactionDelete } from '../transactionDelete';
import {
  applyTransactionUpdate,
  type UpdateTransactionInput,
} from '../transactionUpdate';
import { createTransfer, type CreateTransferInput } from '../transferCreate';
import { QUERY_RETRY } from '../queryRetry';
import { useGoneAnswer } from './useGoneAnswer';
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

      // The signed-in user's rows of the account, never every row filed under
      // it (#177): another account's register, opened by its id, is empty,
      // and its splits are never read (they are read for these rows only).
      const rows = await db.getAllAsync<DbTransaction>(
        `SELECT * FROM transactions
         WHERE account_id = ? AND user_id = ? AND _sync_status != 'deleted'
         ORDER BY txn_date DESC, created_at DESC`,
        [accountId, user!.id]
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

/** What useTransaction's query fails with when the row is not the user's here. */
export const TRANSACTION_NOT_FOUND = 'Transaction not found';

/**
 * Whether a useTransaction error says the signed-in user has no such
 * transaction on this device: deleted here, or gone (a pushed delete, a
 * pulled tombstone, a reset before its re-download), or another account's
 * (#177). Any other error -- a failed read -- is not that, and says nothing
 * about the row.
 */
export function isTransactionNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === TRANSACTION_NOT_FOUND;
}

export function useTransaction(id: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['transaction', id],
    queryFn: async (): Promise<TransactionWithSplits> => {
      const db = await getDb();

      // The signed-in user's, not any row with this id (#177). Several
      // accounts sign in on one device in turn and sign-out wipes no local
      // rows, so another account's transaction is here: its edit screen,
      // reached by its id (the browser's history, a bookmark, a stale deep
      // link), showed that account's payee, amount and memo, and its Save and
      // Delete wrote into that account's row. Another account's row reads as
      // missing, and its splits are never read.
      const row = await db.getFirstAsync<DbTransaction>(
        "SELECT * FROM transactions WHERE id = ? AND user_id = ? AND _sync_status != 'deleted'",
        [id, user!.id]
      );
      if (!row) {
        throw new Error(TRANSACTION_NOT_FOUND);
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
    // Not found is this device's own answer, and a retry a second later
    // reads the same row: the edit screen says so at once instead of after a
    // second's spinner, as useAccount's register does (#163). Any other error
    // keeps the app's retries.
    retry: (failureCount, error) =>
      !isTransactionNotFound(error) && failureCount < QUERY_RETRY,
    enabled: !!user && !!id,
  });
}

/**
 * Whether the edit screen says its transaction is gone (#195): the last
 * answer useTransaction(id) settled on was a not-found, and it is kept while a
 * refetch is in flight (useGoneAnswer, which says why).
 */
export function useTransactionGone(
  id: string,
  query: { error: unknown; fetchStatus: FetchStatus }
): boolean {
  return useGoneAnswer(id, query, isTransactionNotFound);
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

      // Not into an archived account (#76). Its register offers no "+", but a
      // New Transaction screen can still name one: opened before another
      // device archived it, or reached by the browser's history or a stale
      // link. A read of its own, unlike the delete check below: an archive
      // landing between this read and the INSERT lets the row in, which is
      // harmless -- the server takes a row under an archived account like
      // any other, and the register still lists it.
      const archived = await db.getFirstAsync(
        `SELECT 1 FROM accounts
          WHERE id = ? AND user_id = ? AND is_archived = 1
            AND _sync_status IS NOT 'deleted'`,
        [input.accountId, user!.id]
      );
      if (archived) {
        throw new Error(
          'This account is archived, so the transaction was not saved.'
        );
      }

      // Only into a live account (#163): the check is inside the INSERT,
      // so the row goes in only while the account is here and not marked
      // deleted, and nothing can land between the two. A register re-opened
      // on an account this device had deleted (the browser's Forward, a
      // stale link), or on screen when another device deleted it, still
      // offered "+": the row went in 'pending' under the dead account, the
      // server refused it (23503, 005's inherit_account_tombstone), and it
      // stayed pending here forever, shown in no register and counted by the
      // reset guard. Nothing was written when it matches nothing, and no
      // transaction is open here, so it throws at once; the read only picks
      // the words.
      const res = await db.runAsync(CREATE_TRANSACTION_SQL, [
        id,
        user!.id,
        input.accountId,
        input.txnDate,
        input.payee,
        input.amount,
        input.checkNumber ?? null,
        input.memo ?? null,
        input.status ?? 'pending',
        now,
        now,
        input.accountId,
        // And the user's own (#177): the New Transaction screen opened on
        // another user's account id (the browser's history) wrote this user's
        // row under that account, and the server took it. Refused as missing.
        user!.id,
      ]);
      if (res.changes === 0) {
        const [refusal] = await readAccountRefusal(db, user!.id, [
          input.accountId,
        ]);
        throw new Error(
          accountRefusalMessage(
            refusal ?? 'missing',
            'This account',
            'the transaction was not saved'
          )
        );
      }

      if (input.splits && input.splits.length > 0) {
        for (const s of input.splits) {
          await db.runAsync(
            `INSERT INTO transaction_splits
               (id, transaction_id, amount, memo, updated_at, _sync_status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [Crypto.randomUUID(), id, s.amount, s.memo, now]
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
    // Settled, not only succeeded (#163): a refused create came from a
    // screen that still holds a dead account. The register that opened it
    // reads ['account', id], whose refetch now fails with 'Account not
    // found' and shows the account is gone; a list that still shows the
    // account refetches without it.
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.accountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['account', vars.accountId] });
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

      // What the cache stored (structural sharing copies the patched list),
      // for the rollback to recognise.
      const patchedAccount = qc.setQueryData<TransactionWithSplits[]>(
        txnKeys(input.accountId),
        (old) => applyOptimistic(old, input)
      );
      const patchedAll = qc.setQueryData<TransactionWithSplits[]>(
        ALL_TXNS_KEY,
        (old) => applyOptimistic(old, input)
      );

      return { prevAccount, prevAll, patchedAccount, patchedAll };
    },
    // Undoes only what this edit put in the cache. The edit can settle after
    // the account changed -- queued behind another transaction on the shared
    // connection (#110) -- and the list cached by then is the next account's,
    // which a rollback would have replaced with this account's rows (#177).
    onError: (_err, input, context) => {
      if (
        context?.prevAccount &&
        qc.getQueryData(txnKeys(input.accountId)) === context.patchedAccount
      ) {
        qc.setQueryData(txnKeys(input.accountId), context.prevAccount);
      }
      if (
        context?.prevAll &&
        qc.getQueryData(ALL_TXNS_KEY) === context.patchedAll
      ) {
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
      // One SQLite transaction: marked separately, an interruption could
      // leave the splits deleted under a live parent (#97).
      const { linkedAccountId } = await applyTransactionDelete(db, id, {
        now: new Date().toISOString(),
      });
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

export type CreateTransferArgs = Omit<CreateTransferInput, 'userId'>;

export function useCreateTransfer() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateTransferArgs) => {
      const db = await getDb();
      const result = await createTransfer(
        db,
        { ...input, userId: user!.id },
        { now: new Date().toISOString(), newId: () => Crypto.randomUUID() }
      );
      requestPush(user!.id);
      return result;
    },
    // Settled, not only succeeded: a transfer refused because one of its
    // accounts is dead (#163) refetches what still shows that account, as
    // useCreateTransaction does.
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: txnKeys(vars.fromAccountId) });
      qc.invalidateQueries({ queryKey: txnKeys(vars.toAccountId) });
      qc.invalidateQueries({ queryKey: ALL_TXNS_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['account', vars.fromAccountId] });
      qc.invalidateQueries({ queryKey: ['account', vars.toAccountId] });
    },
  });
}

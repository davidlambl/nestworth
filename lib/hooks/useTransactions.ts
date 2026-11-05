import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
  type FetchStatus,
  type InfiniteData,
  type Query,
  type QueryClient,
  type QueryKey,
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
import {
  countInTotals,
  matchesSearch,
  matchesStatus,
  searchQuery,
  type RegisterPages,
} from '../register';
import {
  readAllAccountsPage,
  readRegisterPage,
  readTransactionHints,
  type RegisterCursor,
  type RegisterFilter,
  type RegisterPage,
  type RegisterRow,
} from '../registerRead';
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

/**
 * A register's pages in the cache (#28): under its account's key, so every
 * write's and every sync's invalidation (lib/query.tsx ends each sync with
 * invalidateQueries()) refetches the pages it has loaded, each from the
 * cursor the page before it now ends at.
 */
const REGISTER = 'register';

type RegisterData = InfiniteData<RegisterPage, RegisterCursor | null>;

function registerKey(base: string[], filter: RegisterFilter): QueryKey {
  return [...base, REGISTER, filter.status, filter.search];
}

function filterOfKey(key: QueryKey): RegisterFilter {
  return {
    status: key[3] as RegisterFilter['status'],
    search: key[4] as string,
  };
}

/** The loaded pages as the screens read them: the rows in order, and the totals. */
function selectPages(data: RegisterData): RegisterPages {
  return {
    rows: data.pages.flatMap((p) => p.rows),
    totals: data.pages[0]?.totals ?? {},
  };
}

/**
 * While a new status chip or a new search reads its first page, the rows the
 * register showed stay on screen: without them the screen would swap the
 * register for its spinner at every keystroke and take the search box with
 * it. Only the same register's rows, and only while their query is still
 * the cached one: a change of account removes every query (#177), and the
 * next account's register must not be handed the last one's rows.
 */
function keepPreviousFilter(qc: QueryClient, register: string) {
  return (
    previous: RegisterData | undefined,
    previousQuery: Query<RegisterData, Error, RegisterData> | undefined
  ): RegisterData | undefined =>
    previousQuery !== undefined &&
    previousQuery.queryKey[1] === register &&
    qc.getQueryCache().get(previousQuery.queryHash) === previousQuery
      ? previous
      : undefined;
}

/**
 * The next page, for the list's onEndReached. A sync's or a write's refetch
 * of the loaded pages may be in flight: fetchNextPage's default
 * (cancelRefetch) would cancel it and append to the pages it was replacing,
 * which TanStack then counts as fresh. So the refetch is joined instead, and
 * the page asked for again once it is done -- the list calls onEndReached
 * once per content length, and a refetch that keeps the length would not
 * call it again.
 */
function loadMoreOf(
  fetchNextPage: (options: {
    cancelRefetch: boolean;
  }) => Promise<{ hasNextPage: boolean; data?: RegisterPages }>,
  rowsNow: number
): () => Promise<void> {
  return async () => {
    let loaded = rowsNow;
    for (let tries = 0; tries < 3; tries++) {
      const result = await fetchNextPage({ cancelRefetch: false });
      const rows = result.data?.rows.length ?? 0;
      if (!result.hasNextPage || rows > loaded) return;
      loaded = rows;
    }
  };
}

/**
 * An account's register a page at a time (#28): the signed-in user's rows of
 * the account (#177), newest first, filtered by the status chips and the
 * search box in SQLite (lib/registerRead.ts); the first page brings the
 * totals its summary and its running balance start from (registerView).
 */
export function useRegister(accountId: string, filter: RegisterFilter) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: registerKey(txnKeys(accountId), filter),
    queryFn: async ({ pageParam, signal }) =>
      readRegisterPage(await getDb(), {
        userId: user!.id,
        accountId,
        filter,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as RegisterCursor | null,
    getNextPageParam: (last) => last.next,
    select: selectPages,
    placeholderData: keepPreviousFilter(qc, accountId),
    enabled: !!user && !!accountId,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    loadMore: loadMoreOf(query.fetchNextPage, query.data?.rows.length ?? 0),
  };
}

/**
 * All Accounts a page at a time (#28): the rows of every account of the
 * user's that is not archived, and the first page with every account's
 * totals (allAccountsView keeps the ones the net balance counts).
 */
export function useAllAccountsRegister(filter: RegisterFilter) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: registerKey(ALL_TXNS_KEY, filter),
    queryFn: async ({ pageParam, signal }) =>
      readAllAccountsPage(await getDb(), {
        userId: user!.id,
        filter,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as RegisterCursor | null,
    getNextPageParam: (last) => last.next,
    select: selectPages,
    placeholderData: keepPreviousFilter(qc, ALL_TXNS_KEY[1]),
    enabled: !!user,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    loadMore: loadMoreOf(query.fetchNextPage, query.data?.rows.length ?? 0),
  };
}

/**
 * What the New Transaction form offers (#28): the account's past payees and
 * its next check number, from two narrow reads (readTransactionHints)
 * instead of the whole register. Under the account's key, so a save there
 * refetches it.
 */
export function useTransactionHints(accountId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: [...txnKeys(accountId), 'hints'],
    queryFn: async () =>
      readTransactionHints(await getDb(), user!.id, accountId),
    enabled: !!user && !!accountId,
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

/** One row as an edit patches it on screen before the write lands. */
function patchRow(
  t: RegisterRow,
  input: UpdateTransactionInput,
  isPrimary: boolean
): RegisterRow {
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
}

/** Moves a row's amount into, or out of, its account's totals. */
function countRow(
  totals: NonNullable<RegisterPage['totals']>,
  t: RegisterRow,
  sign: 1 | -1
): void {
  const sums = totals[t.accountId];
  if (!sums) return;
  totals[t.accountId] = countInTotals(sums, t, sign);
}

/**
 * A register's loaded pages with an edit applied (#28): the edited row and
 * its transfer's other leg patched where they are listed, taken off the
 * list if the register's filter no longer keeps them (a row ticked Cleared
 * leaves Pending at once, as it did when the screen filtered the whole
 * list), and the first page's totals moved with them, so the summary and
 * the balances follow. A row on a page not loaded is the refetch's.
 */
function patchRegister(
  old: RegisterData,
  input: UpdateTransactionInput,
  filter: RegisterFilter
): RegisterData {
  let primary: RegisterRow | undefined;
  for (const page of old.pages) {
    primary = page.rows.find((t) => t.id === input.id);
    if (primary) break;
  }
  if (!primary) return old;
  const linkId = primary.transferLinkId ?? null;
  const q = searchQuery(filter.search);
  const changes: { before: RegisterRow; after: RegisterRow }[] = [];
  const pages = old.pages.map((page) => {
    if (
      !page.rows.some(
        (t) =>
          t.id === input.id || (linkId !== null && t.transferLinkId === linkId)
      )
    ) {
      return page;
    }
    const rows: RegisterRow[] = [];
    for (const t of page.rows) {
      const isPrimary = t.id === input.id;
      const isLinked =
        !isPrimary && linkId !== null && t.transferLinkId === linkId;
      if (!isPrimary && !isLinked) {
        rows.push(t);
        continue;
      }
      const after = patchRow(t, input, isPrimary);
      changes.push({ before: t, after });
      if (
        matchesStatus(after, filter.status) &&
        (q === null || matchesSearch(after, q, after.accountName))
      ) {
        rows.push(after);
      }
    }
    return { ...page, rows };
  });
  const first = pages[0];
  if (first?.totals) {
    const totals = { ...first.totals };
    for (const { before, after } of changes) {
      countRow(totals, before, -1);
      countRow(totals, after, 1);
    }
    pages[0] = { ...first, totals };
  }
  return { ...old, pages };
}

export function useUpdateTransaction() {
  const { user } = useAuth();
  const qc = useQueryClient();

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

      // Every register this edit shows in: the account's, under each filter
      // it was opened with, and All Accounts'. What the cache stored
      // (structural sharing copies the patched pages), for the rollback to
      // recognise.
      const patched: {
        key: QueryKey;
        prev: RegisterData;
        stored: RegisterData | undefined;
      }[] = [];
      for (const [key, prev] of [
        ...qc.getQueriesData<RegisterData>({
          queryKey: [...txnKeys(input.accountId), REGISTER],
        }),
        ...qc.getQueriesData<RegisterData>({
          queryKey: [...ALL_TXNS_KEY, REGISTER],
        }),
      ]) {
        if (!prev) continue;
        const next = patchRegister(prev, input, filterOfKey(key));
        if (next === prev) continue;
        patched.push({
          key,
          prev,
          stored: qc.setQueryData<RegisterData>(key, next),
        });
      }

      return { patched };
    },
    // Undoes only what this edit put in the cache. The edit can settle after
    // the account changed -- queued behind another transaction on the shared
    // connection (#110) -- and the pages cached by then are the next
    // account's, which a rollback would have replaced with this account's
    // rows (#177).
    onError: (_err, _input, context) => {
      for (const { key, prev, stored } of context?.patched ?? []) {
        if (qc.getQueryData(key) === stored) {
          qc.setQueryData(key, prev);
        }
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

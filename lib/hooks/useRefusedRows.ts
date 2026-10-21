import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { refreshSyncState } from '../syncStatus';
import {
  applyRefusedRowDiscard,
  applyRefusedRowMove,
} from '../refusedRowActions';
import type { RefusedRow } from '../syncRefusals';

// Move or discard a row the push can never upload as it is (#115), from the
// list Settings opens (app/unsynced.tsx). Both write only to SQLite, so they
// run whatever the connection says ('always': TanStack would otherwise hold
// them while offline, and the tap would seem to do nothing); the push they
// request runs when it can, as every write's does.

/** The screens a moved or discarded row was, or now is, part of. */
function refetch(qc: QueryClient, row: RefusedRow, accountId?: string) {
  if (row.table === 'recurring_rules') {
    qc.invalidateQueries({ queryKey: ['recurring_rules'] });
    return;
  }
  for (const id of new Set([row.accountId, accountId])) {
    if (id) {
      qc.invalidateQueries({ queryKey: ['transactions', id] });
    }
  }
  qc.invalidateQueries({ queryKey: ['transactions', '__all__'] });
  qc.invalidateQueries({ queryKey: ['transaction', row.id] });
  // Balances, and Reports, which counts every transaction of the user's.
  qc.invalidateQueries({ queryKey: ['accounts'] });
  qc.invalidateQueries({ queryKey: ['reports'] });
}

export function useMoveRefusedRow() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['refused-rows', 'move'],
    networkMode: 'always',
    mutationFn: async ({
      row,
      accountId,
    }: {
      row: RefusedRow;
      accountId: string;
    }) => {
      const db = await getDb();
      // Throws, writing nothing and requesting no push, when the row or the
      // account is no longer what the list showed.
      await applyRefusedRowMove(
        db,
        {
          table: row.table,
          id: row.id,
          updatedAt: row.updatedAt,
          userId: user!.id,
        },
        accountId,
        { now: new Date().toISOString() }
      );
      requestPush(user!.id);
    },
    // Settled, not only succeeded: a refused move must refetch too, or the
    // list keeps a row that changed. The list and the counts come from the
    // sync status, which requestPush refreshes only once its push is over.
    onSettled: (_data, _error, { row, accountId }) => {
      refetch(qc, row, accountId);
      void refreshSyncState(user!.id);
    },
  });
}

export function useDiscardRefusedRow() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ['refused-rows', 'discard'],
    networkMode: 'always',
    mutationFn: async (row: RefusedRow) => {
      const db = await getDb();
      const marked = await applyRefusedRowDiscard(
        db,
        {
          table: row.table,
          id: row.id,
          updatedAt: row.updatedAt,
          userId: user!.id,
        },
        { now: new Date().toISOString() }
      );
      // Nothing to send when it was already gone.
      if (marked) {
        requestPush(user!.id);
      }
    },
    onSettled: (_data, _error, row) => {
      refetch(qc, row);
      void refreshSyncState(user!.id);
    },
  });
}

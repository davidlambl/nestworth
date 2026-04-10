import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import {
  upsertRemoteAccount,
  upsertRemoteTransaction,
} from '../sync';
import { getDb } from '../db';

export function useRealtimeSync() {
  const { user } = useAuth();
  const qc = useQueryClient();

  useEffect(() => {
    if (!user) {
      return;
    }

    const channel = supabase
      .channel('db-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'accounts',
          filter: `user_id=eq.${user.id}`,
        },
        async (payload) => {
          try {
            const db = await getDb();
            if (payload.eventType === 'DELETE') {
              const id = (payload.old as any)?.id;
              if (id) {
                await db.runAsync('DELETE FROM accounts WHERE id = ?', [id]);
              }
            } else if (payload.new) {
              await upsertRemoteAccount(db, payload.new);
            }
          } catch (e) {
            console.warn('[realtime] account sync error:', e);
          }
          qc.invalidateQueries({ queryKey: ['accounts'] });
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `user_id=eq.${user.id}`,
        },
        async (payload) => {
          try {
            const db = await getDb();
            if (payload.eventType === 'DELETE') {
              const id = (payload.old as any)?.id;
              if (id) {
                await db.runAsync(
                  'DELETE FROM transaction_splits WHERE transaction_id = ?',
                  [id]
                );
                await db.runAsync('DELETE FROM transactions WHERE id = ?', [
                  id,
                ]);
              }
            } else if (payload.new) {
              await upsertRemoteTransaction(db, payload.new);
            }
          } catch (e) {
            console.warn('[realtime] transaction sync error:', e);
          }
          qc.invalidateQueries({ queryKey: ['accounts'] });
          qc.invalidateQueries({ queryKey: ['transactions', '__all__'] });
          const accountId =
            (payload.new as any)?.account_id ??
            (payload.old as any)?.account_id;
          if (accountId) {
            qc.invalidateQueries({
              queryKey: ['transactions', accountId],
            });
          }
          const txnId =
            (payload.new as any)?.id ?? (payload.old as any)?.id;
          if (txnId) {
            qc.invalidateQueries({ queryKey: ['transaction', txnId] });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transaction_splits',
        },
        () => {
          qc.invalidateQueries({ queryKey: ['transactions'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, qc]);
}

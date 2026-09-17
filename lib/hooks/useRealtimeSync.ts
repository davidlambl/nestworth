import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { getDb } from '../db';
import { applyAccountEvent, applyTransactionEvent } from '../realtimeHandlers';

export function useRealtimeSync() {
  const { user } = useAuth();
  const qc = useQueryClient();
  // Keyed on the id, not the object: auth-js emits a fresh User per auth event,
  // and re-subscribing the channel on each one is wasted work (supabase-js
  // forwards refreshed tokens to realtime itself).
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
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
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          try {
            const db = await getDb();
            await applyAccountEvent(db, payload);
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
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          try {
            const db = await getDb();
            await applyTransactionEvent(db, payload);
          } catch (e) {
            console.warn('[realtime] transaction sync error:', e);
          }
          qc.invalidateQueries({ queryKey: ['accounts'] });
          qc.invalidateQueries({ queryKey: ['transactions', '__all__'] });
          // Read from `new` first, `old` second: a tombstone is an UPDATE, so
          // the ids needed to invalidate the deleted row's caches are on `new`
          // even though the row is now gone locally.
          const accountId =
            (payload.new as any)?.account_id ??
            (payload.old as any)?.account_id;
          if (accountId) {
            qc.invalidateQueries({
              queryKey: ['transactions', accountId],
            });
          }
          const txnId = (payload.new as any)?.id ?? (payload.old as any)?.id;
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
  }, [userId, qc]);
}

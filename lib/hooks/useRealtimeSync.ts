import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { getDb } from '../db';
import { fullSync, needsInitialPull, refreshSplitsFromServer } from '../sync';
import {
  applyAccountEvent,
  applyRuleEvent,
  applyTransactionEvent,
  splitEventParent,
} from '../realtimeHandlers';
import {
  createInvalidationBatcher,
  createSplitRefresher,
} from '../realtimeBatch';

// A topic of its own for every subscription. realtime-js hands back the
// channel already holding a topic, and the socket routes each message by
// topic: under one fixed name, the subscription made in the commit that
// removes the previous one (a sign-in straight over another account, #177)
// took the old topic, and what the server still sent the old account reached
// every listener of the new one, whose bindings match any change until their
// join is answered -- a rule written as a transaction, a transaction as a
// rule (#21).
let subscriptions = 0;

/**
 * A pull after the channel came back (#21): Realtime sends nothing again for
 * the time a channel was down, so whatever changed elsewhere meanwhile waits
 * for a sync, and a dropped socket alone starts none (the app syncs on
 * launch, on returning to the foreground and on reconnecting to the network).
 * Not before this device's first download, which the startup sequence runs,
 * nor once the subscription is torn down (a sign-out, another account signed
 * in): a sync for the user who has gone would push and pull with no session
 * or another's. One already out at teardown, or waiting then for another
 * account's sync to release the lock, runs to its end and refreshes no list.
 */
async function syncAfterRejoin(
  userId: string,
  isStopped: () => boolean,
  invalidateAll: () => void
): Promise<void> {
  try {
    if (await needsInitialPull(userId)) return;
    if (isStopped()) return;
    await fullSync(userId);
    if (!isStopped()) invalidateAll();
  } catch (e) {
    console.warn('[realtime] sync after the channel came back failed:', e);
  }
}

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

    // Each event's row is written as it arrives; what a burst shares is its
    // refetches and its split reads, held for a moment and run once
    // (lib/realtimeBatch.ts, #21).
    const invalidations = createInvalidationBatcher((queryKey) => {
      qc.invalidateQueries({ queryKey });
    });
    const splits = createSplitRefresher(async (parentIds) => {
      const db = await getDb();
      const { changed } = await refreshSplitsFromServer(db, userId, parentIds);
      for (const parent of changed) {
        invalidations.add(
          ['transactions', parent.accountId],
          ['transactions', '__all__'],
          ['transaction', parent.id]
        );
      }
    });

    let stopped = false;
    let lost = false;
    const channel = supabase
      .channel(`db-changes-${++subscriptions}`)
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
          // A register open on the account reads ['account', id]. A delete
          // made on another device arrives as a tombstone that removes the
          // account here, and only this refetch tells the register: it then
          // fails with 'Account not found', and the register says the account
          // is gone instead of offering "+" and the transfer button (#163).
          const accountId =
            (payload.new as any)?.id ?? (payload.old as any)?.id;
          invalidations.add(
            ['accounts'],
            ...(accountId ? [['account', accountId]] : [])
          );
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
          // Read from `new` first, `old` second: a tombstone is an UPDATE, so
          // the ids needed to invalidate the deleted row's caches are on `new`
          // even though the row is now gone locally.
          const accountId =
            (payload.new as any)?.account_id ??
            (payload.old as any)?.account_id;
          const txnId = (payload.new as any)?.id ?? (payload.old as any)?.id;
          invalidations.add(
            ['accounts'],
            ['transactions', '__all__'],
            ...(accountId ? [['transactions', accountId]] : []),
            ...(txnId ? [['transaction', txnId]] : [])
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          // No filter: the table has no user_id (a split rides its parent).
          // See splitEventParent for what reaches this listener and what is
          // dropped. Nothing is refetched here: the refresh refetches the
          // parents whose set it rewrote.
          table: 'transaction_splits',
        },
        async (payload) => {
          try {
            const db = await getDb();
            const parentId = await splitEventParent(db, userId, payload);
            if (parentId) {
              splits.schedule(parentId);
            }
          } catch (e) {
            console.warn('[realtime] split sync error:', e);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'recurring_rules',
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          try {
            const db = await getDb();
            await applyRuleEvent(db, payload);
          } catch (e) {
            console.warn('[realtime] rule sync error:', e);
          }
          invalidations.add(['recurring_rules']);
        }
      )
      .subscribe((status) => {
        // Our own removeChannel reports CLOSED too, after `stopped` is set.
        if (stopped) return;
        // realtime-js rejoins a channel after an error or a timeout, never
        // after the server closed it: that one is only logged.
        if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          if (!lost) {
            console.warn(
              `[realtime] channel ${status}; changes made elsewhere meanwhile come with the next sync`
            );
          }
          lost = true;
        } else if (status === 'SUBSCRIBED' && lost) {
          lost = false;
          void syncAfterRejoin(
            userId,
            () => stopped,
            () => qc.invalidateQueries()
          );
        }
      });

    return () => {
      stopped = true;
      invalidations.cancel();
      splits.cancel();
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);
}

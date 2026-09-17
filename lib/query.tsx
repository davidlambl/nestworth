import React, { useEffect } from 'react';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import { useAuth } from './auth';
import { fullSync, startSyncSession } from './sync';
import { setLastError, setOnline } from './syncStatus';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const queryClient = new QueryClient({
  // Every mutation in the app writes to SQLite first and none has an onError
  // of its own, and Alert.alert is a no-op on react-native-web. Without a
  // cache-level handler a rejected save produced no console line and no UI
  // change at all: the row kept its old value and nothing said why (#55).
  mutationCache: new MutationCache({
    onMutate: (variables, mutation) => {
      if (__DEV__) {
        console.log(
          '[mutation] start',
          mutation.options.mutationKey ?? '(no key)',
          variables
        );
      }
    },
    onError: (error, variables, _onMutateResult, mutation) => {
      // Variables carry amounts, payees, memos and account ids, so they reach
      // the console (the browser, the Electron log, the device log) only in
      // development. The key and the error are enough to say what failed.
      if (__DEV__) {
        console.error(
          '[mutation] failed',
          mutation.options.mutationKey ?? '(no key)',
          variables,
          error
        );
      } else {
        console.error(
          '[mutation] failed',
          mutation.options.mutationKey ?? '(no key)',
          error
        );
      }
      // The sync indicator is the one channel that renders on every platform.
      // The next sync start clears it.
      setLastError(`Save failed: ${describeError(error)}`);
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error('[query] failed', query.queryKey, error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

const isClient = Platform.OS !== 'web' || typeof window !== 'undefined';

if (isClient) {
  onlineManager.setEventListener((setRqOnline) => {
    return NetInfo.addEventListener((state) => {
      const connected = !!state.isConnected;
      setRqOnline(connected);
      setOnline(connected);
    });
  });
}

function useSyncEngine() {
  const { user } = useAuth();
  // auth-js hands out a fresh User object on every auth event (INITIAL_SESSION,
  // SIGNED_IN, TOKEN_REFRESHED, ...). Keyed on the object, this effect was torn
  // down and re-run mid-bootstrap on nearly every launch: the re-run's own
  // initialPull and fullSync found the lock held and returned, the original
  // run saw `cancelled` and skipped its follow-up sync, and anything created
  // during the bootstrap stayed `pending` until the next AppState/NetInfo
  // event (#55). The id is the identity.
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      return;
    }
    let cancelled = false;
    let bootstrapped = false;
    const invalidate = () => {
      if (!cancelled) {
        queryClient.invalidateQueries();
      }
    };

    startSyncSession(userId, {
      onBootstrapped: () => {
        bootstrapped = true;
        invalidate();
      },
      isCancelled: () => cancelled,
    })
      .then(invalidate)
      .catch((e) => console.error('[sync] startup sequence failed:', e));

    // Background triggers wait for the bootstrap. NetInfo emits its current
    // state the moment a listener is added, and a full sync before the
    // bootstrap would be an accidental one.
    const trigger = () => {
      if (!bootstrapped || cancelled) {
        return;
      }
      fullSync(userId)
        .then(invalidate)
        .catch((e) => console.error('[sync] background sync failed:', e));
    };
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        trigger();
      }
    });
    const netInfoUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        trigger();
      }
    });

    return () => {
      cancelled = true;
      appStateSub.remove();
      netInfoUnsub();
    };
  }, [userId]);
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useSyncEngine();
  return <>{children}</>;
}

export { queryClient };

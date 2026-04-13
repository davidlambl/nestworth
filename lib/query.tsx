import React, { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import { useAuth } from './auth';
import { fullSync, initialPull, needsInitialPull } from './sync';
import { getDb } from './db';

const queryClient = new QueryClient({
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
  onlineManager.setEventListener((setOnline) => {
    return NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected);
    });
  });
}

function useSyncEngine() {
  const { user } = useAuth();
  const initializedRef = useRef(false);

  useEffect(() => {
    initializedRef.current = false;

    if (!user) {
      return;
    }

    let cancelled = false;

    const init = async () => {
      await getDb();

      if (await needsInitialPull(user.id)) {
        try {
          await initialPull(user.id);
        } catch (e) {
          console.warn('[sync] initial pull failed:', e);
        }
      }

      queryClient.invalidateQueries();
      initializedRef.current = true;

      if (!cancelled) {
        try {
          await fullSync(user.id);
        } catch (e) {
          console.warn('[sync] initial full sync failed:', e);
        }

        queryClient.invalidateQueries();
      }
    };

    init();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && user && initializedRef.current) {
        fullSync(user.id).then(() => {
          queryClient.invalidateQueries();
        }).catch(() => {});
      }
    });

    const netInfoUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected && user && initializedRef.current) {
        fullSync(user.id).then(() => {
          queryClient.invalidateQueries();
        }).catch(() => {});
      }
    });

    return () => {
      cancelled = true;
      appStateSub.remove();
      netInfoUnsub();
    };
  }, [user]);
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useSyncEngine();
  return <>{children}</>;
}

export { queryClient };

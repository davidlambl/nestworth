import React from 'react';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 2,
      networkMode: 'offlineFirst',
    },
    mutations: {
      networkMode: 'offlineFirst',
      retry: 3,
    },
  },
});

function useAppStateRefetch() {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        queryClient.invalidateQueries();
      }
    });
    return () => subscription.remove();
  }, []);
}

function useOnlineManager() {
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const setOnline = () => onlineManager.setOnline(true);
      const setOffline = () => onlineManager.setOnline(false);
      window.addEventListener('online', setOnline);
      window.addEventListener('offline', setOffline);
      onlineManager.setOnline(navigator.onLine);
      return () => {
        window.removeEventListener('online', setOnline);
        window.removeEventListener('offline', setOffline);
      };
    }
  }, []);
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  useAppStateRefetch();
  useOnlineManager();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export { queryClient };

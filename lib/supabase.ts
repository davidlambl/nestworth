import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

const isSSR = typeof window === 'undefined';

interface SimpleStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

const noopStorage: SimpleStorage = {
  getItem: () => Promise.resolve(null),
  setItem: () => Promise.resolve(),
  removeItem: () => Promise.resolve(),
};

let resolved: SimpleStorage | undefined;

async function resolve(): Promise<SimpleStorage> {
  if (resolved) {
    return resolved;
  }
  if (isSSR) {
    resolved = noopStorage;
  } else {
    const mod = await import('@react-native-async-storage/async-storage');
    resolved = mod.default as unknown as SimpleStorage;
  }
  return resolved;
}

const lazyStorage: SimpleStorage = {
  getItem: (key) => resolve().then((s) => s.getItem(key)),
  setItem: (key, value) => resolve().then((s) => s.setItem(key, value)),
  removeItem: (key) => resolve().then((s) => s.removeItem(key)),
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: lazyStorage,
    autoRefreshToken: true,
    persistSession: !isSSR,
    detectSessionInUrl: !isSSR && Platform.OS === 'web',
  },
});

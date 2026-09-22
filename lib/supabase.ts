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
  /**
   * Every request gets an upper bound (#67). Before this, nothing in the app had
   * one: a stalled socket — the phone holding a dead connection open after a
   * network change, where no packet ever comes back and no error is raised —
   * left the sync engine waiting forever, and with it everything that awaits the
   * sync lock (Sync now, "Sync & Sign Out", the startup bootstrap).
   *
   * Three properties this option is chosen for:
   *
   *   - **PostgREST only.** supabase-js hands `db.timeout` to `this.rest` alone,
   *     so auth, Storage, Realtime and Functions are untouched. A `global.fetch`
   *     wrapper would bound them all, and two of those are wrong to bound here:
   *     `supabase.auth.signOut()` would become rejectable, and neither
   *     lib/promptSignOut.ts nor lib/auth.tsx catches it, so a timed-out sign-out
   *     would skip the navigation to the sign-in screen; and receipt uploads have
   *     no size ceiling (lib/hooks/useReceiptPhoto.ts compresses but does not
   *     cap), so a large photo on a slow uplink would be aborted mid-flight.
   *   - It merges a caller's own AbortSignal rather than replacing it, so
   *     `.abortSignal()` keeps working if anything needs it later.
   *   - **It bounds one request, not one sync.** A push of N rows is N requests
   *     and can still take N timeouts; a user-visible wait has to be bounded
   *     separately (SIGN_OUT_SYNC_DEADLINE_MS in lib/promptSignOut.ts).
   *
   * A timed-out request arrives as `{ error }` with an "AbortError: …" message,
   * not a throw, so every existing error path already handles it (the two
   * user-facing ones go through lib/requestError.ts).
   *
   * Keep the value far above the slowest deliberate stall in the test suite:
   * e2e/web/accounts-first-sync.spec.ts holds the transactions read open for
   * 2500 ms to reproduce #55, and a timeout near that would abort it.
   */
  db: { timeout: 30_000 },
});

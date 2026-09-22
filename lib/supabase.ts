import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { withAuthTokenTimeout } from './fetchWithTimeout';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * One deadline for both halves of a request — the token refresh and the read
 * itself — so a stalled network costs at most two of these, not forever. See the
 * `db` and `global` comments below for what each one covers.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Called, not passed by reference: `fetch` is resolved at call time (React
 * Native installs the global during startup) and invoked unbound, which is how
 * supabase-js calls it too.
 */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

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
   * Bounds the PostgREST **socket read**: once the request is in flight,
   * postgrest-js aborts it after this long (#67). Before it, nothing in the app
   * had a timeout at all, so a stalled socket — the phone holding a dead
   * connection open after a network change, where no packet comes back and no
   * error is raised — left the sync engine waiting forever, and with it
   * everything that awaits the sync lock (Sync now, the startup bootstrap,
   * "Sync & Sign Out").
   *
   * It is deliberately scoped to PostgREST: supabase-js hands `db.timeout` to
   * `this.rest` alone, so auth, Storage, Realtime and Functions keep their old
   * behaviour. It also merges a caller's own AbortSignal rather than replacing
   * it, and it bounds **one request, not one sync** — a push of N rows is N
   * requests and can still cost N timeouts, which is why the wait a user
   * actually watches is bounded separately (SIGN_OUT_SYNC_DEADLINE_MS in
   * lib/promptSignOut.ts).
   *
   * A timed-out request arrives as `{ error }` with an "AbortError: …" message,
   * not a throw, so every existing error path already handles it; the ones whose
   * message reaches a user go through lib/requestError.ts.
   *
   * Keep the value far above the slowest deliberate stall in the test suite:
   * e2e/web/accounts-first-sync.spec.ts holds the transactions read open for
   * 2500 ms to reproduce #55, and a timeout near that would abort it.
   */
  db: { timeout: REQUEST_TIMEOUT_MS },
  /**
   * Bounds the **token refresh that precedes** each of those requests, which
   * `db.timeout` cannot reach (#67 review finding 2).
   *
   * postgrest-js arms its AbortController and then calls supabase-js's authed
   * fetch, which does `await getAccessToken()` *before* the platform fetch
   * exists. On an expired token that await is a
   * `POST /auth/v1/token?grant_type=refresh_token` on auth-js's own fetch, which
   * carries no signal — so when the controller fires there is nothing to cancel
   * and the request stays pending indefinitely. Tokens are found expired exactly
   * when a connection has gone dead, so this is the same #67 scenario, not an
   * exotic one.
   *
   * The wrapper touches `/auth/v1/token` and nothing else. Two endpoints stay
   * unbounded on purpose:
   *
   *   - `/auth/v1/logout` — a rejectable `supabase.auth.signOut()` would skip the
   *     navigation to the sign-in screen, because neither lib/promptSignOut.ts
   *     nor lib/auth.tsx catches it.
   *   - Storage uploads — receipts have no size ceiling
   *     (lib/hooks/useReceiptPhoto.ts compresses but does not cap), so a large
   *     photo on a slow uplink would be aborted mid-flight.
   *
   * `/auth/v1/token` also serves password sign-in (`grant_type=password`), so
   * sign-in is bounded by the same deadline. That is intended: a sign-in that
   * hangs forever behind a dead connection is the same bug with a different
   * screen.
   */
  global: { fetch: withAuthTokenTimeout(platformFetch, REQUEST_TIMEOUT_MS) },
});

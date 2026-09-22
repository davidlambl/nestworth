/**
 * Bounds the ONE request `db.timeout` cannot reach: the token refresh that runs
 * before every PostgREST call (#67 review finding 2).
 *
 * supabase-js builds its authed fetch as `await getAccessToken()` and only then
 * calls the timed fetch (`fetchWithAuth`). postgrest-js arms its AbortController
 * around that whole wrapper, but nothing is listening to the signal while the
 * token promise is pending, so an expired token whose
 * `POST /auth/v1/token?grant_type=refresh_token` stalls leaves the request — and
 * the sync lock behind it — hanging forever. That is precisely the case #67
 * names, because a dead connection after a network change is also when tokens
 * are found expired.
 *
 * Deliberately narrow: only `/auth/v1/token` is bounded. Everything else is
 * passed through with the caller's own `input` and `init` untouched, so
 * `/auth/v1/logout` stays unbounded (a rejectable `signOut()` would skip the
 * navigation to the sign-in screen — lib/auth.tsx has no catch) and Storage
 * uploads stay unbounded (receipts have no size ceiling). PostgREST passes
 * through here too; `db.timeout` in lib/supabase.ts is what bounds it.
 *
 * A leaf on purpose: it imports nothing.
 */

/** The URL a fetch argument refers to, for a string, a URL or a Request. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  // A Request carries `.url`; a URL has no `.url` and stringifies to its href.
  const asRequest = input as Request;
  return typeof asRequest.url === 'string' ? asRequest.url : String(input);
}

function isAuthTokenRequest(input: RequestInfo | URL): boolean {
  const raw = urlOf(input);
  try {
    return new URL(raw).pathname.includes('/auth/v1/token');
  } catch {
    // Not absolute. supabase-js always passes an absolute URL, but a fetch
    // polyfill could hand us a path; compare without the query either way.
    return raw.split('?')[0].includes('/auth/v1/token');
  }
}

function abortError(ms: number): Error {
  const err = new Error(`Auth token request aborted after ${ms}ms`);
  // auth-js turns any non-Response throw into a retryable AuthRetryableFetchError,
  // and the name is what marks this as a timeout everywhere else in the app
  // (lib/requestError.ts).
  err.name = 'AbortError';
  return err;
}

export function withAuthTokenTimeout(
  baseFetch: typeof fetch,
  ms: number
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isAuthTokenRequest(input)) {
      // Same arguments, no signal added: anything but the token endpoint must
      // behave exactly as it did before this wrapper existed.
      return baseFetch(input, init);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    // Merge the caller's signal rather than replacing it, so an abort it owns
    // still cancels the request.
    const incoming = init?.signal;
    let detachIncoming: (() => void) | undefined;
    if (incoming) {
      if (incoming.aborted) {
        controller.abort();
      } else {
        const onIncomingAbort = () => controller.abort();
        incoming.addEventListener('abort', onIncomingAbort, { once: true });
        detachIncoming = () =>
          incoming.removeEventListener('abort', onIncomingAbort);
      }
    }

    // Race the abort rather than trusting the platform fetch to honour the
    // signal: the whole point is a bound that holds even when the underlying
    // request is wedged.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(ms));
      if (controller.signal.aborted) {
        onAbort();
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    // Keep a late abort (after the fetch already won) from surfacing as an
    // unhandled rejection; the race still sees the rejection itself.
    aborted.catch(() => {});

    try {
      return await Promise.race([
        baseFetch(input, { ...init, signal: controller.signal }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      detachIncoming?.();
      if (onAbort) {
        controller.signal.removeEventListener('abort', onAbort);
      }
    }
  };
}

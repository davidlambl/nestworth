/**
 * The two wrappers lib/supabase.ts puts around the platform fetch, outermost
 * first:
 *
 *   - withAnonRestRejection refuses a PostgREST request signed with the anon
 *     key instead of sending it (#109);
 *   - withAuthTokenTimeout bounds the token refresh, the one request
 *     `db.timeout` cannot reach (#67).
 *
 * Each passes everything it does not act on through with the caller's own
 * `input` and `init` untouched.
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

/** The path of the URL a fetch argument refers to, without its query. */
function pathOf(input: RequestInfo | URL): string {
  const raw = urlOf(input);
  try {
    return new URL(raw).pathname;
  } catch {
    // Not absolute. supabase-js always passes an absolute URL, but a fetch
    // polyfill could hand us a path; drop the query either way.
    return raw.split('?')[0];
  }
}

function isAuthTokenRequest(input: RequestInfo | URL): boolean {
  return pathOf(input).includes('/auth/v1/token');
}

/** PostgREST, which supabase-js serves under `<project URL>/rest/v1/`. */
function isRestRequest(input: RequestInfo | URL): boolean {
  return pathOf(input).includes('/rest/v1/');
}

/**
 * A header value as fetch sends it: leading and trailing HTTP whitespace (tab,
 * line feed, carriage return, space) removed, and nothing else.
 */
function httpTrim(value: string): string {
  return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
}

/**
 * One header of a request, read the way `Headers.get` reads it (the name in
 * any case, each value trimmed as fetch trims it, repeated values joined with
 * ", "), from any shape fetch accepts: a Headers instance, an array of pairs or
 * a plain object. null when absent. A Headers instance's own `get` is trimmed
 * again: React Native's fetch polyfill (whatwg-fetch) stores values untrimmed.
 */
function headerOf(
  headers: HeadersInit | undefined,
  name: string
): string | null {
  if (!headers) {
    return null;
  }
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value === null ? null : httpTrim(value);
  }
  const entries: [string, string][] = Array.isArray(headers)
    ? (headers as [string, string][])
    : Object.entries(headers as Record<string, string>);
  const values = entries
    .filter(([key]) => String(key).toLowerCase() === name)
    .map(([, value]) => httpTrim(String(value)));
  return values.length > 0 ? values.join(', ') : null;
}

/**
 * The Authorization a request goes out with. fetch takes init's headers when
 * init has them, REPLACING a Request's own, and otherwise the Request's.
 */
function authorizationOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): string | null {
  if (init?.headers) {
    return headerOf(init.headers, 'authorization');
  }
  const asRequest = input as Request;
  return typeof asRequest.headers === 'object'
    ? headerOf(asRequest.headers, 'authorization')
    : null;
}

/**
 * What fetch rejects a request with when its signal has already aborted: the
 * signal's reason, which `abort()` called without one makes a DOMException
 * named AbortError, or, on a platform whose AbortSignal carries no reason, an
 * Error of that name.
 */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * The refusal. Its name and words are a contract with two files neither leaf
 * may import: they are lib/sync.ts's NoSessionError and that error's own words
 * for a missing session, and lib/requestError.ts passes an error so named
 * through unchanged, as itself or as postgrest-js's "NoSessionError: …"
 * rendering of it. That arm runs first, but keep the words free of "abort",
 * "timeout" and every platform's network phrase anyway, so that no pattern
 * there could read them as a timeout or an outage.
 */
function noSessionError(): Error {
  const err = new Error('your sign-in could not be verified');
  err.name = 'NoSessionError';
  return err;
}

/**
 * Refuses a PostgREST request signed with the anon key, without sending it
 * (#109).
 *
 * With no session, supabase-js signs every request with the anon key: its
 * `_getAccessToken` asks `auth.getSession()`, discards the error and falls back
 * to the key. PostgREST's RLS (`auth.uid() = user_id`) then answers as though
 * nothing were wrong: a read `200 []`, the same bytes as the end of a table,
 * and an UPDATE or a DELETE with zero matched rows, which for a tombstone
 * UPDATE is the success case that hard-deletes the local row. lib/sync.ts asks
 * for a session before it syncs and on every empty page (#95), but it cannot
 * see which key signed a request, so a page whose own token refresh failed
 * went out as nobody and could be trusted, and a session lost between a push's
 * check and a tombstone UPDATE lost the delete. Here the request itself is in
 * hand: supabase-js has set `Authorization` before calling this fetch
 * (`Bearer <access token>`, else `Bearer <anon key>`), and the app makes no
 * intentional anonymous PostgREST call (every one is the sync engine's, for a
 * signed-in user). So such a request is refused by throwing, and postgrest-js
 * hands the throw back as `{ data: null, error }` with the name folded into
 * `message` — a failed read or write, which every path in lib/sync.ts already
 * handles: no absence-delete, no cursor or key banked, the row left queued.
 *
 * Only that is refused:
 *
 *   - The path decides, not the header: auth-js signs sign-in, sign-up and the
 *     token refresh with the anon key itself (`/auth/v1/`), and Storage
 *     (`/storage/v1/`) shares supabase-js's authed fetch. Both pass.
 *   - The whole `Bearer <key>` value is compared: a legacy anon key is a JWT
 *     like any access token, so a prefix or a substring would match a user's.
 *     Both sides are compared as fetch sends a header, ends trimmed: a key
 *     pasted with a trailing newline reaches the header without it, and an
 *     untrimmed comparison would then never match.
 *   - A request with no Authorization at all passes: supabase-js always sets
 *     one, and only what can be seen to be anon-signed is refused. So does a
 *     request signed with a user's token, whatever the server now makes of
 *     it; one it rejects fails with its own error, as before.
 *   - A key that is empty once trimmed never matches: its header reads a bare
 *     `Bearer`, which is nobody's signature. createClient throws on an empty
 *     key before any request exists, so only a test that mocks it builds this
 *     wrapper with one.
 *
 * One request that would be refused is rejected differently: one whose signal
 * has already aborted gets the AbortError fetch itself would reject it with,
 * still unsent. That is a page whose own token refresh stalled: postgrest-js
 * arms its 30 s timeout before supabase-js awaits the token, the refresh gives
 * up after as long, and supabase-js, handed no token, signs the page with the
 * anon key after its timeout has fired. It must read as the timeout
 * it is ("the request timed out"), as it did before this wrapper, not as a
 * missing session. The check sits inside the refusal, so every request this
 * wrapper does not refuse still reaches `baseFetch` untouched, aborted or not.
 */
export function withAnonRestRejection(
  baseFetch: typeof fetch,
  anonKey: string
): typeof fetch {
  // supabase-js's `Bearer ${key}` as it reads here, once fetch has trimmed
  // its ends. Only the ends: a key's own leading space stays inside it.
  const anonAuthorization = httpTrim(`Bearer ${anonKey}`);
  // A key that is empty once trimmed signs nothing, and its header's bare
  // `Bearer` must never match.
  const hasKey = httpTrim(anonKey) !== '';
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      hasKey &&
      isRestRequest(input) &&
      authorizationOf(input, init) === anonAuthorization
    ) {
      if (init?.signal?.aborted) {
        throw abortReason(init.signal);
      }
      throw noSessionError();
    }
    return baseFetch(input, init);
  };
}

function abortError(ms: number): Error {
  const err = new Error(`Auth token request aborted after ${ms}ms`);
  // auth-js turns any non-Response throw into a retryable AuthRetryableFetchError,
  // and the name is what marks this as a timeout everywhere else in the app
  // (lib/requestError.ts).
  err.name = 'AbortError';
  return err;
}

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
 */
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
        // Short-circuit rather than abort-and-race: Promise.race settles on the
        // first promise to settle, and a baseFetch that ignores the signal and
        // resolves fast would beat the already-rejected abort. postgrest-js's
        // own wrapper returns here for the same reason.
        clearTimeout(timer);
        throw abortError(ms);
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

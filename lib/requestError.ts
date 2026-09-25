/**
 * What `fetch` rejects with when a request never reached a server, in each
 * platform's own words. Substrings, because postgrest-js prefixes the fetch
 * error's name ("TypeError: Failed to fetch"). Case-sensitive, because WebKit's
 * "Load failed" would otherwise match an ordinary "upload failed". Phrases only,
 * never the name `TypeError` by itself: a network failure is a plain TypeError,
 * but so is a bug.
 */
const NETWORK_UNREACHABLE = [
  'Failed to fetch', // Chrome, Edge, Electron
  'Load failed', // Safari and WebKit
  'NetworkError when attempting to fetch resource', // Firefox
  'Network request failed', // React Native
  'fetch failed', // Node (undici)
];

/**
 * The name lib/sync.ts gives the error it reports for a read with no session
 * (#95), and lib/fetchWithTimeout.ts the one it throws when it refuses a
 * PostgREST request signed with the anon key (#109).
 */
const NO_SESSION_ERROR = 'NoSessionError';

/**
 * Human copy for a failed Supabase request, for every place a request error is
 * interpolated into a message the user reads (lib/sync.ts, lib/auth.tsx).
 *
 * Since #67 every PostgREST request carries a 30 s timeout, and postgrest-js
 * reports an abort as `{ error }` whose `message` is the underlying error's NAME
 * plus its message — "AbortError: The operation was aborted" — so the raw string
 * would surface as "Can't reach the cloud — reset cancelled… (AbortError: The
 * operation was aborted)". Anything abort- or timeout-shaped therefore collapses
 * to one plain phrase. A request that never reached a server at all (offline, a
 * DNS failure, a refused connection) arrives the same way, as "TypeError: Failed
 * to fetch" or its platform's equivalent, and collapses to another (#66). A
 * gateway error from the auth server has no words of its own at all, and gets a
 * third (see below). A NoSessionError is already copy and passes through before
 * any of that, without its name: the engine's own (#95), and the fetch
 * wrapper's refusal of an anon-signed request, which postgrest-js reports as
 * "NoSessionError: your sign-in could not be verified" (#109). Everything else
 * keeps the server's own message, which is usually the actionable part (an RLS
 * denial, an expired JWT, a constraint).
 *
 * A leaf on purpose: it imports nothing, and in particular nothing from ./sync
 * (the cycle guard described in lib/tombstones.ts).
 */
export function describeRequestError(error: unknown): string {
  const shape = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
  } | null;
  const name = typeof shape?.name === 'string' ? shape.name : '';
  const message = typeof shape?.message === 'string' ? shape.message : null;
  // A NoSessionError's message was written as copy: lib/sync.ts words the
  // cause with this very mapper, and the fetch wrapper's refusal uses the
  // same words for no session at all. It arrives as the error itself or, from
  // the wrapper, as postgrest-js's `{ error }`, which folds the thrown error's
  // name into `message` and keeps no name of its own. Checked first, so the
  // name guarantees the words pass, not the patterns below happening to miss
  // them; the prefix only at the start, where postgrest-js puts it.
  if (name === NO_SESSION_ERROR) {
    return message ?? String(error);
  }
  if (message?.startsWith(`${NO_SESSION_ERROR}: `)) {
    return message.slice(NO_SESSION_ERROR.length + 2);
  }
  // Match the name as well as the message: a caller's own AbortSignal produces a
  // DOMException whose message carries no such word ("This operation was
  // aborted" does, "signal is aborted without reason" does not).
  if (/abort|timeout/i.test(name) || /abort|timeout/i.test(message ?? '')) {
    return 'the request timed out';
  }
  // The auth server answering 502, 503 or 504 — a token refresh, a sign-in or a
  // sign-up (#95). auth-js throws an AuthRetryableFetchError built from the
  // Response itself: its `_getErrorMessage` falls back to JSON.stringify, and a
  // Response serialises to "{}", whatever its body said. So the status is the
  // only information there is, and "{}" is what the user would otherwise read.
  //
  // The status arm is gated on auth-js's error names (AuthRetryableFetchError,
  // AuthApiError, …). postgrest-js adds no `status` of its own and PostgREST's
  // own bodies carry none, but for a non-ok response its `error` IS the parsed
  // body, so a gateway's JSON that happened to carry a `status` key would
  // otherwise read as the sign-in service's. The "{}" arm needs no gate: only
  // auth-js's JSON.stringify fallback produces that message, and a `{}` body
  // from postgrest-js has no `message` at all.
  const status = shape?.status;
  const authGatewayError =
    /^Auth/.test(name) && (status === 502 || status === 503 || status === 504);
  if (authGatewayError || message === '{}') {
    return 'the sign-in service is unavailable';
  }
  // After the timeout check, so a request that timed out never reads as a
  // network that was not there.
  const unreachable = (text: string) =>
    NETWORK_UNREACHABLE.some((phrase) => text.includes(phrase));
  if (unreachable(name) || unreachable(message ?? '')) {
    return 'the network is unavailable';
  }
  return message ?? String(error);
}

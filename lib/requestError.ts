/**
 * Human copy for a failed Supabase request, for the two places a request error
 * is interpolated into a message the user reads (lib/sync.ts).
 *
 * Since #67 every PostgREST request carries a 30 s timeout, and postgrest-js
 * reports an abort as `{ error }` whose `message` is the underlying error's NAME
 * plus its message — "AbortError: The operation was aborted" — so the raw string
 * would surface as "Can't reach the cloud — reset cancelled… (AbortError: The
 * operation was aborted)". Anything abort- or timeout-shaped therefore collapses
 * to one plain phrase, and everything else keeps the server's own message, which
 * is usually the actionable part (an RLS denial, an expired JWT, a constraint).
 *
 * A leaf on purpose: it imports nothing, and in particular nothing from ./sync
 * (the cycle guard described in lib/tombstones.ts).
 */
export function describeRequestError(error: unknown): string {
  const shape = error as { name?: unknown; message?: unknown } | null;
  const name = typeof shape?.name === 'string' ? shape.name : '';
  const message = typeof shape?.message === 'string' ? shape.message : null;
  // Match the name as well as the message: a caller's own AbortSignal produces a
  // DOMException whose message carries no such word ("This operation was
  // aborted" does, "signal is aborted without reason" does not).
  if (/abort|timeout/i.test(name) || /abort|timeout/i.test(message ?? '')) {
    return 'the request timed out';
  }
  return message ?? String(error);
}

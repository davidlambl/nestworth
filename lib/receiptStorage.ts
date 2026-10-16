import { describeRequestError } from './requestError';
import { supabase } from './supabase';

/**
 * Showing a stored receipt (#23): the `receipts` bucket is private, so the
 * screens never get a plain URL. They get a signed one: `createSignedUrl`
 * asks Storage (POST /storage/v1/object/sign/receipts/<key>, which 009's
 * read policy admits for the caller's own folder) for a URL carrying a token
 * that expires. The image component then loads that URL like any other, so
 * each platform's own image pipeline fetches, caches and decodes it.
 *
 * Every signing makes a new token, so a new URL, and React Native's image
 * cache and the browser's both key on the URL: a URL signed again is a photo
 * downloaded again. So a URL is kept here, per key, for the account that
 * signed it, and handed out again while it has more than
 * RECEIPT_URL_MIN_LEFT_MS to run. That keeps it stable while a screen lives,
 * across the refetch every sync ends with (`queryClient.invalidateQueries()`,
 * lib/query.tsx) and across reopening the same transaction. On web the
 * full-screen view shows the bytes the thumbnail loaded; on iOS it decodes
 * the photo again at screen size, and downloads it again when the photo is
 * too large for the shared URL cache.
 *
 * A signed URL is a bearer token for one photo until it expires. It goes to
 * the image component and nowhere else: never into a message, a log line or
 * a route. Nothing here puts it in an error. React Native's Image reports a
 * failed load as "Failed to load <the URL>" on iOS and react-native-web's as
 * "Failed to load resource <the URL>", so the screens never read that event's
 * text.
 */

/** The private bucket receipts live in (009_receipt_storage_policies.sql). */
export const RECEIPTS_BUCKET = 'receipts';

/** How long a signed URL works, in seconds: an hour. */
export const RECEIPT_URL_TTL_S = 60 * 60;

/**
 * A kept URL with less than this left is signed again before it is handed
 * out, so a screen opened on it still has that long to load it, full-screen
 * view included.
 */
export const RECEIPT_URL_MIN_LEFT_MS = 10 * 60 * 1000;

/**
 * How long a signing request is waited for. Storage requests carry no
 * timeout of their own (lib/supabase.ts bounds only PostgREST and the token
 * refresh), and a stalled socket would leave the screen loading forever.
 */
export const RECEIPT_URL_TIMEOUT_MS = 30_000;

/**
 * What a screen shows for a receipt whose key is outside the user's folder:
 * another account's (see `kept`), which receiptUrl refuses before any request.
 */
export const RECEIPT_FOREIGN = 'This receipt belongs to a different account.';

/** The name receiptUrl gives that refusal (isForeignReceipt). */
const FOREIGN_RECEIPT_ERROR = 'ForeignReceiptError';

/**
 * Each kept URL with the account it was signed for. One device can sign in
 * several accounts in turn and sign-out wipes no local rows (CONTRIBUTING,
 * "Sync meta keys"), so a later account can render an earlier one's
 * transaction: its URL must not be handed to that account, which Storage
 * itself would refuse.
 */
const kept = new Map<
  string,
  { userId: string; url: string; expiresAt: number }
>();

/**
 * How many times every kept URL has been dropped (forgetReceiptUrls, at
 * sign-out). A signing keeps its URL only when none happened while it was
 * out: one that answers after a sign-out hands its URL to its caller and
 * keeps nothing for the next session to be handed.
 */
let generation = 0;

/**
 * A signed URL for the receipt at `path`, the user's own: a kept one while it
 * has more than RECEIPT_URL_MIN_LEFT_MS left, else a fresh one. Rejects with
 * Storage's own error (see isMissingReceipt for the one that means the photo
 * is gone), a timeout, or a NoSessionError. A key outside the user's folder,
 * another account's receipt, is refused before any request
 * (isForeignReceipt): Storage would answer it "Object not found", which reads
 * as a photo that is missing.
 */
export async function receiptUrl(
  userId: string,
  path: string,
  now: number = Date.now()
): Promise<string> {
  const hit = kept.get(path);
  if (
    hit &&
    hit.userId === userId &&
    hit.expiresAt - now > RECEIPT_URL_MIN_LEFT_MS
  ) {
    return hit.url;
  }
  if (!path.startsWith(`${userId}/`)) {
    const refusal = new Error(RECEIPT_FOREIGN);
    refusal.name = FOREIGN_RECEIPT_ERROR;
    throw refusal;
  }
  const startedIn = generation;
  await requireOwnSession(userId);
  const { data, error } = await withTimeout(
    supabase.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(path, RECEIPT_URL_TTL_S),
    RECEIPT_URL_TIMEOUT_MS
  );
  if (error) {
    throw error;
  }
  // Kept only when the user has not signed out meanwhile, and counted from
  // before the request, so a slow answer only shortens it.
  if (startedIn === generation) {
    kept.set(path, {
      userId,
      url: data.signedUrl,
      expiresAt: now + RECEIPT_URL_TTL_S * 1000,
    });
  }
  return data.signedUrl;
}

/**
 * Drops the URL kept for `path`: after its photo was removed, so a key that
 * is still named somewhere is signed again and reads as missing; and before a
 * retry, so the retry asks for a new token.
 */
export function forgetReceiptUrl(path: string): void {
  kept.delete(path);
}

/**
 * Drops every kept URL: on sign-out (lib/auth.tsx), and in tests. A signing
 * still out keeps nothing when it answers (`generation`).
 */
export function forgetReceiptUrls(): void {
  generation += 1;
  kept.clear();
}

/**
 * Whether Storage answered that the object is not there, or not the
 * caller's to read: storage-api renders NoSuchKey with HTTP 400 and the
 * body's `statusCode: '404'`, which storage-js keeps as `statusCode`; an
 * answer with HTTP 404 and only `code: 'NoSuchKey'` is read the same way.
 * Never retried: the photo will not come back.
 */
export function isMissingReceipt(error: unknown): boolean {
  const shape = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
  } | null;
  return (
    shape?.name === 'StorageApiError' &&
    (shape.statusCode === '404' ||
      shape.statusCode === 'NoSuchKey' ||
      shape.status === 404)
  );
}

/**
 * Whether receiptUrl refused a key outside the user's folder: another
 * account's receipt. Read from the refusal's name, never its words. Never
 * retried, and not the user's to remove.
 */
export function isForeignReceipt(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === FOREIGN_RECEIPT_ERROR;
}

/**
 * Refuses unless supabase-js holds a session of `userId`'s own. Without one it
 * signs a Storage request with the anon key (it falls back to it when
 * getSession() hands back none, as during a token refresh the auth server
 * answers 502), and lib/fetchWithTimeout.ts refuses that only for PostgREST,
 * not for Storage. Storage then answers by RLS, with no error: a removal
 * answers that it removed nothing, which the removal reads as a photo already
 * gone, and a signing answers "Object not found". The error carries
 * describeRequestError's NoSessionError name, which it passes through
 * unchanged, and the engine's words for the same three cases (lib/sync.ts,
 * NoSessionError): another account's session, a refresh that failed (offline
 * near the token's expiry it names the network), or no session at all.
 */
export async function requireOwnSession(userId: string | null): Promise<void> {
  let sessionUserId: string | null = null;
  let refreshError: unknown = null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (data?.session?.access_token) {
      sessionUserId = data.session.user?.id ?? null;
    } else {
      refreshError = error ?? null;
    }
  } catch {
    // auth-js's cross-tab lock timed out: a session nobody can vouch for.
  }
  if (userId && sessionUserId === userId) {
    return;
  }
  const error = new Error(
    userId && sessionUserId
      ? 'your sign-in belongs to a different account'
      : refreshError
        ? `your sign-in could not be renewed (${describeRequestError(refreshError)})`
        : 'your sign-in could not be verified'
  );
  error.name = 'NoSessionError';
  throw error;
}

/** `promise`, or a TimeoutError once `ms` has passed without an answer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('the request timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

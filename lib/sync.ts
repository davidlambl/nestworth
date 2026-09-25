import { supabase } from './supabase';
import { getDb, getSyncMeta, setSyncMeta } from './db';
import {
  deleteLocalAccountIfSynced,
  deleteLocalRuleIfSynced,
  deleteLocalTransactionIfSynced,
  isTombstone,
} from './tombstones';
import { refreshSyncState, setLastError, setSyncing } from './syncStatus';
import { describeRequestError } from './requestError';

/**
 * How stale `last_txn_reconcile_at:<userId>` may get before pullTransactions
 * pays for a full remote enumeration again.
 *
 * Before tombstones every sync enumerated every remote (id, updated_at) just to
 * notice what another device had deleted, which made the cost of a sync
 * proportional to total history rather than to what changed (#18). A delete is
 * now an UPDATE the incremental pull sees for itself, so the enumeration is
 * demoted to a periodic safety net for the two things it alone can catch: a row
 * that vanished without a tombstone (purge_tombstones ran, or an old client
 * hard-deleted it) and drift corrected to a timestamp OLDER than our cursor.
 *
 * 24 h must stay comfortably below the server's tombstone retention (30 days in
 * 005_tombstones.sql): a device offline longer than that retention misses the
 * purged tombstone entirely and has nothing but this pass to fall back on.
 */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Rows asked for per remote read.
 *
 * A request, never a promise: PostgREST clamps every response at its own
 * `max_rows` (1000 on hosted Supabase, and not pinned anywhere in this repo),
 * so a page can come back shorter than this for a reason that has nothing to do
 * with reaching the end of the table. That is why the loops below advance by
 * rows RETURNED and stop only on an empty page (#64).
 */
export const PAGE_SIZE = 1000;

export interface RemotePage<T> {
  data: T[] | null;
  error: any;
}

/**
 * Can this client sign its requests as `userId`? `null` if it can, the reason
 * if it cannot: no session at all (#95), or a session that belongs to another
 * user (#111).
 *
 * The same predicate supabase-js applies: its `_getAccessToken` asks
 * `auth.getSession()`, DISCARDS the error, and falls back to the anon key when
 * no session comes back. Every request is then signed as nobody, and RLS
 * (`auth.uid() = user_id`) answers without an error object: a read returns
 * `[]`, an UPDATE or a DELETE matches nothing, and only an upsert or an insert
 * is refused (42501). An empty answer that really means "not signed in" is
 * indistinguishable from an empty table, so the engine asks the same question
 * itself before it trusts one. The routes to it: no stored session (auth-js
 * removed it after a refresh failed for good, while a sync that had captured
 * the user id was in flight — useSyncEngine in lib/query.tsx only flips
 * `cancelled` when the user goes), a refresh that fails fast but retryably
 * (the auth server answering 502, 503 or 504, or a network error auth-js
 * keeps retrying inside the request's own timeout), and a session removed
 * between two pages of one read. A 30 s refresh STALL is not one of them:
 * postgrest-js arms its timeout before the token is awaited, so the stalled
 * request reaches fetch already aborted and fails with an AbortError.
 *
 * Since #109 those answers never reach the engine in the app: lib/supabase.ts's
 * fetch wrapper refuses to send a PostgREST request signed with the anon key,
 * and postgrest-js hands the refusal back as a failed read or write
 * ("NoSessionError: your sign-in could not be verified"). That also closes
 * what this check cannot see, which key signed a given request: a page whose
 * own refresh failed while the check's succeeded, and a session lost between
 * a push's check and its tombstone UPDATE. The checks built on this function
 * are the second line now. They still refuse before any request is made,
 * stamp nothing, and name the refresh's own failure ("could not be renewed
 * (<cause>)") where the refusal can only say "could not be verified". A
 * refresh that STALLS stays the AbortError above: the wrapper rejects a
 * request whose signal has already aborted as fetch would, unsent, before it
 * refuses one as anon-signed. So a stall reads "the request timed out" both
 * mid-read and at an entry check ("Couldn't renew your sign-in: the request
 * timed out").
 *
 * Free on the happy path: auth-js reads the session from storage and hands it
 * back with no network I/O while the access token is more than 90 s from
 * expiry. Inside that margin this IS the token refresh, bounded by
 * lib/fetchWithTimeout.ts, which the next request would have paid anyway. A
 * refresh that fails comes back as `{ session: null, error }`. Only a
 * retryable failure — a network error, a timeout, a 502, 503 or 504 — keeps
 * the stored session for the next attempt. Any other, a 500 included (auth-js
 * reads it as a final AuthApiError), removes the session and signs the user
 * out, which is the first route above. A throw (on web, auth-js's cross-tab
 * lock taken from under it by another caller whose 5 s wait ran out) is a
 * session nobody can vouch for either.
 *
 * A session with a token is not enough: it must be `userId`'s own (#111).
 * useSyncEngine (lib/query.tsx) is keyed on the user id, and its cleanup only
 * flips `cancelled`, so when another account signs in, the outgoing user's
 * in-flight or queued work runs on under the NEW user's token. Nothing fails
 * then either. Every read of the old user's rows (`.eq('user_id', <old>)`)
 * answers `[]` under the new user's RLS: step 1 of pullTransactions banks the
 * old user's cursor over a window it never read, and a fresh user's pull
 * stamps itself complete. And every tombstone UPDATE of the old user's rows
 * matches nothing, which is the push's success case: the queued delete is
 * hard-deleted locally while the server copy stays live. So the session's
 * user is compared exactly, and one that is not `userId` is refused like no
 * session at all — reported as `wrong-user`, since there is a session and it
 * is simply not this user's. The fetch wrapper (#109) cannot see this case:
 * a request signed with another user's token is signed, and goes out. For
 * another user's session the checks built on this function are the only
 * line, not the second.
 */
async function sessionFailure(userId: string): Promise<SessionFailure | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    const session = data?.session;
    if (!session?.access_token) {
      return { kind: 'no-session', error: error ?? null };
    }
    const sessionUserId = session.user?.id ?? null;
    if (sessionUserId !== userId) {
      return { kind: 'wrong-user', sessionUserId };
    }
    return null;
  } catch (e) {
    return { kind: 'no-session', error: e };
  }
}

/**
 * What a refusal logs: never shown to the user, so a wrong-user refusal names
 * both ids (#111).
 */
function sessionRefusalLog(userId: string, failure: SessionFailure): string {
  return failure.kind === 'wrong-user'
    ? `the session belongs to ${failure.sessionUserId}, not ${userId}`
    : 'no session';
}

/**
 * What a read reports when a page came back empty from a client with no
 * session (#95), or with another user's (#111): readAllPages' third rule.
 * Every caller already handles it as the failed read it is. Its message is
 * already copy: it reaches the user after the caller's own prefix —
 * "Couldn't download <table>: " from a pull, "Failed to download <table>: "
 * from a reset's re-download, "initialPull <table> failed: " from a bootstrap
 * — through describeRequestError, which passes an error of this name through
 * unchanged, ahead of every pattern it matches. The fetch wrapper's refusal of
 * an anon-signed request (#109, lib/fetchWithTimeout.ts) carries the same name
 * and this class's words for no session, and postgrest-js hands it back as
 * "NoSessionError: …", which describeRequestError reads the same way. Neither
 * leaf can import this class, so the name and the words are the contract;
 * tests pin both.
 */
class NoSessionError extends Error {
  constructor(failure: SessionFailure) {
    super(
      failure.kind === 'wrong-user'
        ? 'your sign-in belongs to a different account'
        : failure.error == null
          ? 'your sign-in could not be verified'
          : `your sign-in could not be renewed (${describeRequestError(failure.error)})`
    );
    this.name = 'NoSessionError';
  }
}

/**
 * Reads a remote table one `.range()` page at a time, handing each page to
 * `onPage` as it arrives, and returns the first error or the row count.
 *
 * Three rules. The first two ARE #64:
 *
 *   - **Advance by rows returned, not by `pageSize`.** PostgREST silently
 *     truncates a response to `max_rows`. If that cap is below `pageSize` every
 *     page comes back short, and advancing by `pageSize` would skip the rows
 *     between the cap and the request — reading 1000 rows' worth of offsets for
 *     every `max_rows` actually delivered.
 *   - **Stop only on an EMPTY page.** A short page is precisely what a clamped
 *     read looks like, so terminating on `length < pageSize` is the same bug
 *     from the other side. Verified against this project's PostgREST: a
 *     `.range()` starting past the last row answers `200` with
 *     `{ data: [], error: null }` (no `count` preference is sent, which is what
 *     a 416/`PGRST103` would require), so the price of the rule is one trailing
 *     empty request per read.
 *   - **An empty page from a client with no session is a failed read (#95),
 *     and so is one from a client signed in as another user (#111).** Signed
 *     with the anon key, RLS answers every page `200 []` — the same bytes as
 *     the end of the table — and so it does, for this user's rows, signed with
 *     another user's token; the session can go, or change hands, between two
 *     pages of one read. So every empty page, the first one included, asks
 *     `sessionFailure(userId)` before it may end the read, and on a refusal the
 *     read returns a NoSessionError instead: the pages already delivered
 *     stand, and every caller withholds what a failed read withholds (its
 *     cursor, its reconcile key, its absence-deletes). Never on a page that
 *     returned rows, which a signed request did. The price is one session
 *     read per read-ending empty page, from storage on the happy path — and
 *     `opts.userId`, which every caller passes: the user the read is for.
 *     Since #109 an anon-signed page is not even sent: the fetch wrapper
 *     refuses it, and it arrives above as an error, which also covers what
 *     this rule cannot see, a page signed as nobody whose session was back
 *     by the time the rule asked. This rule is the second line for no
 *     session. For another user's session it is the only one: that page is
 *     signed, so the wrapper sends it, and RLS answers it `[]`.
 *
 * Truncation is not "a slow sync", it is data loss. `pullTableFull` feeds its
 * read straight into an absence-delete loop, so a clamped read deletes every
 * local row past the cutoff; a clamped reconcile enumeration hands
 * `planTransactionReconcile` deletion authority over rows it never saw, which
 * is exactly what the #19 empty-read guard exists to withhold — except the read
 * was not empty, so nothing catches it.
 *
 * `page` MUST build a fresh query builder per call — but not for the reason it
 * is tempting to give. A builder is NOT single-use: postgrest-js re-fetches from
 * its current URL on every await, and `.range()` REPLACES what it set last time,
 * so three `.range()` calls on one builder really do return offsets 0, 1000 and
 * 2000 (driven against the pinned version to check). What does not replace is a
 * chained FILTER: filters APPEND. The incremental pass below adds a conditional
 * `.gt('updated_at', lastPull)` inside its lambda, so a hoisted builder would
 * carry one more `.gt` on every page — a query that narrows itself until it
 * matches nothing, while each page still looks like an honest short read.
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<RemotePage<T>>,
  onPage: (rows: T[]) => Promise<void>,
  opts: { userId: string; pageSize?: number }
): Promise<{ error: any; rows: number }> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  let from = 0;
  let rows = 0;
  while (true) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) {
      // Pages already delivered stand; the caller decides what a partial read
      // means for its cursor (every one of them withholds it).
      return { error, rows };
    }
    if (!data || data.length === 0) {
      // The third rule: an empty page ends the read only if it was signed,
      // and signed as the user it is for.
      const refused = await sessionFailure(opts.userId);
      if (refused) {
        return { error: new NoSessionError(refused), rows };
      }
      return { error: null, rows };
    }
    await onPage(data);
    rows += data.length;
    from += data.length;
  }
}

/**
 * `readAllPages`, accumulated — for the reads whose consumer needs the whole
 * set before it can act (a deletion reconcile, a split batch). Streaming reads
 * use `readAllPages` directly and stay bounded in memory.
 */
export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<RemotePage<T>>,
  opts: { userId: string; pageSize?: number }
): Promise<{ error: any; data: T[] }> {
  const data: T[] = [];
  const { error } = await readAllPages<T>(
    page,
    async (rows) => {
      data.push(...rows);
    },
    opts
  );
  return { error, data };
}

let _syncInProgress = false;
// Whose sync holds the lock. Every push read and pull filter is
// `user_id = ?`-scoped and finishSync drains the queue as the HOLDER, so the
// flags below belong to this user and to nobody else: a request for another
// user must not be queued into that drain, or it would run as the holder and
// touch none of the requester's rows or cursors (#63). Non-null exactly while
// _syncInProgress is true.
//
// On an account switch the holder is the OUTGOING user: its sync keeps the
// lock after the next user signs in (useSyncEngine only flips `cancelled`),
// and what it still has to do meets the new user's session (#111). Every
// follow-up it drains, a queued push carrying real pending rows included, is
// refused at its entry check. The push in flight still sends its remaining
// upserts, one request each, which the server refuses with 42501, but stops
// before its next tombstone or split DELETE; the pull in flight fails its read
// at the next empty page. Those rows stay pending for that user's next
// sign-in.
let _holderUserId: string | null = null;
// Work requested while the lock was held, BY THE HOLDER'S USER. finishSync
// drains both before the holder releases the lock, so a request that arrives
// mid-sync is never lost. A flag left set past MAX_QUEUED_DRAINS is drained by
// whichever holder comes next, which may be another user — benign because a
// flag means no more than "re-read that user's pending rows" (and, for
// _fullSyncQueued, "pull them too"), so a drain for the wrong user only redoes
// that user's own push — and, for a queued full sync, its pull — redundant
// work, never wrong work, and the requester's rows stay pending for its next
// trigger. That was already true before #63; what changed is only that the next
// acquirer can now deterministically be the other user, since a cross-user
// caller is waiting for the release rather than queuing behind it.
let _pushQueued = false;
let _fullSyncQueued = false;
// Settles once the current lock holder has released the lock. Assigned by
// acquireLock, synchronously and BEFORE the lock becomes observable, so it is
// never null nor a settled leftover while _syncInProgress is true — which is
// what lets a caller for another user await it in a loop instead of spinning in
// microtasks and starving the holder's own I/O. Nothing can reject it: the
// deferred captures only `resolve`, sync failures are caught by every holder,
// and resetLocalData's rejection goes to its own caller rather than into this
// promise. finishSync resolves it from its finally BEFORE setSyncing(false), so
// not even a throwing status listener can leave a waiter stranded.
let _inFlight: Promise<void> | null = null;
let _release: (() => void) | null = null;
// How many queued follow-ups one holder drains before handing the rest to the
// next trigger. A bound, not a target: it only matters if something keeps
// requesting syncs faster than they complete.
const MAX_QUEUED_DRAINS = 10;

async function notifySyncState(userId: string) {
  try {
    await refreshSyncState(userId);
  } catch (e) {
    console.warn('[sync] refresh status failed:', e);
  }
}

/**
 * Takes the sync lock for `userId`. SYNCHRONOUS on purpose, and called by every
 * entry point exactly where it used to set `_syncInProgress = true` — before
 * that entry point's first await. Two things depend on that:
 *
 *   - `resetLocalData`'s refusal and every wait loop below check the lock and
 *     then take it with no await in between, so one release can never wake two
 *     waiters into the same critical section.
 *   - A caller that finds the lock free is holding it by the time it yields, so
 *     `requestPush('u')` followed by an un-awaited `initialPull('u')` still
 *     collides (syncLockQueue.test.ts:238-241, sync.test.ts:476-480).
 *
 * `_inFlight` is created here rather than from the running promise so that it
 * exists, unsettled, for the whole time the lock is held.
 */
function acquireLock(userId: string): void {
  _syncInProgress = true;
  _holderUserId = userId;
  _inFlight = new Promise<void>((resolve) => {
    _release = resolve;
  });
}

/**
 * Every lock holder ends here, from its finally block.
 *
 * Drains whatever was requested while the lock was held — using the lock-free
 * primitives, so there is no release/re-acquire gap for a request to fall
 * into — then refreshes the pending count, and only then publishes
 * isSyncing=false and releases the lock, with no await between the last
 * empty-queue check and the release. Two invariants follow:
 *
 *   - A requestPush() or fullSync() that found the lock held always results in
 *     one more push (and pull) before the holder's promise resolves. Before
 *     this helper, initialPull deliberately skipped the drain and left it to
 *     the fullSync that useSyncEngine ran next — and that fullSync was skipped
 *     whenever the effect had been torn down and re-run mid-bootstrap, which
 *     happened on nearly every launch. Anything created during the first sync
 *     then sat `pending` until the next AppState/NetInfo event (#55).
 *   - The sidebar label reads `Synced` only when nothing is in flight AND the
 *     count was refreshed after the last write. The Playwright helpers wait on
 *     that exact word to prove a delete was pushed (#54).
 *
 * The drain clears lastError only before a queued FULL sync (#65). A full
 * follow-up redoes the push and the pull, and pullChanges reports a pull that
 * is still incomplete itself (#66), so clearing first leaves the line saying
 * what that follow-up found. A queued push redoes only the push: it neither
 * retries a reset that failed nor re-reads what the holder's pull could not
 * (the device is still stale), so it cannot undo the holder's failure, and
 * clearing before it wiped the only report of either. The holder's message
 * stays instead until the next sync starts, since every holder clears it on
 * entry. The cost falls on the failures a queued push does heal: a holder's
 * push that threw (rare, as pushChanges swallows per-row errors), or a reset
 * refused over rows the queued push then uploads. Their message goes stale
 * until then. The refused reset's "Couldn't upload N unsynced change(s) —
 * reset cancelled…" stays up with nothing pending, still right that the
 * reset did not run, which is what #65 asked for. A follow-up that throws
 * still reports its own error; the latest failure wins.
 */
async function finishSync(userId: string): Promise<void> {
  try {
    let drained = 0;
    let capped = false;
    do {
      while (!capped && (_pushQueued || _fullSyncQueued)) {
        if (drained >= MAX_QUEUED_DRAINS) {
          console.warn(
            `[sync] drained ${drained} queued follow-ups and more keep arriving; leaving the rest for the next trigger`
          );
          capped = true;
          break;
        }
        drained++;
        const full = _fullSyncQueued;
        _pushQueued = false;
        _fullSyncQueued = false;
        console.log(`[sync] draining queued ${full ? 'full sync' : 'push'}`);
        // Only a full follow-up clears lastError (#65): see above.
        if (full) {
          setLastError(null);
        }
        try {
          await pushChanges(userId);
          if (full) {
            await pullChanges(userId);
          }
        } catch (e) {
          console.warn('[sync] queued follow-up failed:', e);
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }
      // Refresh the count while the lock is still held. If a request lands
      // during the refresh, go round again so it is drained before release.
      await notifySyncState(userId);
    } while (!capped && (_pushQueued || _fullSyncQueued));
  } finally {
    // Release BEFORE setSyncing(false): a throwing status listener must not
    // strand every caller waiting on _inFlight with a lock nobody holds.
    _syncInProgress = false;
    _holderUserId = null;
    const release = _release;
    _release = null;
    release?.();
    setSyncing(false);
  }
}

export async function requestPush(userId: string): Promise<void> {
  // The wait loop is inlined in each entry point rather than shared as an
  // `async` helper: awaiting a helper on the lock-free path would break the
  // synchronous acquire above, and re-checking the flag after the await is what
  // keeps two woken waiters from both entering.
  while (_syncInProgress) {
    if (_holderUserId === userId) {
      _pushQueued = true;
      console.log('[sync] push queued: a sync is in flight');
      return;
    }
    // Another user's sync: queuing would run the push as THEM (#63). Wait for
    // the release and take the lock ourselves.
    console.log('[sync] push for another user waiting for the lock');
    await _inFlight;
  }
  const run = async () => {
    try {
      setSyncing(true);
      setLastError(null);
      await pushChanges(userId);
    } catch (e) {
      console.warn('[sync] push failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  acquireLock(userId);
  await run();
}

export async function fullSync(userId: string): Promise<void> {
  while (_syncInProgress) {
    if (_holderUserId === userId) {
      // Queue rather than drop: the holder's finishSync runs a push and a pull
      // before it releases the lock, and awaiting it gives callers (syncNow,
      // promptSignOut, the startup sequence) the sync they asked for.
      _fullSyncQueued = true;
      console.warn(
        '[sync] fullSync requested while a sync is in flight; queued'
      );
      await _inFlight;
      return;
    }
    // The holder is syncing somebody else, so its drain would push and pull
    // THEIR rows and stamp THEIR cursors (#63). Wait for the lock instead.
    console.warn('[sync] fullSync for another user waiting for the lock');
    await _inFlight;
  }
  const run = async () => {
    try {
      setSyncing(true);
      setLastError(null);
      await pushChanges(userId);
      await pullChanges(userId);
    } catch (e) {
      console.warn('[sync] full sync failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  acquireLock(userId);
  await run();
}

/**
 * The startup sequence for a signed-in user: open the database, bootstrap if
 * this device has never pulled, then run one full sync. It lives here rather
 * than in useSyncEngine so tests can drive it directly; the hook supplies the
 * cancellation and cache-invalidation callbacks.
 */
export async function startSyncSession(
  userId: string,
  hooks: { onBootstrapped?: () => void; isCancelled?: () => boolean } = {}
): Promise<void> {
  await getDb();
  if (hooks.isCancelled?.()) {
    return;
  }
  if (await needsInitialPull(userId)) {
    // Never throws: initialPull reports through setLastError.
    await initialPull(userId);
  }
  hooks.onBootstrapped?.();
  if (hooks.isCancelled?.()) {
    return;
  }
  await fullSync(userId);
}

/**
 * Has this device never pulled for `userId`? True only while BOTH pull keys
 * are unset, so the bootstrap runs where it always has: before any pull has
 * finished on this store (a fresh install, after wipeLocalData, or after a
 * bootstrap that gave up with no pull run since).
 *
 * Two keys since #66. `last_pull_at` is stamped only by a COMPLETE pull — it
 * is "Last synced" in Settings — while `last_pull_attempt_at` is stamped by
 * every pullChanges that gets as far as its reads (one refused for want of a
 * session stamps neither, #95), complete or not. Asking only the first
 * would send the next launch back to initialPull after any incomplete pull,
 * over a store that already holds data, and initialPull is written for an
 * empty one. Its split loop neither filters by the parent's local status nor
 * deletes stale synced splits, so it inserts the server's splits beside a
 * local pending replacement, and the next push uploads both: a permanent
 * duplicate. And it reads live rows only and banks both transaction keys past
 * any tombstone written in between, so a deletion made elsewhere survives
 * here for up to a day. After an attempt, even an incomplete one, pullChanges
 * is the right tool: it is written for a populated store, and its cursor and
 * reconcile-key guards already hold back whatever that attempt could not read.
 * Since #96 initialPull also checks the store itself and hands one that
 * already holds this user's rows to pullChanges, so its loop is kept off such
 * a store twice over: these keys keep the ordinary paths out of initialPull,
 * and the check catches the narrow ones that reach it with both keys unset (a
 * first bootstrap killed or abandoned mid-download, a reset whose download
 * threw).
 */
export async function needsInitialPull(userId: string): Promise<boolean> {
  const pulled = await getSyncMeta(`last_pull_at:${userId}`);
  const attempted = await getSyncMeta(`last_pull_attempt_at:${userId}`);
  return !pulled && !attempted;
}

/**
 * Does the local store hold ANY row of this user's, in any sync status? What
 * initialPull asks before its loop, which is written for an empty store (#96).
 *
 * Only the transactions arm is load-bearing. Both kinds of damage the loop does
 * over data happen through a transaction: duplicate splits under a parent this
 * device already holds, and a transaction tombstoned elsewhere, which its
 * live-only reads never see. Splits are not asked about: they have no user_id
 * and ride their parent, so a split whose parent is gone belongs to nobody.
 * The accounts and rules arms keep "populated" meaning what it says; over a
 * store holding only those the loop would do no lasting harm, since every
 * pull reads both tables whole, tombstones included.
 *
 * `user_id = ?` in every arm: another account signed in on this device says
 * nothing about whether this user's store is empty.
 */
async function hasRowsForUser(db: any, userId: string): Promise<boolean> {
  const row: { populated: number } | null = await db.getFirstAsync(
    `SELECT EXISTS(SELECT 1 FROM accounts WHERE user_id = ?)
         OR EXISTS(SELECT 1 FROM transactions WHERE user_id = ?)
         OR EXISTS(SELECT 1 FROM recurring_rules WHERE user_id = ?) AS populated`,
    [userId, userId, userId]
  );
  return !!row?.populated;
}

/**
 * How many of this user's rows have not reached the server: 'pending' or
 * 'deleted', in any table. Scoped as wipeLocalData deletes: `user_id = ?`, and
 * splits (which have no user_id) through their parent, the join
 * lib/syncStatus.ts counts them with. resetLocalData's guard and the wipe's own
 * re-count both ask this one query, so the two cannot drift apart (#97).
 */
async function countUnsyncedRows(db: any, userId: string): Promise<number> {
  const row: any = await db.getFirstAsync(
    `SELECT
     (SELECT COUNT(*) FROM accounts
        WHERE user_id = ? AND _sync_status IN ('pending','deleted')) +
     (SELECT COUNT(*) FROM transactions
        WHERE user_id = ? AND _sync_status IN ('pending','deleted')) +
     (SELECT COUNT(*) FROM transaction_splits ts
        INNER JOIN transactions tx ON tx.id = ts.transaction_id
        WHERE tx.user_id = ? AND ts._sync_status IN ('pending','deleted')) +
     (SELECT COUNT(*) FROM recurring_rules
        WHERE user_id = ? AND _sync_status IN ('pending','deleted')) AS c`,
    [userId, userId, userId, userId]
  );
  return Number(row?.c ?? 0);
}

/** Why a reset did not run: `count` of the user's rows are still unsynced. */
function unsyncedRefusal(count: number): Error {
  return new Error(
    `Couldn't upload ${count} unsynced change(s) — reset cancelled so they aren't lost. Check your connection and try again.`
  );
}

/**
 * Clears ONE user's local rows and that user's four sync_meta keys, and nothing
 * that belongs to another account signed in on this device (#87). Exported for
 * direct testing.
 *
 * Refuses while any of this user's rows is unsynced (#97): it counts them again
 * as the first statement of its own transaction, and if there are any it
 * commits that transaction without deleting anything and then throws the
 * reset's own refusal. So a row written after the guard counted is kept, not
 * wiped unpushed.
 *
 * Splits have no user_id, so they are found through their parent, and they go
 * FIRST: once the parents are gone nothing ties a split to this user any more.
 * The keys go in the same transaction, so the wipe lands whole or not at all:
 * another transaction on the shared connection waits for it, or it for that
 * one (#110; see inside). Once it has landed the re-download has no cursor to
 * start from, so it reads everything, and one that throws leaves both pull
 * keys unset, so needsInitialPull turns true.
 */
export async function wipeLocalData(db: any, userId: string): Promise<void> {
  let refused = 0;
  await db.withTransactionAsync(async () => {
    // resetLocalData's guard counted these rows before the probe's round trip
    // (up to 30 s), and mutation hooks write straight to SQLite, ungated by the
    // sync lock: an edit landing in between used to be wiped unpushed (#97).
    //
    // A refusal COMMITS, and throws only once the transaction is over. Nothing
    // of the wipe's is in it yet, but a hook's plain write (one made outside
    // withTransactionAsync) may be: withTransactionAsync is BEGIN/COMMIT on
    // the connection every hook shares, not an exclusive lock, so such a write
    // landing between the BEGIN and this count runs inside this transaction,
    // and throwing here would roll it back: the very row the count reports as
    // kept.
    //
    // This NARROWS the window; it does not close it. A plain write landing
    // between two of the DELETEs below is wiped or survives depending on
    // whether its table's DELETE has already run: one statement wide, where it
    // used to be a network round trip.
    //
    // A hook with a transaction of its own (transactionUpdate.ts,
    // transferCreate.ts, transactionDelete.ts, accountDelete.ts,
    // usePostRecurringTransaction, useReorderAccounts) never lands in here:
    // every withTransactionAsync on the connection waits for the one before it
    // (#110, lib/transactionQueue.ts). Before that its BEGIN failed in here,
    // and expo-sqlite's ROLLBACK ended THIS transaction: the DELETEs after it
    // committed one at a time, and the reset rejected with the raw "cannot
    // rollback - no transaction is active" (and a wipe whose BEGIN landed in a
    // hook's transaction ended that one). Now arrival order decides. A hook
    // that went first leaves its rows pending, and this count refuses over
    // them. One that comes after runs over the emptied store: a delete or a
    // reorder matches nothing, and the re-download brings the row back for the
    // user to try again; an account delete matches nothing too, and the
    // re-download restores the account and its children; an update finds no
    // row, so mapTransaction throws and the mutation fails, its optimistic
    // change undone on screen. Once a splits UI passes `splits` (#26), that
    // update's new split rows commit anyway, and after the re-download the next
    // push uploads them beside the parent's old ones: a -10 parent re-split
    // into -4 and -6 ends with server splits -10, -4 and -6.
    // The fix is for an update to fail inside its transaction when its parent
    // UPDATE matches nothing (a follow-up). A transfer or a recurring post
    // writes pending rows into the emptied store, which the re-download
    // upserts around and the reset's drain pushes (the post's rule advance
    // matches nothing, so the rule comes back due, and its duplicate guard
    // makes the next post an advance only).
    const unsynced = await countUnsyncedRows(db, userId);
    if (unsynced > 0) {
      refused = unsynced;
      return;
    }
    await db.runAsync(
      `DELETE FROM transaction_splits
       WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)`,
      [userId]
    );
    await db.runAsync('DELETE FROM transactions WHERE user_id = ?', [userId]);
    await db.runAsync('DELETE FROM recurring_rules WHERE user_id = ?', [
      userId,
    ]);
    await db.runAsync('DELETE FROM accounts WHERE user_id = ?', [userId]);
    // Listed, not matched by pattern, so the wipe can never take a key it does
    // not know. These four are every sync_meta key the engine reads or writes
    // (getSyncMeta/setSyncMeta here and in lib/syncStatus.ts). A NEW per-user
    // key must be added here as well, or it survives into the re-download: a
    // surviving cursor makes the re-download skip everything older than it,
    // and a surviving last_pull_attempt_at keeps needsInitialPull false after
    // a re-download that threw, so the next launch syncs over a half-filled
    // store instead of bootstrapping it.
    await db.runAsync('DELETE FROM sync_meta WHERE key IN (?, ?, ?, ?)', [
      `last_pull_at:${userId}`,
      `last_pull_attempt_at:${userId}`,
      `last_txn_pull_at:${userId}`,
      `last_txn_reconcile_at:${userId}`,
    ]);
  });
  if (refused > 0) {
    throw unsyncedRefusal(refused);
  }
}

/**
 * Nuclear recovery: discard the signed-in user's local cache and re-download it
 * from the cloud. The escape hatch for a local store that drifted past what the
 * normal sync can heal (e.g. an OPFS file "Clear site data" won't drop). Scoped
 * to that user: another account signed in on this device keeps its rows, its
 * unsynced work and its sync_meta keys (#87).
 *
 * Correctness hinges on holding the _syncInProgress lock for the WHOLE
 * operation, and on calling the lock-free primitives (pushChanges/pullChanges)
 * rather than fullSync/initialPull. Calling the lock-managing variants would
 * release and re-acquire the lock between steps, letting an AppState/NetInfo
 * triggered fullSync slip into the gap and either (a) race wipeLocalData on the
 * same DB connection or (b) hold the lock when the re-bootstrap runs — making
 * initialPull early-return and leaving the device wiped-but-empty.
 *
 * Order, with each step guarding against data loss:
 *   0. REFUSE without a session (#95), or under another user's (#111). With
 *      none, the push in step 1 would refuse too, leaving step 1 to blame the
 *      unsynced rows, and the probe in step 2, signed with the anon key, read
 *      `[]` with no error, which was "reachable". Since #109 that probe is
 *      refused before it is sent, so it would fail as "Can't reach the
 *      cloud"; this check refuses first, in the sign-in's own words. Under
 *      another user's session the probe is signed and sent, and RLS answers
 *      this user's rows `[]` with no error, still "reachable": this check and
 *      2b are what stop that reset.
 *   1. Flush unsynced edits UP, then REFUSE to proceed if any of this user's
 *      rows is still pending — pushChanges swallows per-row errors, so a
 *      silently-failed upload would otherwise be wiped away.
 *   2. Confirm the cloud is reachable before wiping (an offline reset must not
 *      empty a device it can't refill).
 *   2b. Check the session again as the LAST thing before the wipe: it can go,
 *      or pass to another user, during the push and the probe, and a wipe
 *      followed by a pull that reads nothing downloads nothing into an empty
 *      device.
 *   3. Wipe this user's rows and sync keys, then re-download with
 *      throwOnError so a mid-download failure is reported as a failed reset
 *      rather than a silently half-empty cache. The wipe first counts again
 *      and refuses as step 1 does, since a mutation hook may have written in
 *      between (#97). A failed download READ (either whole table, a
 *      transaction page, a split batch) throws and fails the
 *      reset as before, leaving both pull keys unset, so needsInitialPull
 *      turns true and the next launch re-bootstraps via initialPull — which,
 *      over any rows the failed download landed, runs pullChanges rather than
 *      its loop (#96) — unless a pull runs first: a queued full sync that
 *      finishSync drains, or any later sync, records an attempt if it gets as
 *      far as its reads (one refused for want of a session stamps neither,
 *      #95), and the recovery is then that no-cursor pullChanges instead. A
 *      failed reconcile enumeration or refresh batch does not throw: the reset
 *      resolves, the pull reports through setLastError, last_pull_at is
 *      withheld (#66), and the next sync retries the reconcile, whose key the
 *      wipe cleared.
 */
export async function resetLocalData(userId: string): Promise<void> {
  if (_syncInProgress) {
    throw new Error(
      'A sync is already in progress — please try again in a moment.'
    );
  }
  // Steps 0 and 2b. Thrown, so the catch below reports it like every other
  // refusal and Settings shows it; nothing local has been touched either time.
  // A session that is another user's is refused here too (#111), and said so:
  // "Signed in as a different account — reset cancelled, …".
  const refuseWithoutSession = async () => {
    const refused = await sessionFailure(userId);
    if (refused) {
      throw new Error(
        `${describePullFailure(refused)} — reset cancelled, your local data is unchanged.`
      );
    }
  };
  const run = async () => {
    try {
      setSyncing(true);
      setLastError(null);
      const db = await getDb();

      // 0) No session, no reset (#95; see the docblock).
      await refuseWithoutSession();

      // 1) Flush unsynced local edits up first so the wipe can't lose them.
      await pushChanges(userId);

      // 1b) pushChanges swallows per-row Supabase errors (leaving rows 'pending'),
      //     so confirm nothing is still unsynced before we wipe. If a push
      //     silently failed (RLS, intermittent write), abort rather than discard
      //     an edit that never reached the cloud.
      //
      //     Counted with the same predicates wipeLocalData deletes with, and
      //     the two must stay in step: this user's rows only, and splits
      //     through their parent (they have no user_id), the join
      //     lib/syncStatus.ts counts them with. The same predicates, and since
      //     #97 the wipe re-counts them as the first statement of its own
      //     transaction, because mutation hooks are not gated by the lock and
      //     the probe's round trip (up to 30 s) and 2b's session check sit
      //     between this count and the wipe. Until #87 both the count and the
      //     wipe were device-wide, and while the wipe took every account's
      //     rows, refusing over ANY account's unsynced ones was the
      //     conservative choice. It
      //     also made one account hostage to another: with two accounts on a
      //     device, a's reset was refused over b's rows, which a can neither
      //     see nor push (every push read is `user_id = ?`-scoped), and a reset
      //     that did run threw away b's cache and cursors. Per-user is correct
      //     now that #63 (#81) made the multi-user path coherent everywhere
      //     else: another account's rows are neither counted nor touched.
      const unsynced = await countUnsyncedRows(db, userId);
      if (unsynced > 0) {
        throw unsyncedRefusal(unsynced);
      }

      // 2) Confirm the cloud is reachable BEFORE destroying the local copy.
      //    supabase-js returns an error (not a throw) when the request fails —
      //    offline, or timed out, or, since #109, refused because it would go
      //    out signed with the anon key: a session lost after step 0 fails the
      //    probe as "Can't reach the cloud — … (your sign-in could not be
      //    verified)". Before #109 that probe read `[]` with no error, which is
      //    what the session checks around it were for. Signed as another user
      //    it still does, which 2b's check catches (#111). With this user's
      //    session, a clean read is our go-ahead to wipe.
      const probe = await supabase
        .from('accounts')
        .select('id')
        .eq('user_id', userId)
        .limit(1);
      if (probe.error) {
        throw new Error(
          `Can't reach the cloud — reset cancelled, your local data is unchanged. (${describeRequestError(probe.error)})`
        );
      }

      // 2b) The session again, as the last thing before the wipe (#95): the
      //     push and the probe are round trips it can go during. Outside any
      //     SQLite transaction on purpose: inside the token's 90 s expiry
      //     margin this is a refresh of up to 30 s, and on web it can first
      //     wait up to 5 s for auth-js's cross-tab lock, or queue behind a
      //     refresh already in flight — none of which may hold a transaction
      //     open. It sits in 1b's count-to-wipe window and widens it by as
      //     much; the wipe's own re-count (#97) covers what lands there.
      await refuseWithoutSession();

      // 3) Drop this user's rows + sync keys, then fully re-download.
      //    throwOnError turns a failed download into a thrown reset (both pull
      //    keys stay unset → the next launch re-bootstraps — unless a pull runs
      //    first; see the docblock) instead of a silent, partially-empty cache.
      await wipeLocalData(db, userId);
      await pullChanges(userId, { throwOnError: true });
    } catch (e) {
      console.warn('[sync] reset failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      await finishSync(userId);
    }
  };
  // Take the lock with no await since the refusal above, and record the holder:
  // the reset never asks WHO holds the lock, but a request arriving for another
  // user during it must be able to see that this reset is not theirs to ride.
  // _inFlight is acquireLock's deferred, which finishSync resolves and nothing
  // rejects, so the reset's rejection reaches its own caller (below) without
  // ever reaching a caller waiting on the lock.
  acquireLock(userId);
  await run();
}

/**
 * The first download of `userId`'s data onto this device, run by
 * startSyncSession while needsInitialPull is true. It never throws, and
 * startSyncSession relies on that: every failure is caught below and reported
 * through setLastError.
 *
 * Its loop is written for an EMPTY store, and since #96 it only starts over
 * one that holds none of this user's rows. It reads live rows only, inserts
 * every split it reads whatever the parent's local status, and stamps all
 * three keys from a snapshot taken before its first read; a failed read
 * throws, so nothing is stamped and the pull that runs next starts from
 * nothing. The store is checked once, before the first read, so a row written
 * during the download is not covered: a parent the loop has landed and the
 * user re-splits before its split batch is read still gets the server's
 * splits beside the re-split, as it always has. A store that already holds any
 * of this user's rows goes to pullChanges instead, under that pull's contract:
 * a failed read is swallowed and reported, last_pull_attempt_at is stamped
 * whenever it gets as far as its reads (a refusal for want of a session stamps
 * neither key, #95), and last_pull_at only by a complete pull.
 *
 * Holds the sync lock like every other entry point. A bootstrap requested
 * while a sync for the same user holds it becomes a queued full sync, which
 * runs that same pullChanges; one requested while another user's sync holds it
 * waits for the release and then runs as if it had found the lock free, store
 * check included (#63).
 */
export async function initialPull(userId: string): Promise<void> {
  // Participate in the _syncInProgress lock the same way fullSync does.
  // Without this, requestPush() called from a mutation hook (e.g. an
  // optimistic create that fires while initialPull is still iterating
  // remote rows) runs concurrently with the pull. The pull's
  // upsertRemoteX writes can then race the push's mark-as-synced
  // statement, and the row ends up either with stale remote data or
  // marked synced before the push actually committed remotely.
  while (_syncInProgress) {
    if (_holderUserId !== userId) {
      // A bootstrap requested while ANOTHER USER's sync holds the lock must not
      // queue: the drain runs as the holder, so it would push and pull their
      // rows, stamp their cursors, and leave this device with nothing
      // downloaded for the user who asked — `needsInitialPull` still true and
      // no error to show (#63). Wait for the release and run the bootstrap
      // ourselves, store check included (#96).
      console.warn('[sync] initialPull for another user waiting for the lock');
      await _inFlight;
      continue;
    }
    // A bootstrap requested while a sync for the SAME user holds the lock
    // becomes a queued full sync, which the holder drains before it releases
    // the lock. That beats what used to happen here — a silent return that left
    // the bootstrap to whichever trigger came next, if any — but with the
    // cursors unset it is a pullChanges, not an initialPull, and the two differ:
    //
    //   - It swallows and reports a failed read where initialPull throws, and
    //     stamps last_pull_attempt_at whether or not it completed (unless it
    //     was refused for want of a session, which stamps neither, #95), so
    //     needsInitialPull turns false over a partial download; only
    //     last_pull_at, the "Last synced" line, waits for a pull that completes
    //     (#66). That is safe only because, with no cursor, every read
    //     pullChanges swallows and reports is retried by the next sync:
    //     accounts and rules are read whole on every pull, a failed reconcile
    //     does not bank its key, last_txn_pull_at is held back over a failed
    //     transaction page or a failed split batch (the guard at the end of
    //     pullTransactions), and a reconcile that could not read a healed
    //     parent's splits does not bank its key (#62). No remote read is keyed
    //     on either pull key; they only answer needsInitialPull, and
    //     last_pull_at feeds the "Last synced" line in Settings.
    //   - It costs more. With no cursor the incremental read has no deleted_at
    //     filter, so every tombstoned transaction comes down too, and the
    //     reconcile enumeration runs in the same pull. For a user with no
    //     remote transactions that enumeration can never bank its key (an
    //     empty read is not authoritative), so it repeats, one empty page per
    //     sync, until the first transaction exists.
    //
    // run() below takes this same substitute itself, under the same contract,
    // when it finds the store already holding this user's rows (#96).
    //
    // For the SAME user, waiting for the lock and running the real bootstrap
    // instead would buy only that cost back, and would not protect a fresh
    // device: when initialPull gives up, startSyncSession runs this same pull
    // straight after it. The cursor guard is what makes both paths converge.
    // None of that holds across users, which is why the branch above waits.
    _fullSyncQueued = true;
    console.warn(
      '[sync] initialPull requested while a sync is in flight; queued a full sync'
    );
    await _inFlight;
    return;
  }
  const run = async () => {
    try {
      setSyncing(true);
      setLastError(null);
      const startedMs = Date.now();
      console.log('[sync] initialPull start');
      const db = await getDb();

      // Refused before the first read without a session (#95), or under
      // another user's (#111). Signed with the anon key, or with that user's
      // token under its RLS, every read below would answer `[]`, cleanly, and
      // the stamps at the end would declare this device fully pulled over
      // nothing, banking both transaction keys past every row the server
      // holds. readAllPages would fail the first empty page too, and since
      // #109 the fetch wrapper refuses to send an anon-signed read at all
      // (not one signed as another user), but both fail it as "initialPull
      // accounts failed", which names the wrong thing. Thrown, so the catch
      // below reports it and nothing is stamped.
      const refused = await sessionFailure(userId);
      if (refused) {
        throw new Error(describePullFailure(refused));
      }

      // The loop below is written for a store that holds none of this user's
      // rows, and over one that does it is unsafe twice over (#96). Its split
      // loop neither filters by the parent's local status nor deletes stale
      // synced splits, so it inserts the server's splits beside a pending
      // re-split, or beside synced ones another device has since replaced,
      // and the next push uploads both sets. And its reads skip tombstones
      // while its stamps bank both transaction keys past them, so a deletion
      // made elsewhere survives here until the daily reconcile.
      // needsInitialPull keeps the ordinary paths away (#66). What still
      // arrives populated:
      //
      //   - a first bootstrap killed mid-download (rows landed, no keys;
      //     probably the commonest way in);
      //   - one that gave up on a failed read (a session lost mid-download
      //     included, #95) with no pull after it to record an attempt: its
      //     session was cancelled before startSyncSession's fullSync, or that
      //     fullSync was refused for want of a session (a refusal stamps
      //     neither key, #95), or its push threw before it reached the pull
      //     (as pushTable's unguarded JSON.parse of a malformed rule template
      //     can);
      //   - a reset whose download threw after landing some tables;
      //   - a local write or realtime event that landed a row before this
      //     check (benign: the pull below still completes over it).
      //
      // pullChanges is written for a populated store, and it is the substitute
      // the queued branch above already runs. With the cursors unset, as they
      // are on those paths, its first read returns every row, tombstones
      // included; its reconcile is due, or was banked by the very download
      // that threw; and its split refresh skips unsynced parents and deletes a
      // synced parent's splits before reinserting the server's. What it does
      // not cover: a parent that went pending before its splits landed (edited
      // any time before this pull's split refresh reaches it, this relaunch
      // included) has none locally, and the refresh skips it. The next push
      // used to delete its server splits and upload none; since #97 it uploads
      // such a parent alone and the server keeps its splits, which the pull
      // after that push brings down here (the split-guard comment at
      // `splitsChanged` in pushChanges names the one exception, a device clock running ahead of the server's). The fix
      // belongs on the push side, not in a filter here.
      //
      // So this branch takes that substitute's contract, not the loop's: a
      // failed read is swallowed and reported through setLastError,
      // last_pull_attempt_at is stamped whenever the pull gets as far as its
      // reads (the session was checked just above; one lost since is refused
      // and stamps neither key, #95), and last_pull_at only when the pull
      // completed. It must never fall through to the stamps at the end of the
      // loop, which would claim a complete pull and bank the cursor and the
      // reconcile key whatever pullChanges could not read.
      if (await hasRowsForUser(db, userId)) {
        console.warn(
          '[sync] initialPull over a store that already holds rows for this user: running pullChanges instead (#96)'
        );
        await pullChanges(userId);
        return;
      }

      // Every remote read below checks `error` and throws on failure. A
      // swallowed error here is catastrophic: initialPull would load a
      // partial (or empty) dataset, then set the cursor meta at the end,
      // marking the local DB "fully pulled as of now" — and nothing ever
      // back-fills the missing rows (incremental pull only fetches
      // updated_at > cursor; reconciliation only deletes). Throwing leaves
      // the cursors unset, so the pull that runs next (startSyncSession's
      // fullSync, straight after this) starts from nothing and re-reads
      // everything.
      //
      // `.is('deleted_at', null)` on all three reads below: a bootstrap starts
      // from an empty local DB, so a tombstone carries no information here — it
      // is a delete instruction for a row this device has never had. Loading one
      // would be strictly worse than skipping it, because the upsert guards drop
      // it anyway and it would only pad the pages we walk.
      const bootstrapStartedAt = new Date().toISOString();

      const { data: accounts, error: acctErr } = await readAll<any>(
        (from, to) =>
          supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId)
            .is('deleted_at', null)
            .order('id')
            .range(from, to),
        { userId }
      );

      if (acctErr) {
        throw new Error(
          `initialPull accounts failed: ${describeRequestError(acctErr)}`
        );
      }
      for (const row of accounts) {
        await upsertRemoteAccount(db, row);
      }

      const { data: rules, error: ruleErr } = await readAll<any>(
        (from, to) =>
          supabase
            .from('recurring_rules')
            .select('*')
            .eq('user_id', userId)
            .is('deleted_at', null)
            .order('id')
            .range(from, to),
        { userId }
      );

      if (ruleErr) {
        throw new Error(
          `initialPull recurring_rules failed: ${describeRequestError(ruleErr)}`
        );
      }
      for (const row of rules) {
        await upsertRemoteRule(db, row);
      }

      const allTxnIds: string[] = [];
      // Streamed rather than accumulated: a bootstrap of a long history would
      // otherwise hold every remote row in memory alongside the ids.
      const { error: txnErr, rows: txnRows } = await readAllPages<any>(
        (from, to) =>
          supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .is('deleted_at', null)
            .order('id')
            .range(from, to),
        async (rows) => {
          for (const row of rows) {
            await upsertRemoteTransaction(db, row);
            allTxnIds.push(row.id);
          }
        },
        { userId }
      );
      if (txnErr) {
        // `rows` is the offset the failed page started at, since every page
        // advances by exactly the rows it returned.
        throw new Error(
          `initialPull transactions page @${txnRows} failed: ${describeRequestError(txnErr)}`
        );
      }

      if (allTxnIds.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < allTxnIds.length; i += BATCH) {
          const batch = allTxnIds.slice(i, i + BATCH);
          const { data: splits, error: splitErr } = await readAll<any>(
            (from, to) =>
              supabase
                .from('transaction_splits')
                .select('*')
                .in('transaction_id', batch)
                .order('id')
                .range(from, to),
            { userId }
          );

          if (splitErr) {
            throw new Error(
              `initialPull splits batch failed: ${describeRequestError(splitErr)}`
            );
          }
          for (const row of splits) {
            await upsertRemoteSplit(db, row);
          }
        }
      }

      console.log(
        `[sync] initialPull loaded ${allTxnIds.length} transactions in ${Date.now() - startedMs} ms`
      );

      // Stamp the cursors from the snapshot taken BEFORE the first remote read,
      // never from "now". A bootstrap of a large history takes many round trips,
      // and anything another device commits during them is already in the pages we
      // read or it is not — banking an end-of-pull timestamp declares that whole
      // window pulled, so `gt('updated_at', cursor)` skips it forever. The same
      // reasoning is why pullTransactions advances to pullStartedAt.
      const now = bootstrapStartedAt;
      await setSyncMeta(`last_pull_at:${userId}`, now);
      await setSyncMeta(`last_txn_pull_at:${userId}`, now);
      // A bootstrap just walked every live remote transaction, which is exactly
      // what the periodic reconcile does — so record it as one. Without this the
      // very next pull would repeat that full enumeration for nothing.
      await setSyncMeta(`last_txn_reconcile_at:${userId}`, now);
    } catch (e) {
      console.warn('[sync] initial pull failed:', e);
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      await finishSync(userId);
    }
  };
  acquireLock(userId);
  await run();
}

/**
 * Reads back the `updated_at` the server actually stored for a row we just
 * pushed.
 *
 * Postgres has a BEFORE UPDATE trigger that overwrites `updated_at` with
 * `now()` on every edit (supabase/migrations/001_initial.sql). Pushing without
 * reading the row back therefore left the local copy holding the client's
 * timestamp while the server held a different one — a guaranteed disagreement
 * on every edit-then-push, not an edge case. The reconcile pass then saw that
 * drift, declared the row stale, and re-fetched it on the next sync. That is
 * what the force-refresh/self-heal machinery was built to tolerate.
 *
 * Returns null when the server didn't report one, in which case callers keep
 * the local value rather than writing a null over it.
 */
function serverUpdatedAt(data: any): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row?.updated_at ?? null;
}

/**
 * Reads back the `deleted_at` the server holds for a row we just pushed.
 *
 * Non-null means another device tombstoned the row while we were editing it:
 * our upsert landed ON the tombstone. PostgREST writes only the keys the
 * payload carries and an edit never carries `deleted_at`, so the tombstone
 * survives our upsert and the row stays dead server-side. The caller must drop
 * the row locally rather than mark it 'synced' — DELETE WINS OVER A CONCURRENT
 * EDIT.
 *
 * That is a deliberate semantic, and it is strictly better than what it
 * replaces: against hard deletes the same race RESURRECTED the row server-side
 * (our upsert re-inserted what the other device had just removed), and every
 * other device then pulled the zombie back down. Losing the in-flight edit is a
 * smaller harm than silently undoing a delete everywhere.
 *
 * Returns null both when the key is absent and when it is an explicit null —
 * PostgREST renders "live" either way depending on the select (see isTombstone).
 */
function serverDeletedAt(data: any): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row?.deleted_at ?? null;
}

/**
 * Ids per tombstone UPDATE. Chunked rather than unbounded because PostgREST
 * encodes `in.(...)` into the query string and intermediaries cap URL length;
 * 200 keeps a single request comfortably well-formed while collapsing a
 * 10k-row account delete from 10k sequential round trips to 50.
 */
const TOMBSTONE_BATCH_SIZE = 200;

/**
 * The newest server migration this build requires, named in the message below.
 * One constant so the instruction cannot drift from the file it names — it went
 * stale silently the moment a second migration became load-bearing.
 */
const REQUIRED_MIGRATION = '006_split_updated_at.sql';

/**
 * Does this PostgREST error mean the server is missing a column this build
 * needs, rather than something transient?
 *
 * It matters because the failure is otherwise completely silent and total. Push
 * swallows per-row errors by design (a row stays 'pending' and is retried), so
 * deploying this client against a database where 005_tombstones.sql has NOT run
 * makes EVERY push fail — the read-back selects deleted_at and the delete path
 * writes it — while the UI reports only "N pending changes", forever, with no
 * hint that the server is the problem. Surfacing it once turns a mystery into an
 * instruction.
 *
 * 006_split_updated_at.sql has the same shape and a worse blast radius: the
 * split upload sends `updated_at` and selects it back, and a failed split
 * upload leaves the PARENT transaction 'pending' too, so one missing column on
 * a child table stops every transaction whose splits this device changed from
 * syncing (since #97 a parent whose splits are untouched goes up alone).
 */
function isMissingColumnError(error: any): boolean {
  const code = error?.code;
  if (code === '42703' || code === 'PGRST204' || code === 'PGRST202') {
    return true;
  }
  // Deliberately narrow: matching a bare column name anywhere in the message
  // would misreport ordinary failures as a missing migration and send the user
  // to fix a database that is already correct. Only these two columns are ever
  // added by a migration this client needs — and an `updated_at ... does not
  // exist` can only be about transaction_splits, since the other three tables
  // have carried it since 001.
  return /(deleted_at|updated_at)[\s\S]{0,40}does not exist/i.test(
    error?.message ?? ''
  );
}

/**
 * Did the server refuse this upsert because the row's id was purged (#98)?
 *
 * purge_tombstones() reclaims a tombstone 30 to 37 days after the delete, and
 * an edit pushed after that used to re-insert the row as live: the push
 * upserts on id, and no server row was left to keep the tombstone on.
 * 008_purged_ids.sql makes the purge record the id of every account,
 * transaction and rule it removes, and a BEFORE INSERT trigger refuses a
 * re-insert of one with `23503` and `hint: 'purged'`. That answer means what
 * a read-back tombstone means — the row was deleted elsewhere, and delete
 * wins — so the push drops the row the same way.
 *
 * Both halves are the contract with 008. The code alone would also match the
 * hint-less 23503 of a row the server has never held: 005's born-dead refusal,
 * or the plain foreign key that a child created offline under a purged account
 * meets. Dropping one of those destroys what the user typed, the very data
 * loss 005 refuses to cause, so it stays pending (CONTRIBUTING §4). And no
 * request-level failure ever carries `hint: 'purged'` (postgrest-js gives a
 * fetch error `''` and a timeout 'Request was aborted …'), so none matches.
 */
function isPurgedRowError(error: any): boolean {
  return error?.code === '23503' && error?.hint === 'purged';
}

/**
 * Uploads every local 'pending'/'deleted' row. Lock-free: callers hold the
 * _syncInProgress lock. Exported for direct testing — the post-push state is
 * what matters here, and fullSync's pull would mask it by re-fetching.
 *
 * Deletes are pushed as TOMBSTONES (backlog #18): instead of
 * `.delete().eq('id', id)`, the row gets `.update({ deleted_at })`, which is an
 * ordinary UPDATE and so bumps `updated_at` through the server trigger. That is
 * the entire point — a delete now appears in the cheap `updated_at > cursor`
 * incremental pull, so pulls stop enumerating every remote row on every sync
 * just to notice what another device removed.
 *
 * Two invariants that every tombstoning write below holds:
 *
 *  - `.is('deleted_at', null)` on the update. Without it, a retried push — or a
 *    row the server's `accounts_tombstone_children` trigger already stamped —
 *    gets re-stamped, which re-fires the `updated_at` trigger and re-broadcasts
 *    the same long-dead row to every other device on every sync. With it, the
 *    second write matches nothing and is a genuine no-op.
 *  - Never chain `.single()` on it. Zero matched rows is SUCCESS here (the row
 *    was never pushed, was already purged, or the cascade tombstoned it first)
 *    and must fall through to the local hard delete. `.single()` answers
 *    PGRST116 on zero rows, which reads as failure and would strand the row as
 *    'deleted' locally forever, retried on every single sync.
 *
 * That second invariant holds only for a request signed as the user. Signed
 * with the anon key, or with another user's token, a tombstone UPDATE matches
 * nothing whether or not the row is live, and the local hard delete that
 * follows silently undoes the delete: the server copy stays live and a later
 * pull brings it back. So a push with no session is refused outright (#95),
 * reported through setLastError, and every row stays queued; so is a push
 * under another user's session (#111), with a warning only. And since a
 * session can go, or change hands, while a push runs, every write whose
 * zero-match answer the push acts on asks again just before it is sent (#111):
 * each tombstone (once per row in pushTable, once per batch of transactions),
 * which on a refusal stops sending tombstones and leaves the rest queued, and
 * the split DELETE of a pending parent whose splits changed, which leaves that
 * parent pending. Each check is one session read — per tombstone row, per
 * batch of transactions and per changed parent — from storage on the happy
 * path, the price readAllPages' third rule pays per empty page. These checks
 * refuse first. What they leave is the window between a check and the
 * request's own session read, which supabase-js does when it signs the
 * request: two storage reads apart, milliseconds at most. A session LOST
 * inside it is caught one layer down since #109: lib/fetchWithTimeout.ts
 * refuses to send an anon-signed tombstone UPDATE or split DELETE, its error
 * branch leaves the row `deleted` (or the parent pending), and the next push's
 * entry check reports the sign-in. A session that passes to another user
 * inside it is not caught: that request is signed, so it is sent, and its
 * zero match is taken for success. The other writes need no check of their
 * own: an upsert or a split insert that is not the user's to make is refused
 * with 42501, and the row stays pending.
 *
 * A pending upsert learns that its row was deleted elsewhere in one of two
 * ways, and both drop the local copy silently, under the mark-synced guard
 * (splits only with a parent that went) — delete wins over a concurrent edit:
 *
 *  - The read-back carries `deleted_at` (serverDeletedAt): the edit landed on
 *    a tombstone, which PostgREST's partial upsert leaves in place.
 *  - The upsert is refused with `23503` and `hint: 'purged'`
 *    (isPurgedRowError, #98): the tombstone has been purged since, and 008's
 *    trigger refuses to re-insert the id. A hint-less 23503 is not this; it
 *    is a row the server never held, and it stays pending like any refusal.
 *
 * Push order stays accounts → rules → transactions, and the client keeps
 * pushing child tombstones itself instead of relying on the server cascade
 * trigger. Both orders must end correct — the trigger may have run first, or
 * may not exist on an older database — and the `.is('deleted_at', null)` no-op
 * is exactly what makes the client's own write harmless when it did.
 *
 * Splits ride their parent (#97). A pending parent's split set on the server is
 * replaced (delete-then-insert) only when one of its local splits is unsynced,
 * i.e. when this device changed them; a parent edited without touching its
 * splits is uploaded alone, and the server keeps its set, which the next pull
 * brings down unless the device clock runs ahead of the server's (see the
 * split-guard comment at `splitsChanged` below). Splits never travel without their parent, so the push
 * first ADOPTS any synced parent that has an unsynced split, marking it
 * pending again; otherwise nothing would ever send that split, and the reset
 * guard would count it forever. A 'deleted' split is never uploaded: the
 * remote delete-then-insert leaves it out, and it is hard-deleted locally once
 * its parent has been marked synced.
 */
export async function pushChanges(userId: string): Promise<void> {
  // Returned, not thrown: a throw would make fullSync skip its pull, the drain
  // log a failed follow-up and a reset rethrow — three behaviours for one
  // state, where reporting it and leaving every row queued is the one answer.
  const refused = await sessionFailure(userId);
  if (refused?.kind === 'wrong-user') {
    // Warned, not reported (#111). This is the outgoing user's push, run on
    // after another account signed in; that account's own sync clears
    // lastError as it starts, and a line left up would tell it about a sync
    // it did not ask for, with nothing to act on. The rows stay pending under
    // their user_id, and that user's next sign-in pushes them.
    console.warn(`[sync] push refused: ${sessionRefusalLog(userId, refused)}`);
    return;
  }
  if (refused) {
    console.warn('[sync] push refused: no session', refused.error);
    setLastError(describePullFailure(refused));
    return;
  }
  const db = await getDb();
  // Collected rather than thrown: a per-row failure must not abort the rest of
  // the push. Reported once at the end — see isMissingColumnError.
  let missingColumn: any = null;
  const note = (error: any) => {
    if (!missingColumn && isMissingColumnError(error)) {
      missingColumn = error;
    }
  };

  await pushTable(
    db,
    'accounts',
    userId,
    (row) => ({
      ...row,
      is_archived: !!row.is_archived,
      exclude_from_total: !!row.exclude_from_total,
    }),
    note
  );

  // NOTE: there is deliberately no separate deleted-rules loop further down in
  // this function. There used to be one and it was dead code — this pushTable
  // call has already tombstoned and hard-deleted every 'deleted' rule by the
  // time it returns, so that later SELECT could never return a row.
  await pushTable(
    db,
    'recurring_rules',
    userId,
    (row) => ({
      ...row,
      template:
        typeof row.template === 'string'
          ? JSON.parse(row.template)
          : row.template,
    }),
    note
  );

  // Adopt splits no push could reach (#97). Splits are uploaded only for a
  // PENDING parent (below), so a 'pending' or 'deleted' split under a SYNCED
  // parent was never sent, and the reset guard counted a row no push could
  // clear: "Reset & re-download" refused forever. A useDeleteTransaction
  // interrupted between its split and parent marks left that state before #97
  // made them one transaction (lib/transactionDelete.ts). So, still, does a
  // split written after a concurrent push has read its parent's splits:
  // useCreateTransaction and usePostRecurringTransaction insert the parent
  // before its splits, and a push on the same connection can read between the
  // two, inside a withTransactionAsync or not. The split write does not touch
  // the parent, which that push then marks synced. And so can an
  // applyTransactionUpdate whose transaction ends early, after its parent
  // write: the parent is rolled back to synced and its own changes are lost,
  // while its split writes commit alone. Before #110 a colliding transaction
  // on the shared connection did that. Transactions now wait their turn
  // (lib/transactionQueue.ts), so it takes SQLite abandoning the transaction
  // by itself on a storage failure (a full disk, an I/O error). Latent until
  // a splits UI (#26) passes `splits`.
  //
  // Marking the parent 'pending', with a fresh updated_at as a local edit
  // would, re-uploads it below with its whole split set: an adopted parent
  // carries an unsynced split by definition, so its server set is replaced
  // (see splitsChanged). A split-only upload would be invisible to other
  // devices: splits ride their parent's updated_at, so no incremental pull
  // would fetch the change.
  //
  // The cost is last-write-wins on a parent the user did not edit: the upsert
  // below overwrites any change to it that this device has not yet applied, as
  // it does for every pending parent. That exposure is confined to parents in
  // the state above. A parent deleted elsewhere stays deleted while its
  // tombstone lasts: the upsert lands on it, and the read-back below drops the
  // parent here too. It stays deleted once purge_tombstones has reclaimed the
  // tombstone as well (#98): 008 records the purged id and refuses to
  // re-insert it, and the same drop below takes the parent and its splits here
  // (isPurgedRowError), so the adoption cannot bring it back.
  const adopted = await db.runAsync(
    `UPDATE transactions SET _sync_status = 'pending', updated_at = ?
     WHERE user_id = ? AND _sync_status = 'synced'
       AND id IN (SELECT transaction_id FROM transaction_splits
                  WHERE _sync_status IN ('pending','deleted'))`,
    [new Date().toISOString(), userId]
  );
  if (adopted?.changes) {
    console.log(
      `[sync] re-queued ${adopted.changes} synced parent(s) of orphaned unsynced splits`
    );
  }

  const pendingTxns = await db.getAllAsync<any>(
    `SELECT * FROM transactions WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pendingTxns) {
    const { _sync_status, ...data } = row;
    const { data: saved, error } = await supabase
      .from('transactions')
      .upsert(data, { onConflict: 'id' })
      .select('id, updated_at, deleted_at')
      .single();
    // A purged row is refused, but that refusal is an answer, not a failure:
    // it is handled with the tombstone below, not here.
    const purged = isPurgedRowError(error);
    if (error && !purged) {
      console.warn(
        `[sync] push transactions ${row.id} rejected:`,
        error.code,
        error.message
      );
      note(error);
      continue;
    }

    // Our edit landed on a row another device tombstoned (see serverDeletedAt),
    // or on one whose tombstone has been purged since, which the server now
    // refuses to re-insert (see isPurgedRowError). Delete wins either way: drop
    // the row locally instead of marking it 'synced', and skip the split upload
    // below, which would otherwise re-populate splits for a parent that is dead
    // server-side. Silently in both cases — nothing is noted and no error is
    // set, because nothing went wrong.
    //
    // The local delete carries the SAME guard as mark-synced further down (id +
    // the updated_at we read + still 'pending'), so a newer local edit that
    // landed during the round trip is not destroyed on the strength of a read
    // that predates it: it stays pending and meets the tombstone (or the
    // refusal) again on the next push.
    if (purged || serverDeletedAt(saved) != null) {
      if (purged) {
        console.warn(
          `[sync] push transactions ${row.id}: deleted elsewhere and purged; dropping the local copy`
        );
      }
      const res = await db.runAsync(
        `DELETE FROM transactions
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
      );
      // Splits go only when the parent actually went. Dropping them
      // unconditionally would strip the splits off the very mid-flight edit the
      // guard above just refused to touch.
      if (res?.changes) {
        await db.runAsync(
          'DELETE FROM transaction_splits WHERE transaction_id = ?',
          [row.id]
        );
      }
      continue;
    }

    const savedAt = serverUpdatedAt(saved);

    // Replace the server's split set only when this device changed it (#97).
    // An edit that touches the splits leaves an unsynced split row under the
    // parent — new rows 'pending', the ones it replaced or removed 'deleted'
    // (transactionUpdate.ts) — and an adopted parent carries one by
    // definition; then this device's set is the newer one. A parent edited
    // WITHOUT touching its splits carries none, and this device's copy of them
    // may be stale or missing: another device re-split the parent since the
    // last pull, a download that failed left the parent here without them, or
    // realtime delivered the parent alone (applyTransactionEvent writes no
    // splits, #21) and the edit came before the next pull. Replacing the
    // server's set from that copy deleted the other device's splits, or all of
    // them, everywhere. So such a parent is uploaded alone and the server
    // keeps its set. The upsert above bumped the parent's server updated_at,
    // so the next pull lists it and refreshes its splits here
    // (pullTransactions, step 3) — unless this device's clock runs ahead of
    // the server's by more than the time since its last pull began. Then the
    // stamp this parent adopts falls below the pull cursor (client time), the
    // pull does not list it, the reconcile finds the stamps equal, and the
    // stale or missing copy stays until the parent next changes on the server
    // (CONTRIBUTING, Known Issues: clock skew). The server's copy is right.
    const splitsChanged: any = await db.getFirstAsync(
      `SELECT EXISTS (SELECT 1 FROM transaction_splits
                      WHERE transaction_id = ?
                        AND _sync_status IN ('pending','deleted')) AS changed`,
      [row.id]
    );

    let splitsSynced = true;
    // The splits as they were when we uploaded them, and the timestamp the
    // server rendered back for each. Both are needed below: the first supplies
    // the guard's "the value we read", the second the value to adopt.
    let uploadedSplits: any[] = [];
    let savedSplitAt = new Map<string, string | null>();
    // The split DELETE is the tombstone's kind of write (#111): signed as
    // anyone else it matches nothing, cleanly, and when every local split
    // under the parent is 'deleted' no insert follows to be refused, so the
    // parent would be marked synced and those splits dropped here while the
    // server kept them. So it is checked just before it is sent, and a
    // refusal leaves the parent pending for the next push, whose upsert is
    // idempotent.
    const splitRefusal = splitsChanged?.changed
      ? await sessionFailure(userId)
      : null;
    if (splitRefusal) {
      console.warn(
        `[sync] splits of transaction ${row.id} not sent: ${sessionRefusalLog(userId, splitRefusal)}`
      );
      splitsSynced = false;
    } else if (splitsChanged?.changed) {
      const { error: delSplitErr } = await supabase
        .from('transaction_splits')
        .delete()
        .eq('transaction_id', row.id);
      if (delSplitErr) {
        note(delSplitErr);
        splitsSynced = false;
      } else {
        // A 'deleted' split is left out: the delete above has just dropped it
        // from the server, and uploading it would bring it back to life on every
        // device. It is removed locally once the parent is marked synced.
        const localSplits = await db.getAllAsync<any>(
          `SELECT * FROM transaction_splits
           WHERE transaction_id = ? AND _sync_status != 'deleted'`,
          [row.id]
        );
        if (localSplits.length > 0) {
          // OMIT updated_at rather than sending null when a local row has none
          // (a split the migration-2 backfill could not reach, or one pulled from
          // a pre-006 server). The server column is `not null default now()`: an
          // absent key takes the default — the same shape an older client sends —
          // while an explicit null is rejected outright, which would strand the
          // parent 'pending' forever.
          //
          // The decision is made ONCE for the whole batch, not per row. For an
          // array, postgrest-js sends `?columns=` set to the union of the rows'
          // keys, and PostgREST fills a listed key that a row omits with NULL
          // (it does not reject mismatched keys when `columns` is given). So a
          // per-row omission beside a stamped sibling still arrives as an
          // explicit null, the insert fails with 23502, and that is not a
          // missing column, so it would stall the parent with no message at all.
          // Omitting the column for every row when ANY row lacks it costs only
          // that the server restamps siblings that did have a value — and the
          // read-back adopts the new stamp, so all of them heal in one push.
          const anySplitUnstamped = localSplits.some(
            (s: any) => s.updated_at == null
          );
          const splitData = localSplits.map(
            ({ _sync_status: _s, updated_at, ...s }: any) =>
              anySplitUnstamped ? s : { ...s, updated_at }
          );
          const { data: savedSplits, error: insSplitErr } = await supabase
            .from('transaction_splits')
            .insert(splitData)
            .select('id, updated_at');
          if (insSplitErr) {
            note(insSplitErr);
            splitsSynced = false;
          } else {
            uploadedSplits = localSplits;
            savedSplitAt = new Map(
              (savedSplits ?? []).map((s: any) => [s.id, s.updated_at ?? null])
            );
          }
        }
      }
    }

    if (splitsSynced) {
      // See pushTable comment: guard the transaction's status update on
      // updated_at AND the still-pending status, so a newer local edit
      // that landed during the in-flight upsert doesn't get clobbered.
      // Adopt the server's timestamp as part of the same guarded write, so
      // the local row agrees with the server the moment it becomes 'synced'.
      // The guard still compares against the value we READ, so a local edit
      // that landed mid-flight is left pending for the next push.
      const marked = await db.runAsync(
        `UPDATE transactions
         SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [savedAt, row.id, row.updated_at]
      );
      // Splits carry the SAME guard as their parent (#20): per id, on the
      // updated_at we uploaded, and still 'pending'. This used to be a blanket
      // `WHERE transaction_id = ?`, which could not tell whether the rows it
      // was marking were the ones it had just sent — so a split edit landing
      // during the round trip had its 'pending' overwritten by the reply to the
      // previous upload and was never replayed.
      //
      // An edit replaces splits (it marks the old rows 'deleted' and inserts
      // new ones under fresh ids), so the rows we uploaded are no longer
      // 'pending' and every statement here matches nothing; the replacements
      // stay 'pending' for the next push, which is the correct outcome. `IS`
      // rather than `=` because a local updated_at may legitimately be NULL
      // and SQLite's `=` is not NULL-safe (`NULL = NULL` is NULL, so the guard
      // would silently never match).
      for (const s of uploadedSplits) {
        await db.runAsync(
          `UPDATE transaction_splits
           SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
           WHERE id = ? AND updated_at IS ? AND _sync_status = 'pending'`,
          [savedSplitAt.get(s.id) ?? null, s.id, s.updated_at ?? null]
        );
      }
      // A 'deleted' split says only "this split must not exist on the
      // server", never "delete the parent": a splits UI (#26) may delete one
      // split and keep the rest, and applyTransactionUpdate marks the splits
      // an edit replaced or removed the same way. It was left out of the
      // upload, and the remote delete-then-insert has already dropped it, so
      // the local row can go — but only when the parent's mark-synced
      // matched, the same "splits go only when the parent went" rule as the
      // tombstone drop above and the deleted-transactions path below. A parent
      // re-dirtied mid-push keeps them for its next push, which leaves them
      // out again. Before #97 such a split was uploaded as a live row, and the
      // per-split mark-synced above (guarded on 'pending') never matched it,
      // so it stayed 'deleted' forever and the reset guard refused over it.
      if (marked?.changes) {
        await db.runAsync(
          `DELETE FROM transaction_splits
           WHERE transaction_id = ? AND _sync_status = 'deleted'`,
          [row.id]
        );
      }
    }
  }

  const deletedTxns = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  // One UPDATE per batch, not per row. This loop was a round trip per id, which
  // was survivable only because deleting an account took its children with it
  // through the FK cascade and left nothing here to push. A tombstone does not
  // cascade at the FK level, so deleting a busy account now queues a real write
  // per child transaction — thousands of sequential requests at one id each.
  const deletedAt = new Date().toISOString();
  for (let i = 0; i < deletedTxns.length; i += TOMBSTONE_BATCH_SIZE) {
    const batch = deletedTxns
      .slice(i, i + TOMBSTONE_BATCH_SIZE)
      .map((r) => r.id);

    // Signed as this user, checked just before the write (#111): see the
    // docblock. A large account delete runs many batches, long enough for a
    // sign-out that stopped waiting and the next sign-in to land between two.
    const batchRefusal = await sessionFailure(userId);
    if (batchRefusal) {
      console.warn(
        `[sync] tombstones not sent for ${deletedTxns.length - i} transaction(s): ${sessionRefusalLog(userId, batchRefusal)}`
      );
      break;
    }

    // Parent FIRST, splits second. The old order (splits, then parent) left a
    // live parent stripped of its splits whenever the parent write failed, and
    // nothing ever refetched it to repair the damage because the parent's
    // updated_at never moved. Tombstoning first makes the worst case a dead
    // parent whose splits linger until the purge cascades them out — invisible
    // rather than corrupt.
    const { error } = await supabase
      .from('transactions')
      .update({ deleted_at: deletedAt })
      .in('id', batch)
      .is('deleted_at', null);
    if (error) {
      console.warn(
        `[sync] tombstone transactions batch of ${batch.length} rejected:`,
        error.code,
        error.message
      );
      note(error);
      continue;
    }
    // Best effort. Splits carry no tombstone of their own (no user_id, and no
    // deleted_at — they ride their parent) so they stay hard-deleted, and a
    // failure here is not fatal: the parent already reads as deleted on every
    // other device, and purge_tombstones() takes the orphans out via the FK.
    await supabase
      .from('transaction_splits')
      .delete()
      .in('transaction_id', batch);

    const ph = batch.map(() => '?').join(',');
    // `AND _sync_status = 'deleted'` so a row somehow re-dirtied while this
    // push was in flight keeps its unsent edit instead of being dropped.
    await db.runAsync(
      `DELETE FROM transactions WHERE id IN (${ph}) AND _sync_status = 'deleted'`,
      batch
    );
    // Orphans only, for the same reason as the pending path above: a parent the
    // guard just spared still needs its splits.
    //
    // The inner SELECT repeats the id list rather than reading the whole table:
    // SQLite materialises a bare `NOT IN (SELECT id FROM transactions)` into an
    // ephemeral index over EVERY row, once per batch, so emptying a large
    // account would scan the register tens of times over. Bounded this way both
    // halves ride the primary key.
    await db.runAsync(
      `DELETE FROM transaction_splits
       WHERE transaction_id IN (${ph})
         AND transaction_id NOT IN (SELECT id FROM transactions WHERE id IN (${ph}))`,
      [...batch, ...batch]
    );
  }

  if (missingColumn) {
    // Deliberately the LAST thing the push does, so a real transient error that
    // requestPush/fullSync catches and reports still wins. Nothing here throws:
    // the rows stay 'pending' and retry, exactly as they would for any other
    // failure — the only change is that the user is told why they never drain.
    setLastError(
      'This app needs a database update that has not been applied yet: run ' +
        `supabase/migrations/${REQUIRED_MIGRATION}, and any earlier migration ` +
        'your database is still missing, through the migration workflow. ' +
        'Your changes are saved on this device and will sync once it is applied.'
    );
  }
}

async function pushTable(
  db: any,
  table: string,
  userId: string,
  transform: (row: any) => any,
  onError?: (error: any) => void
): Promise<void> {
  const pending = await db.getAllAsync(
    `SELECT * FROM ${table} WHERE _sync_status = 'pending' AND user_id = ?`,
    [userId]
  );
  for (const row of pending) {
    const { _sync_status, ...raw } = row;
    const data = transform(raw);
    const { data: saved, error } = await supabase
      .from(table)
      .upsert(data, { onConflict: 'id' })
      .select('id, updated_at, deleted_at')
      .single();
    // Purged is an answer, not a failure: handled with the tombstone below.
    const purged = isPurgedRowError(error);
    if (error && !purged) {
      console.warn(
        `[sync] push ${table} ${row.id} rejected:`,
        error.code,
        error.message
      );
      onError?.(error);
      continue;
    }

    // Edit landed on another device's tombstone, or on a row whose tombstone
    // has been purged since: delete wins either way, silently (serverDeletedAt,
    // isPurgedRowError). Guarded identically to mark-synced below, so a newer
    // mid-flight local edit stays 'pending' and meets the tombstone (or the
    // refusal) again next push rather than being thrown away here.
    if (purged || serverDeletedAt(saved) != null) {
      if (purged) {
        console.warn(
          `[sync] push ${table} ${row.id}: deleted elsewhere and purged; dropping the local copy`
        );
      }
      await db.runAsync(
        `DELETE FROM ${table}
         WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
        [row.id, row.updated_at]
      );
      continue;
    }

    // Only mark synced if updated_at still matches what we read AND the
    // row is still 'pending'. If a newer local edit lands while the
    // network upsert above is in flight, that edit bumps updated_at and
    // re-marks the row 'pending' — and we must NOT clobber it back to
    // 'synced', or the next push won't see it and a later pull can
    // overwrite the unsynced edit.
    // See serverUpdatedAt: adopt the server's timestamp here so the row
    // doesn't become 'synced' while still disagreeing with the server.
    await db.runAsync(
      `UPDATE ${table}
       SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at)
       WHERE id = ? AND updated_at = ? AND _sync_status = 'pending'`,
      [serverUpdatedAt(saved), row.id, row.updated_at]
    );
  }

  const deleted = await db.getAllAsync(
    `SELECT id FROM ${table} WHERE _sync_status = 'deleted' AND user_id = ?`,
    [userId]
  );
  const deletedAt = new Date().toISOString();
  for (const row of deleted) {
    // Signed as this user, checked just before the write (#111): the zero
    // matched rows below are success only then. See pushChanges' docblock.
    const refused = await sessionFailure(userId);
    if (refused) {
      console.warn(
        `[sync] tombstone ${table} ${row.id} not sent: ${sessionRefusalLog(userId, refused)}; the rest stay queued`
      );
      break;
    }
    // Both invariants from pushChanges' header apply here: `.is('deleted_at',
    // null)` stops a re-pushed or already-cascaded tombstone from re-stamping
    // updated_at and re-broadcasting a dead row, and there is deliberately no
    // `.single()` — zero matched rows is success and must reach the local
    // delete below.
    const { error } = await supabase
      .from(table)
      .update({ deleted_at: deletedAt })
      .eq('id', row.id)
      .is('deleted_at', null);
    if (error) {
      console.warn(
        `[sync] tombstone ${table} ${row.id} rejected:`,
        error.code,
        error.message
      );
      onError?.(error);
    } else {
      // `AND _sync_status = 'deleted'` so a row re-dirtied mid-push keeps its
      // unsent edit instead of being dropped.
      await db.runAsync(
        `DELETE FROM ${table} WHERE id = ? AND _sync_status = 'deleted'`,
        [row.id]
      );
    }
  }
}

/**
 * Why a pull step could not vouch for its table. `null` from a step means it
 * read and applied everything. `table` is the name a user reads ('recurring
 * rules', 'transaction splits'), never the PostgREST one.
 */
type PullFailure =
  // A remote read returned an error — including a NoSessionError, from a read
  // whose session went away between its pages (#95).
  | { kind: 'read'; table: string; error: unknown }
  // A #19 guard refused to treat an empty read as authoritative. No error
  // object exists here at all, so it must count all the same. A client with no
  // session stops short of it (refused before the read and on every empty page
  // since #95, and its requests refused before they are sent since #109, which
  // fail as a 'read'); what still arrives is a mis-scoped RLS policy, a
  // server-side filter bug, and a table that really was emptied and its
  // tombstones purged.
  | { kind: 'untrusted-empty'; table: string; localRows: number }
  // The client could not sign its requests (#95; see sessionFailure). Refused
  // before any read, so no table is named. `error` is why the session could
  // not be had — the refresh's failure — or null when there was simply none.
  | { kind: 'no-session'; error: unknown }
  // The client signs as another user (#111; see sessionFailure): an account
  // switch mid-sync. `sessionUserId` is whose session it is, for the console.
  | { kind: 'wrong-user'; sessionUserId: string | null };

/** What sessionFailure returns: the two ways a client cannot sign as a user. */
type SessionFailure = Extract<
  PullFailure,
  { kind: 'no-session' | 'wrong-user' }
>;

/** The two tables pullTableFull reads whole, keyed to the names a user reads. */
const FULL_PULL_TABLE_LABELS = {
  accounts: 'accounts',
  recurring_rules: 'recurring rules',
} as const;

/**
 * The "Sync issue: …" line for a pull that could not vouch for every table,
 * and for a sync refused because the client had no session (#95). Only this
 * user-facing copy goes through describeRequestError; the console.warn at each
 * failure site keeps the raw code and message (#83).
 *
 * A refused empty read says what happened and nothing more. It promises no
 * retry, because when the empty answer is genuine (every row deleted and the
 * tombstones since purged) the refusal repeats on every sync. Nor does it
 * point at Reset & re-download, whose reachability probe takes `[]` for
 * "reachable": over a read that is empty for the wrong reason — a mis-scoped
 * RLS policy — it would wipe this device and download nothing. The commonest
 * wrong reason used to be a session gone to the anon key; since #95 a pull
 * without a session is refused before it reads, and the reset refuses on the
 * same check.
 *
 * A refused session names the sign-in, not a table (nothing was read), in one
 * line with no nudge: when the refresh token was revoked, auth-js has already
 * signed the user out, and when the network has stalled, "sign out" would hang
 * on the unbounded /auth/v1/logout.
 *
 * A session that belongs to another user (#111) reads "Signed in as a
 * different account": short, since only a bootstrap and a reset report it
 * (pushChanges and pullChanges only warn), and the account the user is signed
 * in to now has nothing to fix. No id is named: the ids are for the console.
 */
function describePullFailure(failure: PullFailure): string {
  if (failure.kind === 'read') {
    return `Couldn't download ${failure.table}: ${describeRequestError(failure.error)}`;
  }
  if (failure.kind === 'no-session') {
    return failure.error == null
      ? "Couldn't verify your sign-in"
      : `Couldn't renew your sign-in: ${describeRequestError(failure.error)}`;
  }
  if (failure.kind === 'wrong-user') {
    return 'Signed in as a different account';
  }
  return (
    `The cloud returned no ${failure.table} but this device has ` +
    `${failure.localRows} — kept this device's copy.`
  );
}

/**
 * Downloads everything that changed remotely since the cursors. Lock-free:
 * callers hold the _syncInProgress lock. Exported for direct testing — what
 * matters here is the post-pull local state and which remote reads were issued
 * at all, and going through fullSync would hide both behind a push.
 *
 * `last_pull_at:<user>` is stamped only by a COMPLETE pull — every table read,
 * and every empty read trusted — and the result says whether it was (#66).
 * That key is the "Last synced" line in Settings; stamping it after a read
 * that failed told the user the device was current while nothing reached the
 * error line.
 *
 *   - All three steps run whatever the others did. A failed accounts read must
 *     not cost the user their rules and transactions; each step's own cursor
 *     and reconcile-key guards already make its partial work safe to keep.
 *   - A pull that could not vouch for every table reports its FIRST failure
 *     through setLastError and returns false, and it NEVER unsets the key: the
 *     time of the last complete pull stays the honest "Last synced".
 *   - Every run that gets past its reads also stamps `last_pull_attempt_at`,
 *     complete or not, from the same instant. needsInitialPull asks for both
 *     to be unset, so an incomplete pull still retires the bootstrap exactly as
 *     every pull did before #66; see there for why initialPull's loop must not
 *     run over the store an incomplete pull has already filled.
 *   - Under throwOnError the reads that threw before still throw before this
 *     point, and so stamp neither key: both whole-table reads, the incremental
 *     page and step 3's split batches. Nothing else starts to: a reconcile that
 *     could not complete, or an empty read a #19 guard refused, stamps the
 *     attempt, withholds last_pull_at and reports through setLastError without
 *     failing the reset.
 *   - A client with no session is refused before it reads anything (#95):
 *     "Couldn't renew your sign-in: …" through setLastError (thrown instead
 *     under throwOnError), false, and NEITHER key stamped — nothing was read,
 *     just as for a download that throws, so a fresh device still bootstraps
 *     on the next launch. So is a client signed in as another user (#111), an
 *     account switch mid-sync, except that it only warns (thrown, "Signed in
 *     as a different account", under throwOnError): the user signed in now has
 *     nothing to act on. A session that goes away, or passes to another user,
 *     mid-pull fails the read it was in (readAllPages' third rule), like any
 *     other failed read.
 */
export async function pullChanges(
  userId: string,
  opts: { throwOnError?: boolean } = {}
): Promise<boolean> {
  const db = await getDb();

  // With no session every read below would answer `[]` under the anon key, and
  // the reads no #19 guard covers would take that for "nothing changed": step
  // 1 would bank its cursor over a window it never read, and a new user's
  // empty pull would stamp itself complete (#95). Since #109 such a read is
  // refused before it is sent, so without this check every read would fail
  // instead, and the pull would still stamp its attempt; with it, nothing is
  // read or stamped, and the line names the sign-in. Under another user's
  // session RLS answers this user's rows the same way (#111), and those reads
  // are signed, so the wrapper sends them: for that session this check is the
  // only line. Stamping neither key
  // leaves a bootstrap that lost its session mid-download with rows and both
  // keys unset, so a relaunch before any sync succeeds runs initialPull over
  // them, which since #96 hands such a store to this pull rather than to its
  // loop.
  const refused = await sessionFailure(userId);
  if (refused) {
    const message = describePullFailure(refused);
    if (opts.throwOnError) {
      throw new Error(message);
    }
    if (refused.kind === 'wrong-user') {
      // Warned, not reported: see pushChanges.
      console.warn(
        `[sync] pull refused: ${sessionRefusalLog(userId, refused)}`
      );
      return false;
    }
    console.warn('[sync] pull refused: no session', refused.error);
    setLastError(message);
    return false;
  }

  // Sequential and unconditional — never `a && b`, which would skip the later
  // steps after the first failure.
  const accounts = await pullTableFull(
    db,
    'accounts',
    userId,
    upsertRemoteAccount,
    forceUpsertRemoteAccount,
    deleteLocalAccountIfSynced,
    opts
  );
  const rules = await pullTableFull(
    db,
    'recurring_rules',
    userId,
    upsertRemoteRule,
    forceUpsertRemoteRule,
    deleteLocalRuleIfSynced,
    opts
  );
  const transactions = await pullTransactions(db, userId, opts);

  // The attempt first, complete or not, and from the same instant as the
  // complete key below: needsInitialPull asks whether this device has pulled at
  // all, and "Last synced" asks when a pull last completed (see both).
  const now = new Date().toISOString();
  await setSyncMeta(`last_pull_attempt_at:${userId}`, now);
  const failure = accounts ?? rules ?? transactions;
  if (!failure) {
    await setSyncMeta(`last_pull_at:${userId}`, now);
    return true;
  }
  setLastError(describePullFailure(failure));
  return false;
}

async function pullTableFull(
  db: any,
  table: keyof typeof FULL_PULL_TABLE_LABELS,
  userId: string,
  upsertFn: (db: any, row: any) => Promise<void>,
  forceFn: (db: any, row: any) => Promise<void>,
  deleteFn: (db: any, id: string) => Promise<unknown>,
  opts: { throwOnError?: boolean } = {}
): Promise<PullFailure | null> {
  // Capture this BEFORE the remote select so the deletion reconciliation
  // below only considers rows that already existed locally at the start
  // of the pull. Otherwise: a row created locally + pushed AFTER our
  // remote snapshot becomes synced but isn't in `remoteIds`, so the
  // reconciliation step deletes it as if it had been remotely deleted.
  const pullStartedAt = new Date().toISOString();

  // Paged, because `max_rows` would otherwise hand the absence-delete loop
  // below a truncated snapshot and it would delete every local row past the
  // cutoff — the #19 guard only refuses an EMPTY read (#64). A partial read
  // reports as an error instead: `readAll` returns whatever pages it got plus
  // the error, and this branch discards both. It also absorbs the old
  // `!data` check — a page that answers `{ data: null, error: null }` ends the
  // read, so `data` here is always an array and an empty one falls through to
  // the #19 guard rather than to a separate early return.
  const { data, error } = await readAll<any>(
    (from, to) =>
      supabase
        .from(table)
        .select('*')
        .eq('user_id', userId)
        .order('id')
        .range(from, to),
    { userId }
  );

  if (error) {
    if (opts.throwOnError) {
      throw new Error(
        `Failed to download ${table}: ${describeRequestError(error)}`
      );
    }
    console.warn(`[sync] pull ${table} failed:`, error.code, error.message);
    return { kind: 'read', table: FULL_PULL_TABLE_LABELS[table], error };
  }

  // A tombstone is a delete, not data. Partitioning here (rather than at each
  // use) keeps the two halves from drifting apart: a tombstoned row must be
  // kept out of the upsert loop (feeding one to upsertFn re-INSERTs the row the
  // user just deleted) AND out of `remoteIds`, because counting it as present
  // is exactly what would stop the delete loop below from removing the local
  // copy. Accounts and rules stay full-table reads — both are tiny, and an
  // incremental read keyed off last_pull_at would skip mid-pull changes, since
  // that cursor is set to "now" after the pull finishes.
  const live = data.filter((r: any) => !isTombstone(r));

  const remoteIds = new Set(live.map((r: any) => r.id));

  // Synced local rows that existed at pull start, with timestamps — drives both
  // deletion reconciliation and drift detection. 'pending'/'deleted' rows are
  // excluded so unsynced edits are never force-overwritten or deleted.
  const locals = await db.getAllAsync(
    `SELECT id, updated_at FROM ${table}
     WHERE user_id = ?
       AND _sync_status = 'synced'
       AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))`,
    [userId, pullStartedAt]
  );
  const localUpdatedById = new Map<string, string | null>(
    locals.map((l: any) => [l.id, l.updated_at])
  );

  for (const row of live) {
    if (
      localUpdatedById.has(row.id) &&
      localUpdatedById.get(row.id) !== row.updated_at
    ) {
      // Synced locally but drifted from the server in EITHER direction —
      // including a correction whose updated_at is OLDER than ours, which the
      // guarded upsert refuses forever. Same self-heal as transactions (see
      // planTransactionReconcile / forceUpsertRemoteTransaction).
      await forceFn(db, row);
    } else {
      await upsertFn(db, row);
    }
  }

  // #19: a clean-but-EMPTY read is not authority to delete. A mis-scoped RLS
  // policy or a server-side filter bug returns `{ data: [], error: null }` —
  // indistinguishable here from "the user deleted every account" — and the
  // loop below would then wipe the local copy of every synced row in this
  // table. A client with no session would read the same `[]` under the anon
  // key; since #95 that is refused before the read and on every empty page
  // (readAllPages), and since #109 such a read is not even sent (the fetch
  // wrapper refuses it), so this guard is the backstop for the other two.
  // Refusing costs a user who genuinely emptied the table one "Reset &
  // re-download"; honouring it costs everyone else their data.
  //
  // The test is on raw `data`, not on `live`: a read that returns only
  // tombstones IS authoritative (the server answered, and its answer is "all
  // deleted"), so those rows must still fall through to the delete loop.
  if (data.length === 0 && localUpdatedById.size > 0) {
    console.warn(
      `[sync] ${table} deletion reconcile skipped: the server returned no rows ` +
        `while ${localUpdatedById.size} synced row(s) exist locally; refusing to ` +
        'treat an empty read as authoritative'
    );
    // Not a complete pull either (#66): an answer we refused to trust vouches
    // for nothing, so it must not stamp last_pull_at.
    return {
      kind: 'untrusted-empty',
      table: FULL_PULL_TABLE_LABELS[table],
      localRows: localUpdatedById.size,
    };
  }

  // Tombstoned rows arrive here by absence: they were filtered out of
  // `remoteIds` above, so this loop consumes them. It is already scoped to
  // synced rows that predate the pull (that is all localUpdatedById holds), so
  // a pending local edit or a queued local delete is never collateral.
  for (const [id] of localUpdatedById) {
    if (!remoteIds.has(id)) {
      // Re-check _sync_status in the DELETE itself rather than trusting the
      // localUpdatedById snapshot taken above. The snapshot is read before the
      // remote rows are upserted, and a mutation hook can mark a row 'pending'
      // during those awaits (the hooks write straight to SQLite and are not
      // gated by _syncInProgress). Deleting on the strength of the stale
      // snapshot would drop that edit AND the push that would have saved it.
      // Tombstones make this the ordinary path for every account/rule delete,
      // not the rare purge case it used to be.
      await deleteFn(db, id);
    }
  }
  return null;
}

export interface ReconcileRemoteRow {
  id: string;
  updated_at: string | null;
}

export interface ReconcileLocalRow {
  id: string;
  updated_at: string | null;
  _sync_status: string;
  // synced AND not newer than the pull's start snapshot — i.e. safe to delete
  // if absent remotely (won't drop a row created/pushed mid-pull).
  reconcilable: boolean;
}

export interface ReconcilePlan {
  toRefresh: string[];
  toDelete: string[];
}

/**
 * Pure decision for the transaction reconcile pass.
 *
 * The server is authoritative for 'synced' rows, so a synced local row whose
 * updated_at differs from the server's — in EITHER direction — is stale and
 * must be re-fetched. This is what makes the client self-heal: the incremental
 * pull only sees `updated_at > cursor`, so a server row corrected with an OLDER
 * timestamp than the device's cursor is invisible to it forever; comparing
 * against the LOCAL timestamp (not the cursor) catches it. Rows the server no
 * longer has are deleted; rows missing locally are fetched. Local rows with
 * unsynced edits ('pending'/'deleted') are never touched — push resolves those.
 */
export function planTransactionReconcile(
  remote: ReconcileRemoteRow[],
  local: ReconcileLocalRow[],
  /**
   * Did the enumeration actually come back with rows — counting tombstones,
   * which `remote` deliberately excludes? Defaults to `remote.length > 0`, which
   * is the honest answer whenever the caller has no separate signal.
   */
  remoteReadReturnedRows: boolean = remote.length > 0
): ReconcilePlan {
  // #19: an empty enumeration is never authoritative. Reaching here with no
  // rows back means either "the user deleted everything" or "the read silently
  // returned nothing" (mis-scoped RLS, a filter bug; a client with no session
  // would read nothing too, but since #95 and #109 its read fails before it
  // gets here). Deleting on that guess wipes the device; refusing costs a
  // genuinely-emptied account one "Reset & re-download".
  // Returning early rather than only suppressing toDelete also skips the
  // pointless refresh pass over an empty list.
  //
  // A caller that CAN tell the two apart — pullTransactions enumerates
  // tombstones rather than filtering them away, so "every row is deleted" comes
  // back as rows — says so via remoteReadReturnedRows, and then an all-deleted
  // answer is honoured instead of being refused forever.
  if (!remoteReadReturnedRows) {
    return { toRefresh: [], toDelete: [] };
  }

  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const localById = new Map(local.map((l) => [l.id, l]));

  const toDelete: string[] = [];
  for (const l of local) {
    if (l.reconcilable && !remoteById.has(l.id)) {
      toDelete.push(l.id);
    }
  }

  const toRefresh: string[] = [];
  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) {
      // Server has a row we've never stored locally — pull it.
      toRefresh.push(r.id);
    } else if (l._sync_status === 'synced' && l.updated_at !== r.updated_at) {
      // Synced locally but drifted from the server (incl. older-timestamp fixes).
      toRefresh.push(r.id);
    }
    // 'pending'/'deleted' local rows: leave for push to resolve.
  }

  return { toRefresh, toDelete };
}

/**
 * The subset of `candidates` whose LOCAL transaction row is 'synced'.
 *
 * Both split-refresh sites filter on this (#58), and both must re-read it AFTER
 * their parent upsert: a 'pending' or 'deleted' local parent carries unsynced
 * work that only push may resolve, and refreshing its splits inserts the
 * server's superseded copy beside the local replacement — which the next push
 * uploads together, turning a lost edit into a permanent duplicate. See the
 * long note above step 3 in pullTransactions for the full argument.
 */
async function syncedParentIds(
  db: any,
  candidates: string[]
): Promise<string[]> {
  if (candidates.length === 0) return [];
  // Filtered per batch so the IN list stays bounded and rides the primary key.
  const ph = candidates.map(() => '?').join(',');
  const rows: { id: string }[] = await db.getAllAsync(
    `SELECT id FROM transactions WHERE id IN (${ph}) AND _sync_status = 'synced'`,
    candidates
  );
  return rows.map((r) => r.id);
}

async function pullTransactions(
  db: any,
  userId: string,
  opts: { throwOnError?: boolean } = {}
): Promise<PullFailure | null> {
  // See pullTableFull for the pullStartedAt rationale. Captured before any
  // remote read so the reconciliation pass below ignores transactions
  // created locally + pushed mid-pull.
  const pullStartedAt = new Date().toISOString();
  const lastPull = await getSyncMeta(`last_txn_pull_at:${userId}`);
  // The FIRST reason this pull could not vouch for the transactions, for
  // pullChanges to report and to withhold last_pull_at on (#66). Recording it
  // changes nothing below: every branch still does what it did, and the cursor
  // and reconcile-key guards still read their own flags.
  let failure: PullFailure | null = null;

  // 1) Incremental fast-path: full rows changed since the cursor. A fresh query
  //    builder per page, because the conditional `.gt('updated_at', lastPull)`
  //    below APPENDS — hoisting the builder would add one more `.gt` per page.
  //    (`.range()` itself would survive being reused; it replaces. See the
  //    contract on readAllPages.)
  //
  //    This page deliberately does NOT filter `deleted_at`: a tombstone is the
  //    delete, and seeing it here is the whole point of #18 — it rides the same
  //    `updated_at > cursor` read every other change does, so deletes stop
  //    needing a full enumeration to be noticed.
  const pulledTxnIds: string[] = [];
  const { error: incrementalReadError } = await readAllPages<any>(
    (from, to) => {
      let q = supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('id');
      if (lastPull) {
        q = q.gt('updated_at', lastPull);
      }
      return q.range(from, to);
    },
    async (rows) => {
      for (const row of rows) {
        if (isTombstone(row)) {
          // Scoped to synced rows inside the helper: a 'pending' local edit or a
          // queued local 'deleted' row is unsynced work that only push may
          // resolve (its upsert lands on the already-tombstoned server row, so
          // delete still wins — but the queue entry survives until then).
          //
          // Unlike the reconcile below, this needs no pullStartedAt guard: a
          // tombstone is an explicit assertion about ONE id that the server has
          // already committed, not an inference drawn from a row's absence from a
          // snapshot, so a row created and pushed mid-pull cannot be caught by it.
          //
          // The id must not join pulledTxnIds: that list drives step 3's split
          // refresh, and the row (with its splits) is gone — re-fetching splits
          // for it would query a parent that no longer exists locally.
          await deleteLocalTransactionIfSynced(db, row.id);
          continue;
        }
        await upsertRemoteTransaction(db, row);
        pulledTxnIds.push(row.id);
      }
    },
    { userId }
  );
  if (incrementalReadError && opts.throwOnError) {
    throw new Error(
      `Failed to download transactions: ${describeRequestError(incrementalReadError)}`
    );
  }
  // Set when a page read fails. The cursor must not be banked on a pull that
  // silently skipped a window of changes — see the guard at the end.
  const incrementalError = !!incrementalReadError;
  if (incrementalReadError) {
    console.warn(
      '[sync] pull transactions (incremental) failed:',
      incrementalReadError.code,
      incrementalReadError.message
    );
    failure = {
      kind: 'read',
      table: 'transactions',
      error: incrementalReadError,
    };
  }

  // 2) Reconcile pass: enumerate ALL remote (id, updated_at) to delete rows the
  //    server dropped and heal rows that drifted but weren't caught above.
  //
  //    This is now PERIODIC rather than per-sync. It is O(total history) every
  //    time it runs, and running it on every sync was the single largest
  //    scaling problem in the pull path (#18). Tombstones made it redundant for
  //    ordinary deletes, which step 1 now sees incrementally; what is left is
  //    the narrow set of cases no incremental read can reach — a row that
  //    disappeared with no tombstone to broadcast (purge_tombstones ran while
  //    this device was offline, or an old client hard-deleted it), and a
  //    correction stamped with an updated_at OLDER than our cursor. Those are
  //    rare and self-healing on a one-day horizon, so pay for them once a day.
  const reconcileKey = `last_txn_reconcile_at:${userId}`;
  const lastReconcile = await getSyncMeta(reconcileKey);
  const reconcileAge =
    Date.parse(pullStartedAt) - Date.parse(lastReconcile ?? '');
  // Fail towards running it. A missing key (fresh install, or wipeLocalData
  // cleared this user's keys), an unparseable one, or one stamped in the FUTURE
  // (the device's clock moved backwards) all mean "due now" — treating any of
  // them as "reconciled recently" would disable the safety net for as long as
  // the bad value survives, which for a future timestamp could be years.
  const dueForReconcile =
    !Number.isFinite(reconcileAge) ||
    reconcileAge < 0 ||
    reconcileAge >= RECONCILE_INTERVAL_MS;

  let refreshFailed = false;
  if (dueForReconcile) {
    const remote: ReconcileRemoteRow[] = [];
    // A truncated enumeration is the worst of the #64 cases: it looks like a
    // complete answer, so the rows it never reached read as "the server no
    // longer has them" and the planner deletes them. Paging to an empty page is
    // what makes `remote` mean "everything the server has".
    const { error: reconReadError, rows: rawRemoteRows } =
      await readAllPages<any>(
        (from, to) =>
          supabase
            .from('transactions')
            .select('id, updated_at, deleted_at')
            .eq('user_id', userId)
            .order('id')
            .range(from, to),
        async (rows) => {
          for (const r of rows) {
            if (isTombstone(r)) {
              // Absent, so the planner deletes the local copy. That is how a
              // device whose cursor is too old to have seen the incremental
              // UPDATE still converges.
              continue;
            }
            remote.push({ id: r.id, updated_at: r.updated_at });
          }
        },
        { userId }
      );
    // A failed enumeration is never "the server is empty": it skips the whole
    // reconcile below. The incremental upserts above still stand.
    const reconError = !!reconReadError;
    // `sawAnyRemoteRow` counts RAW rows, tombstones included (which is what
    // readAllPages returns), while `remote` holds only the live ones. Keeping
    // them apart is what lets the #19 guard below mean "the read told us
    // nothing" rather than "the answer was nothing". Filtering tombstones out
    // server-side would collapse the two: a user who legitimately deleted every
    // transaction would look identical to a mis-scoped RLS policy, and the guard
    // would then refuse that honest answer forever, stranding the local copies.
    const sawAnyRemoteRow = rawRemoteRows > 0;

    if (reconError) {
      // A transient remote read must never be interpreted as "the server is
      // empty"; skip the whole reconcile (no deletes, no refreshes) this round.
      console.warn(
        '[sync] transaction reconcile skipped: remote enumeration failed; ' +
          'leaving local rows intact to avoid spurious deletion'
      );
      if (!failure) {
        failure = {
          kind: 'read',
          table: 'transactions',
          error: reconReadError,
        };
      }
    } else {
      const localRows = await db.getAllAsync(
        `SELECT id, updated_at, _sync_status,
         CASE WHEN _sync_status = 'synced'
                   AND (updated_at IS NULL OR julianday(updated_at) <= julianday(?))
              THEN 1 ELSE 0 END AS reconcilable
       FROM transactions WHERE user_id = ?`,
        [pullStartedAt, userId]
      );
      const local: ReconcileLocalRow[] = localRows.map((r: any) => ({
        id: r.id,
        updated_at: r.updated_at,
        _sync_status: r._sync_status,
        reconcilable: !!r.reconcilable,
      }));

      if (!sawAnyRemoteRow && local.some((l) => l.reconcilable)) {
        // planTransactionReconcile refuses to delete on an empty remote (#19);
        // say so out loud, because from here it is indistinguishable from a
        // mis-scoped RLS policy and the user would otherwise see nothing.
        console.warn(
          '[sync] transaction deletion reconcile skipped: the server returned ' +
            'no rows while synced rows exist locally; refusing to treat an ' +
            'empty enumeration as authoritative'
        );
        // The same refusal as pullTableFull's, and no more complete (#66).
        if (!failure) {
          failure = {
            kind: 'untrusted-empty',
            table: 'transactions',
            localRows: local.filter((l) => l.reconcilable).length,
          };
        }
      }

      const plan = planTransactionReconcile(remote, local, sawAnyRemoteRow);
      // Deduped for the same reason `touched` is below: the enumeration pages
      // with `.order('id').range(...)` exactly as the incremental read does, so
      // a row inserted between two pages can repeat a boundary id.
      const toRefresh = Array.from(new Set(plan.toRefresh));

      for (const id of plan.toDelete) {
        // Scoped for the same reason as the pullTableFull loop: `reconcilable`
        // was computed from a snapshot taken before the refresh awaits, so a
        // local edit landing mid-pull must still be spared here.
        await deleteLocalTransactionIfSynced(db, id);
      }

      // Fetch EVERYTHING a batch needs — the parents and then their splits —
      // before writing any of it, and withhold the whole batch if either read
      // fails (#62). Step 3's cursor hold is no protection here: a parent the
      // reconcile heals ends up MATCHING the server, so the next enumeration
      // finds no drift to refresh, and its server updated_at is no newer than
      // the cursor, so no incremental read returns it however far back the
      // cursor is held. Writing the parent while its splits could not be read
      // would therefore strand those splits until the parent is next edited —
      // silently and permanently. Leaving the parent stale instead costs one
      // unbanked reconcile key and one re-planned batch next pass.
      const REFRESH_BATCH = 200;
      for (let i = 0; i < toRefresh.length; i += REFRESH_BATCH) {
        const batch = toRefresh.slice(i, i + REFRESH_BATCH);
        const { data, error } = await readAll<any>(
          (from, to) =>
            supabase
              .from('transactions')
              .select('*')
              .in('id', batch)
              // A row tombstoned in the window between the enumeration and
              // this re-read must not come back as data.
              // forceUpsertRemoteTransaction would refuse it anyway, but
              // filtering server-side keeps a delete from arriving dressed as
              // a refresh.
              .is('deleted_at', null)
              .order('id')
              .range(from, to),
          { userId }
        );
        if (error) {
          // The pass identified these rows as stale and then failed to fetch
          // them, so it did NOT complete — see the banking guard below.
          console.warn(
            '[sync] pull transactions (refresh batch) failed:',
            error.code,
            error.message
          );
          refreshFailed = true;
          if (!failure) {
            failure = { kind: 'read', table: 'transactions', error };
          }
          continue;
        }
        const returned = data.map((r: any) => r.id);
        if (returned.length === 0) {
          // Every id in the batch was tombstoned between the enumeration and
          // this re-read. Nothing to heal and nothing failed: a skip, not a
          // failure — same rule as an empty split batch in step 3.
          continue;
        }
        const { data: splits, error: splitError } = await readAll<any>(
          (from, to) =>
            supabase
              .from('transaction_splits')
              .select('*')
              .in('transaction_id', returned)
              .order('id')
              .range(from, to),
          { userId }
        );
        if (splitError) {
          console.warn(
            '[sync] pull transactions (refresh batch splits) failed:',
            splitError.code,
            splitError.message
          );
          refreshFailed = true;
          if (!failure) {
            failure = {
              kind: 'read',
              table: 'transaction splits',
              error: splitError,
            };
          }
          continue; // no writes at all for this batch — see the comment above
        }
        // Parents first, then splits, and never the other way round. A split
        // edit landing between the two reads bumps the parent's server
        // updated_at, so this order stores a parent OLDER than the server and
        // the next enumeration re-plans it; splits-first would store a parent
        // that MATCHES the server beside splits read before that edit, and
        // nothing would ever look at the pair again.
        for (const row of data) {
          await forceUpsertRemoteTransaction(db, row);
        }
        // Re-read after the upsert, not before: a local edit that landed during
        // the reads leaves its parent 'pending', and its splits must be spared.
        const synced = new Set(await syncedParentIds(db, returned));
        for (const txnId of synced) {
          await db.runAsync(
            "DELETE FROM transaction_splits WHERE transaction_id = ? AND _sync_status = 'synced'",
            [txnId]
          );
        }
        for (const row of splits) {
          if (!synced.has(row.transaction_id)) continue;
          await upsertRemoteSplit(db, row);
        }
      }
    }

    // Only a pass that actually COMPLETED may bank the interval. Advancing the
    // key after a failed enumeration, or after the #19 empty-read guard
    // suppressed the deletes, would record a reconcile that never happened and
    // hide a mis-scoped RLS policy for a full day. Leaving it unset makes the
    // next sync retry, at a cost of one empty page.
    if (!reconError && !refreshFailed && sawAnyRemoteRow) {
      await setSyncMeta(reconcileKey, pullStartedAt);
    }
  }

  // 3) Refresh splits for every transaction the INCREMENTAL pass pulled, EXCEPT
  //    those whose local parent is unsynced. Fetch BEFORE deleting the local
  //    copies — deleting first and then failing the fetch would drop synced
  //    splits with nothing to reinsert (and the parent isn't "touched" again
  //    until it next drifts, so they'd stay missing).
  //
  //    The reconcile's healed parents are deliberately NOT here: since #62 each
  //    refresh batch reads its own splits and writes them beside the parent, so
  //    that a failed read can withhold both. Only the cursor-driven ids remain,
  //    and the cursor is the thing that brings them back if a batch fails here.
  //
  //    The `_sync_status = 'synced'` filter on the PARENT is the same guard
  //    every other pull path uses, and here it prevents a duplicate rather than
  //    a lost edit. `pulledTxnIds` collects every id the incremental pass read,
  //    including ones whose upsertRemoteTransaction was a guarded no-op because
  //    the local row is 'pending' — and our own push bumps the parent's server
  //    updated_at, so a transaction we just pushed is in that list on the very
  //    next pull. Without this filter the refresh then reinserts the server's
  //    splits alongside the local pending ones (the delete below spares those,
  //    and the server's rows carry ids that no longer exist locally, so they
  //    insert cleanly) — and the next push uploads BOTH, since a parent that
  //    carries an unsynced split has every live local split uploaded. The split
  //    edit is no longer lost; it is permanently duplicated instead, which is
  //    worse.
  //
  //    Nothing is given up by skipping them (#97). If this device changed the
  //    parent's splits, its next push replaces the server's set with every
  //    live local split, so a server-side correction for such a parent is
  //    discarded either way. If it did not — a pending parent with only synced
  //    splits, or none — the push uploads the parent alone and leaves the
  //    server's set, and since it bumps the parent's server updated_at, the
  //    pull after it lists the parent again, synced by then, and refreshes its
  //    splits here — provided that stamp is later than the cursor, which a
  //    device clock running ahead of the server's can prevent (see the split-guard
  //    comment at `splitsChanged` in pushChanges). That covers a parent the store holds without
  //    its splits, too: one a download left so (a split read that failed, or a
  //    bootstrap killed before it), or one realtime delivered before the next
  //    pull (applyTransactionEvent writes the parent only; reachable today only
  //    through another device's transaction from a legacy recurring template
  //    that carries splits). Edited in that state, such a parent used to be
  //    pushed by deleting the server's splits and inserting none; the push-side
  //    guard is what fixes that, where refreshing pending parents here would
  //    bring back the duplicate above.
  // Deduped because a row inserted between two ranged pages can repeat a
  // boundary row, and refreshing the same parent twice would delete the splits
  // the first pass just inserted before reinserting them.
  const touched = Array.from(new Set(pulledTxnIds));
  const SPLIT_BATCH = 200;
  // Set when a split batch cannot be read. Holds the transaction cursor back,
  // just as a failed page read does — see the guard at the end.
  let splitRefreshFailed = false;
  for (let i = 0; i < touched.length; i += SPLIT_BATCH) {
    const candidates = touched.slice(i, i + SPLIT_BATCH);
    const batch = await syncedParentIds(db, candidates);
    if (batch.length === 0) continue;
    const { data: splits, error } = await readAll<any>(
      (from, to) =>
        supabase
          .from('transaction_splits')
          .select('*')
          .in('transaction_id', batch)
          .order('id')
          .range(from, to),
      { userId }
    );
    if (error) {
      if (opts.throwOnError) {
        throw new Error(
          `Failed to download splits: ${describeRequestError(error)}`
        );
      }
      console.warn(
        '[sync] pull transaction_splits failed:',
        error.code,
        error.message
      );
      splitRefreshFailed = true;
      if (!failure) {
        failure = { kind: 'read', table: 'transaction splits', error };
      }
      continue; // leave existing local splits intact rather than lose them
    }
    for (const txnId of batch) {
      await db.runAsync(
        "DELETE FROM transaction_splits WHERE transaction_id = ? AND _sync_status = 'synced'",
        [txnId]
      );
    }
    for (const row of splits) {
      await upsertRemoteSplit(db, row);
    }
  }

  // Advance the cursor to the pull-start snapshot (not "now"): anything the
  // server changed during this pull is re-examined next time rather than skipped.
  //
  // Never advance it when a page read failed. Banking the cursor over a window
  // this pull never actually read means `gt('updated_at', cursor)` can never
  // return those rows again: an edit made elsewhere stays invisible and, worse,
  // a later local edit pushes over it and destroys it. This used to be harmless
  // only because the full reconcile ran on EVERY pull and back-filled the gap in
  // the same pass; now that the reconcile is periodic (#18) the compensation can
  // be up to a day away, so the advance has to be earned. Re-reading the window
  // next sync is idempotent: upserts are guarded and tombstone deletes are
  // scoped to 'synced'.
  //
  // A failed split batch holds it back too, and for splits nothing else repairs
  // the damage. The synced parents in that batch were upserted above, so their
  // local updated_at already matches the server: once the cursor passes them no
  // incremental read returns them, and the reconcile finds nothing to refresh.
  // Their splits stay missing or stale until the parent is next edited — and
  // when this pull is a device's first download (a bootstrap that found the
  // lock held, or the fullSync startSyncSession runs after initialPull gave up)
  // that can be every split the user has. Held back, the next sync re-reads
  // those parents and fetches their splits again; while split reads keep
  // failing, every sync re-reads the whole window.
  //
  // A parent the RECONCILE heals never depends on this cursor, and must not: no
  // incremental read returns a row that is no newer than the cursor, however
  // far back it is held. Its splits are read inside the reconcile instead,
  // before the parent is written, so a failed read there leaves the parent
  // stale and the reconcile key unbanked and the next pass plans the same row
  // again (#62). That is why only pulledTxnIds reach step 3.
  if (!incrementalError && !splitRefreshFailed) {
    await setSyncMeta(`last_txn_pull_at:${userId}`, pullStartedAt);
  }
  return failure;
}

export async function upsertRemoteAccount(db: any, row: any): Promise<void> {
  // A tombstone is a delete, not data: refuse it here rather than writing it.
  // The deleting device receives its OWN tombstone straight back as a realtime
  // UPDATE, and the ON CONFLICT statement below leaves its INSERT branch
  // unguarded — so without this early return that echo re-INSERTs the row the
  // user just deleted, and it stays resurrected on screen until the next pull
  // notices. Consuming a tombstone is deleteLocal*IfSynced's job
  // (lib/tombstones.ts); an upsert only ever applies live rows.
  if (isTombstone(row)) return;

  // Guard: only overwrite local rows that are 'synced' AND whose remote
  // copy is at least as fresh. The 'synced' check alone is insufficient: a
  // pull that started before a local write completes can capture stale
  // remote data, and by the time its iteration reaches a row, that row may
  // have been pushed and re-marked 'synced' — passing the status guard but
  // overwriting the just-pushed values with the older snapshot.
  //
  // NULL handling is asymmetric on purpose: if the local row lacks an
  // updated_at we accept the remote (we have no basis to reject), but a
  // remote row with NULL updated_at is NEVER allowed to overwrite a dated
  // local row — that direction is almost certainly stale or malformed.
  // julianday() handles ISO-8601 strings consistently; raw string compare
  // would silently drift if the local and remote timestamp formats ever
  // diverge.
  await db.runAsync(
    `INSERT INTO accounts
       (id, user_id, name, type, icon, initial_balance, exclude_from_total,
        sort_order, is_archived, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, icon = excluded.icon,
       initial_balance = excluded.initial_balance,
       exclude_from_total = excluded.exclude_from_total,
       sort_order = excluded.sort_order, is_archived = excluded.is_archived,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE accounts._sync_status = 'synced'
       AND (
         accounts.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(accounts.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.name,
      row.type,
      row.icon ?? null,
      row.initial_balance,
      row.exclude_from_total ? 1 : 0,
      row.sort_order,
      row.is_archived ? 1 : 0,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative account refresh for the reconcile pass — overwrites a 'synced'
 * local row regardless of updated_at ordering (heals an older-timestamp server
 * correction the guarded upsert would skip forever). Never touches
 * 'pending'/'deleted' rows. See forceUpsertRemoteTransaction for the rationale.
 */
export async function forceUpsertRemoteAccount(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  await db.runAsync(
    `INSERT INTO accounts
       (id, user_id, name, type, icon, initial_balance, exclude_from_total,
        sort_order, is_archived, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, icon = excluded.icon,
       initial_balance = excluded.initial_balance,
       exclude_from_total = excluded.exclude_from_total,
       sort_order = excluded.sort_order, is_archived = excluded.is_archived,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE accounts._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.name,
      row.type,
      row.icon ?? null,
      row.initial_balance,
      row.exclude_from_total ? 1 : 0,
      row.sort_order,
      row.is_archived ? 1 : 0,
      row.created_at,
      row.updated_at,
    ]
  );
}

export async function upsertRemoteTransaction(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  // See upsertRemoteAccount for the rationale on the updated_at guard.
  await db.runAsync(
    `INSERT INTO transactions
       (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
        status, transfer_link_id, receipt_path, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, txn_date = excluded.txn_date,
       payee = excluded.payee, amount = excluded.amount,
       check_number = excluded.check_number, memo = excluded.memo,
       status = excluded.status, transfer_link_id = excluded.transfer_link_id,
       receipt_path = excluded.receipt_path,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transactions._sync_status = 'synced'
       AND (
         transactions.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(transactions.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.txn_date,
      row.payee,
      row.amount,
      row.check_number ?? null,
      row.memo ?? null,
      row.status,
      row.transfer_link_id ?? null,
      row.receipt_path ?? null,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative refresh used only by the reconcile pass. Unlike
 * upsertRemoteTransaction, it overwrites a 'synced' local row regardless of the
 * updated_at ordering — the server is the source of truth for synced rows, so a
 * server correction with an OLDER updated_at than the local copy (which the
 * normal `excluded.updated_at >= local` guard would skip forever) is applied.
 *
 * It still refuses to touch 'pending'/'deleted' rows (unsynced local edits), and
 * the reconcile caller only invokes it for ids that are missing locally or whose
 * synced local copy genuinely differs from the freshly-read remote row — so a
 * concurrently-pushed edit (which would already match remote) is never clobbered.
 */
export async function forceUpsertRemoteTransaction(
  db: any,
  row: any
): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  await db.runAsync(
    `INSERT INTO transactions
       (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
        status, transfer_link_id, receipt_path, created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, txn_date = excluded.txn_date,
       payee = excluded.payee, amount = excluded.amount,
       check_number = excluded.check_number, memo = excluded.memo,
       status = excluded.status, transfer_link_id = excluded.transfer_link_id,
       receipt_path = excluded.receipt_path,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transactions._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.txn_date,
      row.payee,
      row.amount,
      row.check_number ?? null,
      row.memo ?? null,
      row.status,
      row.transfer_link_id ?? null,
      row.receipt_path ?? null,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Splits have no tombstone and no cursor of their own — they ride their parent
 * (see pullTransactions steps 2 and 3). What they do have since #20 is an
 * updated_at, so the last-write-wins guard is the same one every other table
 * uses.
 *
 * NULL-tolerant on both sides: `row.updated_at` is undefined for every split
 * read from a server without 006_split_updated_at.sql, and the local value is
 * NULL for a split the migration-2 backfill could not reach.
 *
 * The last-write-wins comparison itself decides nothing today, and is here for
 * consistency with the other three tables rather than because anything needs
 * it: all three callers write onto a store holding no conflicting 'synced'
 * split for that parent other than the same row. The two in pullTransactions
 * delete them immediately before upserting, and initialPull's loop only
 * starts over a store holding none of this user's rows (#96), so the only
 * split it can collide with by id is an orphan whose parent is gone, and a
 * synced one with the same id is simply that row coming back. So a
 * conflicting row that differs can only be an unsynced one — which the
 * `_sync_status = 'synced'` condition already refuses, so an unsynced row is
 * never overwritten. Do not read its presence as evidence that split
 * timestamps are ordered server-side.
 *
 * They are not: 006 adds only a BEFORE UPDATE trigger, and splits are never
 * UPDATEd (they are deleted and reinserted), so in practice every split's
 * updated_at is the value the CLIENT stamped and the server merely re-rendered.
 * A #21 realtime split handler must therefore not use it to order events
 * against another device's clock.
 */
async function upsertRemoteSplit(db: any, row: any): Promise<void> {
  await db.runAsync(
    `INSERT INTO transaction_splits (id, transaction_id, amount, memo, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       transaction_id = excluded.transaction_id, amount = excluded.amount,
       memo = excluded.memo, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE transaction_splits._sync_status = 'synced'
       AND (
         transaction_splits.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(transaction_splits.updated_at)
         )
       )`,
    [
      row.id,
      row.transaction_id,
      row.amount,
      row.memo ?? null,
      row.updated_at ?? null,
    ]
  );
}

async function upsertRemoteRule(db: any, row: any): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  const templateStr =
    typeof row.template === 'string'
      ? row.template
      : JSON.stringify(row.template ?? {});

  // See upsertRemoteAccount for the rationale on the updated_at guard.
  await db.runAsync(
    `INSERT INTO recurring_rules
       (id, user_id, account_id, frequency, next_date, end_date, template,
        created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, frequency = excluded.frequency,
       next_date = excluded.next_date, end_date = excluded.end_date,
       template = excluded.template,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE recurring_rules._sync_status = 'synced'
       AND (
         recurring_rules.updated_at IS NULL
         OR (
           excluded.updated_at IS NOT NULL
           AND julianday(excluded.updated_at) >= julianday(recurring_rules.updated_at)
         )
       )`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.frequency,
      row.next_date,
      row.end_date ?? null,
      templateStr,
      row.created_at,
      row.updated_at,
    ]
  );
}

/**
 * Authoritative recurring-rule refresh for the reconcile pass — see
 * forceUpsertRemoteAccount.
 */
async function forceUpsertRemoteRule(db: any, row: any): Promise<void> {
  // Never resurrect a deleted row — see upsertRemoteAccount.
  if (isTombstone(row)) return;

  const templateStr =
    typeof row.template === 'string'
      ? row.template
      : JSON.stringify(row.template ?? {});

  await db.runAsync(
    `INSERT INTO recurring_rules
       (id, user_id, account_id, frequency, next_date, end_date, template,
        created_at, updated_at, _sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id, frequency = excluded.frequency,
       next_date = excluded.next_date, end_date = excluded.end_date,
       template = excluded.template,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       _sync_status = 'synced'
     WHERE recurring_rules._sync_status = 'synced'`,
    [
      row.id,
      row.user_id,
      row.account_id,
      row.frequency,
      row.next_date,
      row.end_date ?? null,
      templateStr,
      row.created_at,
      row.updated_at,
    ]
  );
}

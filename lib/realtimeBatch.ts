// What realtime does about a burst (#21), kept free of React, of the query
// client and of the database, so that both halves can be driven with fake
// timers: lib/hooks/useRealtimeSync.ts wires them to the channel.
//
// A remote change arrives as one event per row, and a bulk one (an import,
// an account delete with its children, a re-split: the server deletes a
// parent's old splits and inserts the new ones, one event each) as hundreds
// within a second. Before #21 each event refetched every list it touched on
// its own, so 200 imported transactions refetched the Accounts list -- the
// balance aggregate over every transaction -- 200 times, each fetch
// cancelling the one before.
//
// The database writes are not here and are never held back: each event's
// handler writes its row as it arrives, in the order the events came. What
// waits is the refetch (createInvalidationBatcher) and the split refresh,
// which is a read (createSplitRefresher).

/**
 * How long a burst's refetches and split reads are held. Another device's
 * push sends ONE row per request (pushChanges, pushTable: an upsert each),
 * so its import or its sync reaches this device as a trickle, one event per
 * round trip of the pushing device: tens of milliseconds on a desktop,
 * 100-300 on a phone. A re-split is two such requests apart (its splits'
 * DELETE, then their INSERT). A window shorter than that round trip
 * coalesces nothing: measured at 300 ms spacing, 200 events refetched each
 * list 200 times under a 250 ms window and 61 times under this one, at
 * 150 ms 121 and 31 (H3c). The first event of a quiet spell is still
 * refetched at once, so a single change made elsewhere shows with no added
 * delay; the rest of a burst shows at most a second behind it.
 */
export const REALTIME_WINDOW_MS = 1000;

export type QueryKeyLike = readonly unknown[];

export interface InvalidationBatcher {
  /** One event's keys, invalidated together. */
  add(...keys: QueryKeyLike[]): void;
  /** Drops whatever is held and stops for good. */
  cancel(): void;
}

/**
 * Coalesces cache invalidations over a window that the first event opens.
 *
 * The first event's keys are invalidated at once, as before #21, so a single
 * change made elsewhere shows with no added delay. The window then opens: the
 * keys of every event inside it are held in one set, deduplicated, and
 * invalidated once when it closes; if any were held, another window opens
 * behind it, so a long burst refetches each list at most once per window,
 * and the first event after a quiet window is invalidated at once again.
 *
 * `cancel` (the subscription torn down: a sign-out, a change of account, an
 * unmount) drops the held keys without invalidating them and stops the
 * window's timer. The AuthProvider removes every query when the account
 * changes (#177), so a held key carried past that moment could only refetch
 * the next account's lists, the work of a session that has ended.
 */
export function createInvalidationBatcher(
  invalidate: (queryKey: QueryKeyLike) => void,
  windowMs: number = REALTIME_WINDOW_MS
): InvalidationBatcher {
  let held = new Map<string, QueryKeyLike>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const flush = () => {
    const keys = Array.from(held.values());
    held = new Map();
    for (const key of keys) {
      invalidate(key);
    }
  };
  const close = () => {
    timer = null;
    if (held.size === 0) return;
    flush();
    timer = setTimeout(close, windowMs);
  };

  return {
    add(...keys) {
      if (cancelled) return;
      for (const key of keys) {
        held.set(JSON.stringify(key), key);
      }
      if (timer === null) {
        flush();
        timer = setTimeout(close, windowMs);
      }
    },
    cancel() {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      held = new Map();
    },
  };
}

export interface SplitRefresher {
  /** A parent whose split set changed on the server. */
  schedule(parentId: string): void;
  /** Drops what is waiting and stops for good. */
  cancel(): void;
}

/**
 * Runs `refresh` over the parents split events name, one read for a burst,
 * one read at a time.
 *
 * The first parent named opens a window; every parent named inside it joins
 * the same call when it closes, so a re-split's DELETE and INSERT events
 * (one per split, from one push) cost one read, made once the push has most
 * likely finished. A parent named while a read is out waits for it, and for
 * a window after it, and is read then, never beside it: a read that started
 * before the server's last change is always followed by one that started
 * after it, which is what makes the last write here the server's latest set
 * (a read whose events were lost is the next pull's to repair). A failure is
 * warned and dropped, for the same reason.
 *
 * `cancel` drops the parents waiting and runs nothing more. A read already
 * out finishes: its writes are refreshSplitsFromServer's to refuse (an
 * account switched meanwhile answers its read as another account's, which
 * fails it), and its result is not acted on here.
 */
export function createSplitRefresher(
  refresh: (parentIds: string[]) => Promise<void>,
  windowMs: number = REALTIME_WINDOW_MS
): SplitRefresher {
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let cancelled = false;

  const run = async () => {
    timer = null;
    running = true;
    const ids = Array.from(waiting);
    waiting.clear();
    try {
      await refresh(ids);
    } catch (e) {
      console.warn('[realtime] split refresh error:', e);
    } finally {
      running = false;
    }
    // Parents named while the read was out wait for a window of their own,
    // as the first did: a trickle of split events then costs one read per
    // window, not one per event, and each read still starts after the
    // events it answers.
    if (!cancelled && waiting.size > 0 && timer === null) {
      timer = setTimeout(run, windowMs);
    }
  };

  return {
    schedule(parentId) {
      if (cancelled) return;
      waiting.add(parentId);
      if (!running && timer === null) {
        timer = setTimeout(run, windowMs);
      }
    },
    cancel() {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      waiting.clear();
    },
  };
}

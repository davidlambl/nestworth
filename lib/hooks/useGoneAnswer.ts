import { useState } from 'react';
import type { FetchStatus } from '@tanstack/react-query';

/**
 * Whether a screen says the row it reads by id is gone (#195, #212): the last
 * answer its query settled on was a not-found (`isNotFound`, the query's own
 * test of its error), kept while a refetch is in flight. useTransactionGone
 * (the edit screen) and useAccountGone (the register) are this, each with its
 * query's test.
 *
 * A query that has never found its row holds no data, and TanStack Query puts
 * a query without data back to pending, its error cleared, each time it
 * fetches again: after the startup sequence and every sync (each ends by
 * invalidating every query), on a reconnect, and on web on each return to the
 * window. Read from the error alone, a screen's gone line went away for each
 * refetch and came back with its answer: a new addition to its live region,
 * read out again on web, and on iOS a new VoiceOver move to it. A refetch,
 * paused offline too, keeps the answer it is refreshing; a read that settles
 * on anything else (the row, another error) replaces it, and another id
 * starts without one.
 */
export function useGoneAnswer(
  id: string,
  query: { error: unknown; fetchStatus: FetchStatus },
  isNotFound: (error: unknown) => boolean
): boolean {
  const notFound = isNotFound(query.error);
  const fetching = query.fetchStatus !== 'idle';
  // The id whose read last settled on a not-found. It is set while rendering,
  // once a read settles: React's way to keep what a previous render saw.
  const [goneId, setGoneId] = useState<string | null>(null);
  const settledGoneId = notFound ? id : null;
  if (!fetching && goneId !== settledGoneId) {
    setGoneId(settledGoneId);
  }
  return notFound || (fetching && goneId === id);
}

/**
 * How many times the app retries a failed query: lib/query.tsx's default,
 * and the count useAccount and useTransaction keep for any error but a
 * not-found (#163, #177). Its own module so that a hook can read it without
 * importing lib/query.tsx, which builds the QueryClient and starts listening
 * to NetInfo as it loads.
 */
export const QUERY_RETRY = 1;

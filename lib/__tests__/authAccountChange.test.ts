// A change of account hands the next account nothing of the previous one's
// (#177), on the paths authQueryCache.test.ts does not drive:
//
// - The AuthProvider can mount again over a client that holds the previous
//   account's results: app/_layout.tsx exports expo-router's ErrorBoundary,
//   whose Try replaces the root layout -- QueryProvider and AuthProvider
//   included -- on a render error and mounts it again on Retry, while the
//   client (lib/query.tsx) is a module singleton that keeps its cache. So the
//   provider empties the cache as it mounts, before anything under it
//   renders, and the first session it hands over counts as a change of
//   account too.
// - A sign-in straight over another account (auth-js reports it as
//   SIGNED_IN alone) is a change of account like a sign-out: the signed
//   receipt URLs kept for the previous account go with the cache.
// - An edit of the previous account's can settle after the change, online:
//   queued behind another transaction on the shared connection (#110), it is
//   refused then, and its rollback wrote the previous account's lists into
//   the cache the next account's screens read. It now undoes only its own
//   patch.
// - Reads of the previous account's still in flight at the change never
//   land in the next one's cache.
//
// The real AuthProvider with a mocked supabase.auth, as in
// authQueryCache.test.ts, over the fixture's SQLite and a QueryClient with
// the app's staleTime; the screen mounts the accounts list, a register, the
// All Accounts list and useUpdateTransaction. A1, A2, A3, A5, A6 and A7 are
// red on the code before #177, and A6 also on #177's version that removed
// nothing before the first session; A0 and A4 are pins. Behind the removal at
// mount, A7 pins that the first session still removes (its mutant: a first
// session of "signed out" keeps the cache).
let mockSession: unknown = { access_token: 'u', user: { id: 'u' } };
jest.mock('../supabase', () => {
  let signed = 0;
  const bucket = {
    createSignedUrl: jest.fn(async (path: string) => {
      signed += 1;
      return {
        data: {
          signedUrl: `https://x.supabase.co/sign/${path}?token=t${signed}`,
        },
        error: null,
      };
    }),
  };
  return {
    supabase: {
      auth: {
        getSession: jest.fn(async () => ({ data: { session: mockSession } })),
        onAuthStateChange: jest.fn(() => ({
          data: { subscription: { unsubscribe: jest.fn() } },
        })),
      },
      storage: { from: jest.fn(() => bucket) },
    },
  };
});
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'split-x') }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { getDb } from '../db';
import { AuthProvider, useAuth } from '../auth';
import { useAccounts } from '../hooks/useAccounts';
import {
  useAllTransactions,
  useTransactions,
  useUpdateTransaction,
} from '../hooks/useTransactions';
import { forgetReceiptUrls, receiptUrl } from '../receiptStorage';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';
const sessionOf = (id: string) => ({ access_token: id, user: { id } });

const onAuthStateChange = supabase.auth
  .onAuthStateChange as unknown as jest.Mock;
const getSession = supabase.auth.getSession as unknown as jest.Mock;

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
/** Every render of the screen: the account it was given, what it showed. */
let seen: {
  user: string | null;
  accounts: string[];
  register: string[];
  all: string[];
  allStatus: string[];
  registerStatus: string[];
}[];
let update: ReturnType<typeof useUpdateTransaction>;

/** The Accounts tab's list, a register on u's a1, and All Accounts. */
function Screen() {
  const { user } = useAuth();
  const accounts = useAccounts();
  const register = useTransactions('a1');
  const all = useAllTransactions();
  const upd = useUpdateTransaction();
  useEffect(() => {
    update = upd;
  });
  seen.push({
    user: user?.id ?? null,
    accounts: (accounts.data ?? []).map((a) => a.name),
    register: (register.data ?? []).map((t) => t.payee),
    all: (all.data ?? []).map((t) => t.payee),
    allStatus: (all.data ?? []).map((t) => `${t.payee}:${t.status}`),
    registerStatus: (register.data ?? []).map((t) => `${t.payee}:${t.status}`),
  });
  return null;
}

const tree = () =>
  createElement(
    QueryClientProvider,
    { client: qc },
    createElement(AuthProvider, null, createElement(Screen))
  );

async function settle() {
  for (let i = 0, idle = 0; i < 20 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

/** The subscriber the mounted AuthProvider gave auth-js. */
const listener = () =>
  onAuthStateChange.mock.calls[onAuthStateChange.mock.calls.length - 1][0];

/** What auth-js tells every subscriber (GoTrueClient's _notifyAllSubscribers). */
async function authEvent(event: string, session: unknown) {
  const l = listener();
  await act(async () => {
    l(event, session);
  });
  await settle();
}

/**
 * Reads answer after a worker's round trip from here on: expo-sqlite answers
 * on another thread and wa-sqlite in a web worker, while better-sqlite3
 * answers in the same microtask, which would hide any render in between.
 */
function slowReads(ms: number) {
  const read = adapter.getAllAsync;
  adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
    await new Promise((r) => setTimeout(r, ms));
    return read(sql, params as any);
  }) as typeof adapter.getAllAsync;
}

/**
 * The next getSession -- a mounting AuthProvider's -- answers only when the
 * returned function is called: the renders before it are the provider's while
 * it loads, before any session.
 */
function holdGetSession() {
  let answer!: () => void;
  getSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ data: { session: mockSession } });
      })
  );
  return async () => {
    await act(async () => {
      answer();
    });
    await settle();
  };
}

/** Holds the shared connection, as another withTransactionAsync caller does. */
function holdConnection() {
  let release!: () => void;
  const held = adapter.withTransactionAsync(
    () => new Promise<void>((r) => (release = r))
  );
  return async () => {
    await act(async () => {
      release();
      await held;
    });
  };
}

/** Lets the refused edit settle, roll back and refetch at the slow reads. */
async function settleSlowly() {
  await settle();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  await settle();
}

/** The renders made while `user` was signed in (null: none). */
const rendersOf = (user: string | null) => seen.filter((s) => s.user === user);
/** Whether a render shows anything of u's. */
const showsU = (s: (typeof seen)[number]) =>
  s.accounts.includes('Checking') ||
  s.register.includes('Rent') ||
  s.all.includes('Rent');

let quiet: jest.SpyInstance[];

beforeEach(async () => {
  onAuthStateChange.mockClear();
  forgetReceiptUrls();
  mockSession = sessionOf('u');
  seen = [];
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  await insertLocalAccount(adapter, {
    id: 'a1',
    user_id: 'u',
    name: 'Checking',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 't1',
    user_id: 'u',
    account_id: 'a1',
    payee: 'Rent',
    amount: -1200,
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(adapter, {
    id: 'b1',
    user_id: 'b',
    name: 'Wallet',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 'tb1',
    user_id: 'b',
    account_id: 'b1',
    payee: 'Coffee',
    amount: -4,
    updated_at: SYNCED_AT,
  });
  // The app's staleTime; never collected here, as in authQueryCache.test.ts
  // (a removed query still observed starts its collection timer, which jest
  // would wait for). No retry, so a test never waits either.
  qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 30, gcTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  await settle();
  // The first event a subscriber gets: the session getSession gave.
  await authEvent('INITIAL_SESSION', sessionOf('u'));
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache()
    .getAll()
    .forEach((m) => m.destroy());
  qc.getMutationCache().clear();
  qc.clear();
  quiet.forEach((spy) => spy.mockRestore());
  adapter._sqlite.close();
});

describe('a change of account hands the next account nothing of the previous one (#177)', () => {
  it("A0 (pin): u's screen shows u's account, register and list", () => {
    expect(seen[seen.length - 1]).toMatchObject({
      user: 'u',
      accounts: ['Checking'],
      register: ['Rent'],
      all: ['Rent'],
    });
  });

  // Before #177 the provider removed nothing at all; in #177's first draft it
  // removed nothing on its first publication, trusting a cache that only a
  // launch leaves empty. b's first screen was u's cached accounts, register
  // and list, fresh for 30 s, without a read. (The renders made while the
  // remounted provider loads, before any session: A6.)
  it("A1: an AuthProvider mounted again over the same client (the root ErrorBoundary's Retry) never hands b the cache u filled", async () => {
    // The root layout's ErrorBoundary takes the providers down; the client
    // keeps u's results.
    await act(async () => {
      renderer.update(createElement(QueryClientProvider, { client: qc }, null));
    });
    // Meanwhile nothing listens, and the stored session becomes b's: another
    // tab of the app signed b in over u.
    mockSession = sessionOf('b');
    seen = [];
    // Retry: the root layout, the QueryProvider and a new AuthProvider mount
    // again over the same client.
    await act(async () => {
      renderer.update(tree());
    });
    await settle();

    const b = rendersOf('b');
    expect(b.length).toBeGreaterThan(0);
    expect(b.filter(showsU)).toEqual([]);
  });

  // Before #177 the kept URLs were dropped on SIGNED_OUT only: a signed URL
  // is a bearer token (#23), and u's stayed handed out to u's id for up to an
  // hour after b's session replaced u's.
  it('A2: a sign-in straight over u drops the signed receipt URLs kept for u', async () => {
    const before = await receiptUrl('u', 'u/t1.n1.jpg');
    expect(await receiptUrl('u', 'u/t1.n1.jpg')).toBe(before);

    mockSession = sessionOf('b');
    await authEvent('SIGNED_IN', sessionOf('b'));

    // A caller still holding u's id after b signed in (u's signing query,
    // cancelled by the removal, keeps running its queryFn).
    const after = await receiptUrl('u', 'u/t1.n1.jpg').catch(
      (e) => `refused: ${(e as Error).name}`
    );
    expect(after).not.toBe(before);
  });

  // Before: u's edit, refused once the connection was free, rolled back by
  // writing u's lists over whatever the keys held by then -- b's -- and b's
  // register and All Accounts showed u's Rent until the edit's refetch.
  it("A3: an edit of u's queued behind a transaction, failing after b signed in, never puts u's list on b's screen", async () => {
    // Another withTransactionAsync caller holds the shared connection: a
    // pull's page, the CSV import's batch, the reset's wipe (#110's queue).
    const releaseConnection = holdConnection();
    // u ticks t1's status: onMutate patches both lists, the write waits.
    await act(async () => {
      update.mutate({ id: 't1', accountId: 'a1', status: 'cleared' });
      await new Promise((r) => setTimeout(r, 0));
    });
    // The row goes meanwhile (a pulled tombstone's plain DELETE), so the
    // queued edit will be refused with #127's words.
    adapter._sqlite.prepare("DELETE FROM transactions WHERE id = 't1'").run();
    // b signs in straight over u (another tab, or the sign-in screen a
    // sign-out whose request failed leaves).
    mockSession = sessionOf('b');
    await authEvent('SIGNED_IN', sessionOf('b'));
    expect(seen[seen.length - 1].all).toEqual(['Coffee']);
    slowReads(20);

    // The connection is free: u's edit runs, is refused, and rolls back.
    await releaseConnection();
    await settleSlowly();

    expect(rendersOf('b').filter(showsU)).toEqual([]);
  });

  it("A4 (pin): u's own edit refused without a change of account rolls both lists back before the refetch", async () => {
    const releaseConnection = holdConnection();
    await act(async () => {
      update.mutate({ id: 't1', accountId: 'a1', status: 'pending' });
      await new Promise((r) => setTimeout(r, 0));
    });
    // The optimistic tick is on screen.
    expect(seen[seen.length - 1].allStatus).toEqual(['Rent:pending']);
    adapter._sqlite.prepare("DELETE FROM transactions WHERE id = 't1'").run();
    slowReads(20);
    const from = seen.length;

    await releaseConnection();
    await settleSlowly();

    // Rolled back to the lists before the edit, then refetched without the
    // row.
    const all = seen.slice(from).map((s) => s.allStatus);
    const register = seen.slice(from).map((s) => s.registerStatus);
    expect(register).toContainEqual(['Rent:cleared']);
    expect(all).toContainEqual(['Rent:cleared']);
    expect(all[all.length - 1]).toEqual([]);
  });

  // Before #177 nothing was removed, so u's reads landed in the cache b's
  // screens read. Removing a query cancels its read silently: none lands.
  it("A5: u's reads in flight when b signs in never land in b's cache", async () => {
    const read = adapter.getAllAsync;
    adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
      await new Promise((r) => setTimeout(r, 50));
      return read(sql, params as any);
    }) as typeof adapter.getAllAsync;
    // A sync ends for u: every query refetches, slowly.
    await act(async () => {
      void qc.invalidateQueries();
    });
    const inFlight = qc.isFetching();
    // b signs in straight over u while u's three reads are out.
    const from = seen.length;
    await act(async () => {
      listener()('SIGNED_IN', sessionOf('b'));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    await settle();

    const b = seen.slice(from).filter((s) => s.user === 'b');
    expect(inFlight).toBe(3);
    expect(b.filter(showsU)).toEqual([]);
    expect(b[b.length - 1]).toMatchObject({
      accounts: ['Wallet'],
      all: ['Coffee'],
    });
  });

  // Before #177 nothing was removed, and in #177 until its review nothing
  // before the first session: the screens a remounted provider rendered while
  // it loaded were handed u's cached accounts, register and list (a query
  // disabled for want of a user still returns what the cache holds), and a
  // caller holding u's id the URL kept for u.
  it("A6: an AuthProvider mounted again over the same client empties it as it mounts: nothing of u's while it loads", async () => {
    const kept = await receiptUrl('u', 'u/t1.n1.jpg');
    // The root layout's ErrorBoundary takes the providers down; meanwhile
    // another tab of the app signs b in over u.
    await act(async () => {
      renderer.update(createElement(QueryClientProvider, { client: qc }, null));
    });
    mockSession = sessionOf('b');
    const answer = holdGetSession();
    seen = [];
    // Retry.
    await act(async () => {
      renderer.update(tree());
    });
    await settle();
    const loading = rendersOf(null);
    // u's receipt asked for meanwhile, by a caller still holding u's id.
    const meanwhile = await receiptUrl('u', 'u/t1.n1.jpg').catch(
      (e) => `refused: ${(e as Error).name}`
    );
    await answer();

    expect(loading.length).toBeGreaterThan(0);
    expect(loading.filter(showsU)).toEqual([]);
    expect(meanwhile).not.toBe(kept);
    expect(rendersOf('b').filter(showsU)).toEqual([]);
  });

  // Behind the removal at mount, the first session handed over still counts
  // as a change of account, "signed out" included. Nothing in the app writes
  // into the cache while no session is known -- every query waits for a user
  // -- so this test lands u's accounts there itself, as a write of u's
  // settling at that moment would: the first session must take them away.
  it("A7: an AuthProvider mounted again while signed out (another tab signed u out) keeps nothing of u's that reached the cache before its first session", async () => {
    const uAccounts = qc.getQueryData(['accounts']);
    await act(async () => {
      renderer.update(createElement(QueryClientProvider, { client: qc }, null));
    });
    mockSession = null;
    const answer = holdGetSession();
    seen = [];
    await act(async () => {
      renderer.update(tree());
    });
    await settle();
    await act(async () => {
      qc.setQueryData(['accounts'], uAccounts);
    });
    await settle();
    const landed = seen[seen.length - 1].accounts;
    await answer();

    expect(landed).toEqual(['Checking']);
    expect(qc.getQueryData(['accounts'])).toBeUndefined();
    expect(seen[seen.length - 1]).toMatchObject({
      user: null,
      accounts: [],
      register: [],
      all: [],
    });
  });
});

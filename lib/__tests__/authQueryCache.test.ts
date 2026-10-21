// The read cache belongs to the account signed in (#177). Every query the app
// makes reads the signed-in user's rows, under a key that does not name the
// user (['accounts'], ['transaction', id], ...), and the app's QueryClient
// keeps a result fresh for 30 s and in memory for 5 min (lib/query.tsx). The
// AuthProvider never touched it: the next account signed in on the device was
// handed the previous one's accounts, register and transaction straight out
// of the cache, without a read -- within the 30 s, until a sync ended and
// refetched. Now the AuthProvider removes every query when the account it
// hands the screens changes, before the screens see the new account: after
// a sign-out, and after a sign-in straight over another account, which on web
// needs no sign-out (the sign-in screen is reachable by its URL, and auth-js
// then reports SIGNED_IN alone). Queries only: a mutation still in the cache is
// an edit the previous account made, waiting for the network, and still runs.
//
// The AuthProvider with a mocked supabase.auth, as in authReceiptUrls.test.ts,
// over the fixture's SQLite and a QueryClient with the app's cache times. C1
// and C2 are red on the code before #177; C3 and C4 are pins.
let mockSession: unknown = { access_token: 'a', user: { id: 'u' } };
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: mockSession } })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { getDb } from '../db';
import { AuthProvider, useAuth } from '../auth';
import { useAccounts } from '../hooks/useAccounts';
import { useTransactions } from '../hooks/useTransactions';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';
const sessionOf = (id: string) => ({ access_token: id, user: { id } });

const onAuthStateChange = supabase.auth
  .onAuthStateChange as unknown as jest.Mock;

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
/** Every render of the screen: the account it was given, what it showed. */
let seen: { user: string | null; accounts: string[]; register: string[] }[];
/** Every read of the accounts list, by the user it was for. */
let accountReads: string[];

/** The Accounts tab's list, and a register open on u's account a1. */
function Screen() {
  const { user } = useAuth();
  const accounts = useAccounts();
  const register = useTransactions('a1');
  seen.push({
    user: user?.id ?? null,
    accounts: (accounts.data ?? []).map((a) => a.name),
    register: (register.data ?? []).map((t) => t.payee),
  });
  return null;
}

async function settle() {
  for (let i = 0, idle = 0; i < 20 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

/** What auth-js tells every subscriber (GoTrueClient's _notifyAllSubscribers). */
async function authEvent(event: string, session: unknown) {
  const listener = onAuthStateChange.mock.calls[0][0];
  await act(async () => {
    listener(event, session);
  });
  await settle();
}

/** The renders made while `user` was signed in (null: signed out). */
const rendersOf = (user: string | null) => seen.filter((s) => s.user === user);

beforeEach(async () => {
  onAuthStateChange.mockClear();
  mockSession = sessionOf('u');
  seen = [];
  accountReads = [];
  adapter = makeAdapter();
  const read = adapter.getAllAsync.bind(adapter);
  adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
    if (/FROM accounts\s+WHERE user_id = \?/.test(sql)) {
      accountReads.push(String(params?.[0]));
    }
    return read(sql, params as any);
  }) as typeof adapter.getAllAsync;
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
  // The app's staleTime (lib/query.tsx): a result read within 30 s is not
  // read again. Never collected here (the app collects after 5 min): a
  // query removed while a screen still observes it starts its collection
  // timer when the screen moves to the new one, and jest would wait for it.
  // No retry, so a test never waits either.
  qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 30, gcTime: Infinity, retry: false },
    },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(AuthProvider, null, createElement(Screen))
      )
    );
  });
  await settle();
  // The first event a subscriber gets: the session getSession gave.
  await authEvent('INITIAL_SESSION', sessionOf('u'));
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

describe('the read cache belongs to the account signed in (#177)', () => {
  it("C0 (pin): u's screen shows u's account and u's register", () => {
    expect(seen[seen.length - 1]).toEqual({
      user: 'u',
      accounts: ['Checking'],
      register: ['Rent'],
    });
  });

  // Before #177: b's screen was handed u's cached list and register, fresh
  // for 30 s, so nothing even read them again.
  it("C1: b signing in straight over u never sees u's accounts or register", async () => {
    await authEvent('SIGNED_IN', sessionOf('b'));

    const b = rendersOf('b');
    expect(b.length).toBeGreaterThan(0);
    expect(b.filter((s) => s.accounts.includes('Checking'))).toEqual([]);
    expect(b.filter((s) => s.register.includes('Rent'))).toEqual([]);
    expect(b[b.length - 1]).toEqual({
      user: 'b',
      accounts: ['Wallet'],
      register: [],
    });
    expect(accountReads).toEqual(['u', 'b']);
  });

  it("C2: b signing in after u signed out never sees u's accounts or register", async () => {
    await authEvent('SIGNED_OUT', null);
    const signedOut = rendersOf(null);
    await authEvent('SIGNED_IN', sessionOf('b'));

    const b = rendersOf('b');
    expect(b.length).toBeGreaterThan(0);
    expect(b.filter((s) => s.accounts.includes('Checking'))).toEqual([]);
    expect(b.filter((s) => s.register.includes('Rent'))).toEqual([]);
    expect(b[b.length - 1].accounts).toEqual(['Wallet']);
    // Signed out, the screens are given nothing of u's either.
    expect(
      signedOut.filter((s) => s.accounts.length > 0 || s.register.length > 0)
    ).toEqual([]);
  });

  // The same account's session renewed, re-announced or updated is not a new
  // account: the cache stays, and nothing is read again.
  it('C3 (pin): events for the account already signed in keep the cache (mutant: removed on every event)', async () => {
    await authEvent('TOKEN_REFRESHED', sessionOf('u'));
    await authEvent('USER_UPDATED', sessionOf('u'));
    await authEvent('SIGNED_IN', sessionOf('u'));

    expect(accountReads).toEqual(['u']);
    expect(seen[seen.length - 1]).toEqual({
      user: 'u',
      accounts: ['Checking'],
      register: ['Rent'],
    });
  });

  // A mutation in the cache is the previous account's edit, waiting for the
  // network (TanStack pauses a mutation made offline): dropping it would lose
  // that edit, which nothing else holds.
  it('C4 (pin): a change of account keeps the mutation cache (mutant: queryClient.clear())', async () => {
    const waiting = qc.getMutationCache().build(qc, {
      mutationKey: ['waiting'],
      mutationFn: async () => undefined,
    });

    try {
      await authEvent('SIGNED_OUT', null);
      await authEvent('SIGNED_IN', sessionOf('b'));

      expect(
        qc.getMutationCache().findAll({ mutationKey: ['waiting'] })
      ).toEqual([waiting]);
    } finally {
      // Its collection timer (gcTime, 5 min) would keep jest from exiting:
      // the mutation cache's clear() does not stop it.
      waiting.destroy();
    }
  });
});

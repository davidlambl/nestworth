// The reads a screen makes by id are the signed-in user's (#177). Several
// accounts sign in on one device in turn, and sign-out wipes no local rows
// (CONTRIBUTING, "Sync meta keys"), so a second account can reach the first
// one's ids: on web through the browser's history, a bookmark or a typed
// link, on iOS through a stale deep link. useTransaction, useAccount and
// useTransactions read by id, or by account id, alone: that account's edit
// screen showed the first one's payee, amount, memo and account, its register
// listed the first one's transactions, and its New Transaction screen offered
// the first one's payees. Now each read takes the signed-in user too, and
// another account's row reads as missing: the edit screen's 'Transaction not
// found', the register's 'Account not found' (its gone banner, #163) and an
// empty list. Nothing says the row exists for another account.
//
// Own file, importing the hooks and the fixture. U1-U3 and U5 load on the code
// before #177 and are red there; U4 and U7-U10 are pins; U6 needs
// isTransactionNotFound, new in #177, and is proven red by its mutant. The
// harness is useAccountGone.test.ts's, with the signed-in user switchable as
// in useReceiptUrl.test.ts.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
let mockUserId = 'u';
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: mockUserId } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { getDb } from '../db';
import { isAccountNotFound, useAccount } from '../hooks/useAccounts';
import {
  isTransactionNotFound,
  useTransaction,
  useTransactions,
} from '../hooks/useTransactions';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
/** The test's harness; none for a test that renders nothing (U6). */
let renderer: ReactTestRenderer | undefined;
let edit: ReturnType<typeof useTransaction>;
let account: ReturnType<typeof useAccount>;
let list: ReturnType<typeof useTransactions>;

/**
 * What the edit screen reads (the transaction, and the account its link
 * names) and what the register reads (its account and its list).
 */
function Harness({ txnId, accountId }: { txnId: string; accountId: string }) {
  const t = useTransaction(txnId);
  const a = useAccount(accountId);
  const l = useTransactions(accountId);
  useEffect(() => {
    edit = t;
    account = a;
    list = l;
  });
  return null;
}

/** Lets every query in flight settle (useAccountGone.test.ts). */
async function settle() {
  for (let i = 0, idle = 0; i < 20 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

/** Opens the screens' reads as `userId`. */
async function open(userId: string, txnId: string, accountId: string) {
  mockUserId = userId;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Harness, { txnId, accountId })
      )
    );
  });
  await settle();
}

/** What a screen would render from each read. */
function shown() {
  return {
    edit: {
      status: edit.status,
      error: edit.error ? String(edit.error) : null,
      payee: edit.data?.payee ?? null,
      splits: (edit.data?.splits ?? []).map((s) => s.id),
    },
    account: {
      status: account.status,
      gone: isAccountNotFound(account.error),
      name: account.data?.name ?? null,
    },
    list: (list.data ?? []).map((t) => t.id),
  };
}

beforeEach(async () => {
  renderer = undefined;
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  // u's account and transactions, one of them split; then b's.
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
    txn_date: '2026-06-02',
    payee: 'Rent',
    amount: -1200,
    memo: 'June',
    updated_at: SYNCED_AT,
  });
  await insertLocalSplit(adapter, {
    id: 's1',
    transaction_id: 't1',
    amount: -1200,
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 't2',
    user_id: 'u',
    account_id: 'a1',
    txn_date: '2026-06-01',
    payee: 'Salary',
    amount: 3000,
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
    txn_date: '2026-06-03',
    payee: 'Coffee',
    amount: -4,
    updated_at: SYNCED_AT,
  });
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
});

afterEach(async () => {
  // U9 takes the app offline; a failure there must not leave every later
  // test paused.
  onlineManager.setOnline(true);
  await act(async () => {
    renderer?.unmount();
  });
  qc.clear();
  adapter._sqlite.close();
  mockUserId = 'u';
});

describe("another account's rows read as missing (#177)", () => {
  // Before #177: a success with u's row, splits and all, which the edit
  // screen seeded its form from -- and its Save wrote b's typing into u's row.
  it("U1: b opening u's transaction gets 'Transaction not found', and none of its fields or splits", async () => {
    await open('b', 't1', 'b1');

    expect(shown().edit).toEqual({
      status: 'error',
      error: 'Error: Transaction not found',
      payee: null,
      splits: [],
    });
  });

  // Before #177: u's account (its name in the register's title, its archived
  // banner's Unarchive) and u's two transactions, each with a status toggle.
  it("U2: b opening u's register gets the gone banner's 'Account not found' and an empty list", async () => {
    await open('b', 'tb1', 'a1');

    expect({ account: shown().account, list: shown().list }).toEqual({
      account: { status: 'error', gone: true, name: null },
      list: [],
    });
  });

  // What a write into another account's account left behind before #177 (a
  // New Transaction or Transfer screen opened on u's account id): a row of
  // u's own under b's account. The register lists the signed-in user's rows,
  // not every row filed under the account. An account-ownership check in place
  // of the user's id would pass U2 and fail here.
  it("U3: b's own register does not list a row of u's filed under b's account", async () => {
    await insertLocalTxn(adapter, {
      id: 't3',
      user_id: 'u',
      account_id: 'b1',
      txn_date: '2026-06-04',
      payee: 'Planted',
      amount: -1,
      updated_at: SYNCED_AT,
    });

    await open('b', 'tb1', 'b1');

    expect({ account: shown().account.name, list: shown().list }).toEqual({
      account: 'Wallet',
      list: ['tb1'],
    });
  });

  it("U4 (pin): u's own reads are unchanged: the transaction with its splits, the account, the register's list", async () => {
    await open('u', 't1', 'a1');

    expect(shown()).toEqual({
      edit: { status: 'success', error: null, payee: 'Rent', splits: ['s1'] },
      account: { status: 'success', gone: false, name: 'Checking' },
      list: ['t1', 't2'],
    });
    expect(list.data?.[0].splits.map((s) => s.id)).toEqual(['s1']);
  });

  // The app retries a failed query once, a second later (lib/query.tsx). Not
  // found is this device's own answer, and the retry reads the same rows: the
  // edit screen would spin for that second before it says the transaction is
  // not here. useAccount has skipped the retry since #163.
  it("U5: a transaction that is not here, or not the signed-in user's, fails on the first read, without the app retry", async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    const reads: string[] = [];
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM transactions WHERE id = \?/.test(sql)) {
        reads.push(String(params?.[0]));
      }
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('b', 'gone', 'b1');
    const missing = { status: edit.status, error: String(edit.error) };
    await act(async () => {
      renderer!.unmount();
    });
    await open('b', 't1', 'b1');
    const foreign = { status: edit.status, error: String(edit.error) };

    expect({ missing, foreign, reads }).toEqual({
      missing: { status: 'error', error: 'Error: Transaction not found' },
      foreign: { status: 'error', error: 'Error: Transaction not found' },
      reads: ['gone', 't1'],
    });
  });

  // The edit screen shows the missing-row words in place of its form on this
  // error alone: any other failure of the read says nothing about the row.
  it('U6: isTransactionNotFound is true for the not-found error alone (mutants: any Error, a substring match)', () => {
    expect({
      notFound: isTransactionNotFound(new Error('Transaction not found')),
      otherError: isTransactionNotFound(new Error('database is locked')),
      longer: isTransactionNotFound(
        new Error('Transaction not found: database is locked')
      ),
      bareString: isTransactionNotFound('Transaction not found'),
      none: isTransactionNotFound(null),
    }).toEqual({
      notFound: true,
      otherError: false,
      longer: false,
      bareString: false,
      none: false,
    });
  });
});

// The edit screen offers its form only over a row it has loaded (#177): the
// words for a not-found, the spinner otherwise. These pin what that gate
// stands on.
describe("the edit screen's read of its transaction (#177)", () => {
  // Any other failure says nothing about the row and keeps the app's retry
  // (lib/query.tsx): a locked database is usually free a second later, and the
  // screen then shows the row. Only not-found skips the retry (U5).
  it('U7 (pin): a read that fails for another reason is retried once, then shows the row', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    let failures = 1;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM transactions WHERE id = \?/.test(sql) && failures > 0) {
        failures -= 1;
        throw new Error('database is locked');
      }
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('u', 't1', 'a1');

    expect({ status: edit.status, payee: edit.data?.payee ?? null }).toEqual({
      status: 'success',
      payee: 'Rent',
    });
  });

  // Once, the app's count (QUERY_RETRY), not more: a read that fails on its
  // retry too stays failed -- the screen's spinner -- until the next refetch,
  // which every sync ends with, reads the row.
  it('U10 (pin): a read that fails for another reason on its retry too is not read a third time', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    const reads: string[] = [];
    let failures = 2;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM transactions WHERE id = \?/.test(sql)) {
        reads.push(String(params?.[0]));
        if (failures > 0) {
          failures -= 1;
          throw new Error('database is locked');
        }
      }
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('u', 't1', 'a1');

    expect({ status: edit.status, error: String(edit.error), reads }).toEqual({
      status: 'error',
      error: 'Error: database is locked',
      reads: ['t1', 't1'],
    });
  });

  // A link opened before the row is here (a deep link during the first
  // download): the screen says it is gone, and shows it once the download's
  // end refetches every query (lib/query.tsx), the failed one included.
  it("U8 (pin): b's own transaction opened before it is here says gone, then shows once a refetch reads it", async () => {
    await open('b', 'tb9', 'b1');
    expect(String(edit.error)).toBe('Error: Transaction not found');

    await insertLocalTxn(adapter, {
      id: 'tb9',
      user_id: 'b',
      account_id: 'b1',
      txn_date: '2026-06-05',
      payee: 'Coffee',
      amount: -4,
      updated_at: SYNCED_AT,
    });
    await act(async () => {
      await qc.invalidateQueries();
    });
    await settle();

    expect({ status: edit.status, payee: edit.data?.payee ?? null }).toEqual({
      status: 'success',
      payee: 'Coffee',
    });
  });

  // TanStack pauses a query offline (lib/query.tsx wires its onlineManager to
  // NetInfo), so a transaction not in the cache is neither loading nor
  // loaded: the edit screen's old `if (isLoading)` gate opened its EMPTY form
  // over the user's own row then, and a Save queued an edit with a blank date
  // and payee. The form now waits for the row.
  it('U9 (pin): offline, a transaction not in the cache is neither loading nor loaded', async () => {
    onlineManager.setOnline(false);
    await open('u', 't1', 'a1');
    const offline = {
      status: edit.status,
      fetchStatus: edit.fetchStatus,
      isLoading: edit.isLoading,
      data: edit.data ?? null,
    };

    await act(async () => {
      onlineManager.setOnline(true);
    });
    await settle();

    expect(offline).toEqual({
      status: 'pending',
      fetchStatus: 'paused',
      isLoading: false,
      data: null,
    });
    expect(edit.data?.payee).toBe('Rent');
  });
});

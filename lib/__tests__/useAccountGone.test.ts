// The register's signal that its account is gone (#163). The register reads
// ['account', id] (useAccount), and neither an account delete nor a realtime
// account tombstone invalidated it: a register re-opened on the account (the
// browser's Forward, a stale link), or on screen when another device deleted
// it, kept its last data, "+" and the transfer button, until some later sync
// happened to refetch it -- and a refetch then failed with 'Account not
// found' while TanStack kept the last data, which the register did not look
// at. Now the delete and the realtime handler refetch ['account', id], a
// not-found is not retried, and the register reads the error through
// isAccountNotFound and offers nothing that writes into the account. The
// screen itself has no component test (the repo has none): what it shows is
// verified in a browser; these tests pin the signal it is built on.
//
// Own file, importing the hooks and the fixture; G1, G2, G4, G5 and G7 load
// on the code before #163 (G1 and G5 are red there). G3 needs
// isAccountNotFound, new in #163, and G6 the not-found retry rule.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDb } from '../db';
import { supabase } from '../supabase';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  isAccountNotFound,
  useAccount,
  useAccounts,
  useDeleteAccount,
} from '../hooks/useAccounts';
import { insertLocalAccount, makeAdapter } from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let register: ReturnType<typeof useAccount>;
let picker: ReturnType<typeof useAccounts>;
let delAccount: ReturnType<typeof useDeleteAccount>;

/**
 * A register open on `id`, a picker's list (the transfer, rule and import
 * screens read ['accounts']), and the Accounts screen's delete.
 */
function Harness({ id }: { id: string }) {
  const query = useAccount(id);
  const list = useAccounts();
  const del = useDeleteAccount();
  useEffect(() => {
    register = query;
    picker = list;
    delAccount = del;
  });
  return null;
}

/** The app's realtime subscription (lib/hooks/useRealtimeSync.ts). */
function Realtime() {
  useRealtimeSync();
  return null;
}

type RealtimeHandler = (payload: unknown) => void | Promise<void>;
let realtime: Record<string, RealtimeHandler>;

/**
 * Lets every query in flight settle and its result reach the harness.
 * TanStack hands a result to its observers on a setTimeout(0)
 * (notifyManager), so a query that stops fetching inside one turn is
 * rendered in the next: the loop stops only after a whole turn with nothing
 * fetching. Stopping at the first idle turn lost a retry's result about one
 * run in thirty (G7: two reads, status still 'pending').
 */
async function settle() {
  for (let i = 0, idle = 0; i < 20 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

async function open(id: string) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Harness, { id })
      )
    );
  });
  await settle();
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  await insertLocalAccount(adapter, {
    id: 'a1',
    name: 'Old',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(adapter, {
    id: 'a2',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  // A channel that hands each table's handler to the test (G5).
  realtime = {};
  const channel = {
    on: (_event: string, filter: { table: string }, h: RealtimeHandler) => {
      realtime[filter.table] = h;
      return channel;
    },
    subscribe: () => channel,
  };
  Object.assign(supabase, { channel: () => channel, removeChannel: () => {} });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

describe("the register's signal that its account is gone (#163)", () => {
  // Before #163 the delete left ['account', 'a1'] alone: the register's
  // query stayed a success with the account's data, and nothing told it.
  it('G1: deleting the account a register is open on fails its query with Account not found, keeping the last data', async () => {
    await open('a1');
    const before = { name: register.data?.name, error: register.error };

    await act(async () => {
      await delAccount.mutateAsync('a1');
    });
    await settle();

    expect({
      before,
      after: {
        status: register.status,
        error: String(register.error),
        name: register.data?.name,
      },
    }).toEqual({
      before: { name: 'Old', error: null },
      after: {
        status: 'error',
        error: 'Error: Account not found',
        name: 'Old',
      },
    });
  });

  it('G2 (pin): deleting another account leaves the register as it was', async () => {
    await open('a1');

    await act(async () => {
      await delAccount.mutateAsync('a2');
    });
    await settle();

    expect({
      status: register.status,
      error: register.error,
      name: register.data?.name,
    }).toEqual({ status: 'success', error: null, name: 'Old' });
  });

  // Only the not-found error is "gone": a read that fails for any other
  // reason says nothing about the account, and the register must not tell
  // the user it was deleted.
  it('G3: isAccountNotFound is true for the not-found error alone', () => {
    expect({
      notFound: isAccountNotFound(new Error('Account not found')),
      otherError: isAccountNotFound(new Error('database is locked')),
      bareString: isAccountNotFound('Account not found'),
      none: isAccountNotFound(null),
    }).toEqual({
      notFound: true,
      otherError: false,
      bareString: false,
      none: false,
    });
  });

  // What a picker lists. The delete refetches ['accounts'] (it always did),
  // and the list reads live accounts only, so a mounted picker drops the
  // account as soon as the delete settles. What it does not drop is an id
  // already chosen: the transfer, rule and import screens keep their chosen
  // account in their own state, which is why their writers check it (#163).
  it('G4 (pin): a mounted picker list drops a deleted account once the delete settles', async () => {
    await open('a1');
    const before = (picker.data ?? []).map((a) => a.id);

    await act(async () => {
      await delAccount.mutateAsync('a1');
    });
    await settle();

    expect({ before, after: (picker.data ?? []).map((a) => a.id) }).toEqual({
      before: ['a1', 'a2'],
      after: ['a2'],
    });
  });

  // The app retries a failed query once, a second later (lib/query.tsx). For
  // 'Account not found' that second is a register re-opened on a dead account
  // (web history Forward, a reload, a stale link) still offering "+" and the
  // transfer button: the retry reads the same local row and fails the same way.
  it('G6: a missing account fails its query on the first read, without the app retry', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    let accountReads = 0;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM accounts WHERE id = \?/.test(sql)) accountReads++;
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('gone');

    expect({
      status: register.status,
      error: String(register.error),
      accountReads,
    }).toEqual({
      status: 'error',
      error: 'Error: Account not found',
      accountReads: 1,
    });
  });

  it('G7 (pin): any other read failure keeps the app retry', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    let accountReads = 0;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM accounts WHERE id = \?/.test(sql)) {
        accountReads++;
        if (accountReads === 1) throw new Error('database is locked');
      }
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('a1');

    expect({
      status: register.status,
      name: register.data?.name,
      accountReads,
    }).toEqual({ status: 'success', name: 'Old', accountReads: 2 });
  });

  // The register on screen when another device deletes its account: on iOS
  // the only way a register meets a dead account (it cannot stay mounted under
  // the Accounts tab, where this device deletes one), and on web the likeliest.
  // The tombstone arrives by realtime and removes the synced account here, but
  // the handler refetched ['accounts'] only, so the register kept "+" and the
  // transfer button until a background sync or a refused write.
  it('G5: an account tombstone from realtime fails a mounted register with Account not found', async () => {
    let rt: ReactTestRenderer;
    await act(async () => {
      rt = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Realtime)
        )
      );
    });
    await open('a1');

    await act(async () => {
      await realtime.accounts({
        eventType: 'UPDATE',
        new: { id: 'a1', user_id: 'u', deleted_at: '2026-10-01T00:00:00Z' },
        old: {},
      });
    });
    await settle();
    await act(async () => {
      rt.unmount();
    });

    expect({
      local: adapter._sqlite.prepare('SELECT id FROM accounts').all(),
      picker: (picker.data ?? []).map((a) => a.id),
      register: {
        status: register.status,
        error: String(register.error),
        name: register.data?.name,
      },
    }).toEqual({
      local: [{ id: 'a2' }],
      picker: ['a2'],
      register: {
        status: 'error',
        error: 'Error: Account not found',
        name: 'Old',
      },
    });
  });
});

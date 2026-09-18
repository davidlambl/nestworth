// Hook-level regression test for #69: rapid chevron taps must compose.
//
// Recipe mirrors lib/__tests__/realtimeWiring.test.ts: react-test-renderer,
// real QueryClient/QueryClientProvider, jest.mock('../db') returning a
// better-sqlite3 adapter seeded with accounts, mocked auth/sync/expo-crypto.

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
import { requestPush } from '../sync';
import { useAccounts, useReorderAccounts } from '../hooks/useAccounts';
import { makeAdapter, insertLocalAccount } from '../testing/syncFixture';
import type { AccountWithBalance } from '../types';

const ACCOUNTS_KEY = ['accounts'];

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;

// Captured hook return values from the test component.
let hookResult: {
  accounts: AccountWithBalance[] | undefined;
  move: (
    id: string,
    direction: -1 | 1,
    onWillWrite?: () => void
  ) => Promise<boolean>;
  isPending: boolean;
};
let renderer: ReactTestRenderer;

function TestComponent() {
  const { data } = useAccounts();
  const reorder = useReorderAccounts();
  useEffect(() => {
    hookResult = {
      accounts: data,
      move: reorder.move,
      isPending: reorder.isPending,
    };
  });
  return null;
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockImplementation(async () => adapter);
  (requestPush as unknown as jest.Mock).mockClear();

  // Seed: A(sort_order=0), C(sort_order=1), B(sort_order=2), Z(archived)
  await insertLocalAccount(adapter, { id: 'A', name: 'A', sort_order: 0 });
  await insertLocalAccount(adapter, { id: 'C', name: 'C', sort_order: 1 });
  await insertLocalAccount(adapter, { id: 'B', name: 'B', sort_order: 2 });
  await insertLocalAccount(adapter, {
    id: 'Z',
    name: 'Z',
    sort_order: 3,
    is_archived: true,
  });

  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
});

afterEach(async () => {
  // Unmount the component tree so React releases hooks, then tear down TanStack
  // Query's mutation / query caches to avoid dangling promises from scoped
  // mutations keeping Jest alive.
  await act(async () => {
    renderer?.unmount();
  });
  qc.getMutationCache().clear();
  qc.getQueryCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TestComponent)
      )
    );
  });
  // Wait for useAccounts query to resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('useReorderAccounts', () => {
  it('two rapid move calls from the same render compose to [C, B, A]', async () => {
    await mount();

    // Sanity: initial active order is [A, C, B], Z is archived at tail.
    const initial = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY);
    expect(initial!.filter((a) => !a.isArchived).map((a) => a.id)).toEqual([
      'A',
      'C',
      'B',
    ]);

    // Capture `move` from a single render — simulates two taps before
    // React re-renders the component.
    const { move } = hookResult;
    const onWillWrite = jest.fn();

    await act(async () => {
      move('A', 1, onWillWrite); // A down once: [C, A, B]
      move('A', 1, onWillWrite); // A down again: [C, B, A]
    });

    // Allow mutations to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Cache: active order is [C, B, A], Z still last.
    const cached = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    expect(cached.map((a) => a.id)).toEqual(['C', 'B', 'A', 'Z']);

    // SQLite: sort_order values are C=0, B=1, A=2, all pending.
    const rows = adapter._sqlite
      .prepare(
        'SELECT id, sort_order, _sync_status FROM accounts WHERE is_archived = 0 ORDER BY sort_order'
      )
      .all() as { id: string; sort_order: number; _sync_status: string }[];

    expect(rows).toEqual([
      { id: 'C', sort_order: 0, _sync_status: 'pending' },
      { id: 'B', sort_order: 1, _sync_status: 'pending' },
      { id: 'A', sort_order: 2, _sync_status: 'pending' },
    ]);

    // requestPush was called (deferred via setTimeout).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(requestPush).toHaveBeenCalled();

    // onWillWrite callback fired once per successful move.
    expect(onWillWrite).toHaveBeenCalledTimes(2);
  });

  it('moving the last item down is a no-op', async () => {
    await mount();

    const { move } = hookResult;
    const before = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    const onWillWrite = jest.fn();

    await act(async () => {
      move('B', 1, onWillWrite); // B is last active — should be a no-op
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const after = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));

    // onWillWrite must NOT fire for a no-op move.
    expect(onWillWrite).not.toHaveBeenCalled();
  });
});

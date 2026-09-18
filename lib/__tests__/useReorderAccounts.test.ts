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

  it('a refetch that clobbers the cache mid-burst does not corrupt disk order', async () => {
    // This is the post-merge #69 flake: a sync pull invalidates ['accounts']
    // mid-burst, the refetch reads disk before tap 1's transaction commits,
    // and the cache is overwritten with the old order. If mutationFn derived
    // the write from the cache (the old design), tap 2 would compute from
    // that stale data and disk would end [C, A, B]. With the disk-based
    // mutationFn, each write reads disk inside the serialized transaction,
    // so it sees the previous commit.

    // Intercept withTransactionAsync so we can block the FIRST reorder
    // transaction and let a refetch land while it is pending.
    const realWithTx = adapter.withTransactionAsync.bind(adapter);
    let firstTxBlock: {
      promise: Promise<void>;
      resolve: () => void;
    } | null = null;
    let txCallCount = 0;

    adapter.withTransactionAsync = async (fn: () => Promise<void>) => {
      txCallCount++;
      if (txCallCount === 1) {
        // First reorder transaction: block until we release it.
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        firstTxBlock = { promise, resolve };
        await promise;
      }
      return realWithTx(fn);
    };

    await mount();

    const { move } = hookResult;

    // Tap 1: optimistic cache becomes [C, A, B], mutationFn is blocked.
    await act(async () => {
      move('A', 1);
    });

    // The optimistic cache should show [C, A, B, Z].
    const afterTap1 = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    expect(afterTap1.map((a) => a.id)).toEqual(['C', 'A', 'B', 'Z']);

    // Simulate a sync refetch landing while tap 1's transaction is blocked.
    // This reads disk (still [A, C, B]) and overwrites the cache.
    await act(async () => {
      await qc.refetchQueries({ queryKey: ACCOUNTS_KEY });
    });

    // Verify the cache was clobbered back to the original disk order.
    const afterRefetch = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    expect(afterRefetch.filter((a) => !a.isArchived).map((a) => a.id)).toEqual([
      'A',
      'C',
      'B',
    ]);

    // Tap 2: the cache now shows the stale order [A, C, B]. The optimistic
    // write moves A down again → cache becomes [C, A, B] (not [C, B, A]).
    // If mutationFn derived the write from the cache, disk would end wrong.
    await act(async () => {
      move('A', 1);
    });

    // Release the blocked first transaction so both writes can proceed.
    firstTxBlock!.resolve();

    // Wait for both mutations to complete (scope-serialized).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    // Poll until no mutations are in flight (bounded to avoid hanging).
    const deadline = Date.now() + 3000;
    await act(async () => {
      while (qc.isMutating() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    if (qc.isMutating() > 0) {
      throw new Error(
        `Mutations still pending after 3 s (count: ${qc.isMutating()})`
      );
    }

    // Wait for the onSettled invalidate refetch to land.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Disk: sort_order must be C=0, B=1, A=2 — the correct composed order.
    const rows = adapter._sqlite
      .prepare(
        'SELECT id, sort_order FROM accounts WHERE is_archived = 0 ORDER BY sort_order'
      )
      .all() as { id: string; sort_order: number }[];

    expect(rows).toEqual([
      { id: 'C', sort_order: 0 },
      { id: 'B', sort_order: 1 },
      { id: 'A', sort_order: 2 },
    ]);

    // Cache must agree after the onSettled refetch.
    const finalCache = qc.getQueryData<AccountWithBalance[]>(ACCOUNTS_KEY)!;
    expect(finalCache.map((a) => a.id)).toEqual(['C', 'B', 'A', 'Z']);
  });
});

// useMoveRefusedRow (#115): Settings' list moves a row the push can never
// upload to a live account. The hook writes through applyRefusedRowMove,
// requests a push only when the row moved, refetches the screens the row
// left and joined whether it moved or not, and refreshes the sync status the
// list and its counts come from (requestPush refreshes it only once its push
// is over). It runs offline too: the write is local.
//
// A new hook: this file cannot load on the code before it, so its regression
// proofs are the named mutants (the unit file). The harness follows
// useDeleteRecurringRule.test.ts.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { getDb, getSyncMeta } from '../db';
import { requestPush } from '../sync';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import { useMoveRefusedRow } from '../hooks/useRefusedRows';
import type { RefusedRow } from '../syncRefusals';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const WRITTEN_AT = '2026-10-15T08:00:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let move: ReturnType<typeof useMoveRefusedRow>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useMoveRefusedRow();
  useEffect(() => {
    move = mutation;
  });
  return null;
}

const REFUSED: RefusedRow = {
  table: 'transactions',
  id: 't1',
  kind: 'account',
  code: '23503',
  since: WRITTEN_AT,
  updatedAt: WRITTEN_AT,
  accountId: 'a1',
  accountName: 'Old',
  accountLive: false,
  txnDate: '2026-10-15',
  payee: 'Grocer',
  amount: -12.34,
  transferLinkId: null,
  partnerAccountId: null,
  partnerAccountName: null,
  unsyncedSplits: 0,
};

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  // The push was refused t1 under a1, which this device no longer has.
  (getSyncMeta as unknown as jest.Mock).mockImplementation(async (k: string) =>
    k === 'push_refusals:u'
      ? JSON.stringify([
          {
            table: 'transactions',
            id: 't1',
            updatedAt: WRITTEN_AT,
            accountId: 'a1',
            kind: 'account',
            code: '23503',
            accountName: 'Old',
            since: WRITTEN_AT,
          },
        ])
      : null
  );
  await insertLocalAccount(adapter, { id: 'a3', name: 'Brokerage' });
  await insertLocalTxn(adapter, {
    id: 't1',
    account_id: 'a1',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });

  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  invalidate = jest.spyOn(qc, 'invalidateQueries');
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
  // Settings has shown the row: the store lists it.
  await refreshSyncState('u');
});

afterEach(async () => {
  // Cleared first: a mutation still paused offline must not resume into a
  // closed database when the test goes back online.
  qc.getMutationCache().clear();
  onlineManager.setOnline(true);
  await act(async () => {
    renderer.unmount();
  });
  qc.clear();
  adapter._sqlite.close();
});

async function moveThrough(accountId: string): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await move.mutateAsync({ row: REFUSED, accountId }).then(
      () => 'resolved',
      (e) => String(e)
    );
  });
  return outcome;
}

const keys = () => invalidate.mock.calls.map((c) => c[0]?.queryKey);

describe('useMoveRefusedRow (#115)', () => {
  it('H1: moves the row, requests one push, refetches both registers and the totals, and refreshes the list', async () => {
    const listed = getSyncSnapshot().refusedCount;
    expect(await moveThrough('a3')).toBe('resolved');

    expect({
      row: adapter._sqlite
        .prepare(
          'SELECT account_id, _sync_status FROM transactions WHERE id = ?'
        )
        .get('t1'),
      pushes: (requestPush as unknown as jest.Mock).mock.calls,
      keys: keys(),
      // Refreshed after the move: the row changed, so it is no longer listed.
      listed,
      refused: getSyncSnapshot().refusedCount,
      user: getSyncSnapshot().snapshotUserId,
    }).toEqual({
      row: { account_id: 'a3', _sync_status: 'pending' },
      pushes: [['u']],
      keys: [
        ['transactions', 'a1'],
        ['transactions', 'a3'],
        ['transactions', '__all__'],
        ['transaction', 't1'],
        ['accounts'],
        ['reports'],
      ],
      listed: 1,
      refused: 0,
      user: 'u',
    });
  });

  it('H2: a refused move writes nothing and requests no push, and still refetches and refreshes', async () => {
    const outcome = await moveThrough('a9');

    expect({
      outcome,
      row: adapter._sqlite
        .prepare('SELECT account_id FROM transactions WHERE id = ?')
        .get('t1'),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
      keys: keys().length,
      refused: getSyncSnapshot().refusedCount,
    }).toEqual({
      outcome:
        'Error: The account you chose no longer exists on this device, so the transaction was not moved.',
      row: { account_id: 'a1' },
      pushes: 0,
      keys: 6,
      refused: 1,
    });
  });

  it('H3: offline, the move still runs at once: it is a local write', async () => {
    onlineManager.setOnline(false);
    let settled = '';
    await act(async () => {
      const run = move.mutateAsync({ row: REFUSED, accountId: 'a3' }).then(
        () => 'resolved',
        (e) => String(e)
      );
      // A mutation TanStack holds for the network never settles offline.
      settled = await Promise.race([
        run,
        new Promise<string>((done) => setTimeout(() => done('paused'), 300)),
      ]);
    });

    expect(settled).toBe('resolved');
    expect(
      adapter._sqlite
        .prepare('SELECT account_id FROM transactions WHERE id = ?')
        .get('t1')
    ).toEqual({ account_id: 'a3' });
  });
});

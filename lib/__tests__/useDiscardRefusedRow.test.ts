// useDiscardRefusedRow (#115): Settings' list discards a row the push can
// never upload. The hook writes through applyRefusedRowDiscard, requests a
// push only when it marked the row (a second tap has nothing to send),
// refetches the row's screens whether it went through or not, and refreshes
// the sync status the list comes from. It runs offline too: the write is
// local.
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
import { useDiscardRefusedRow } from '../hooks/useRefusedRows';
import type { RefusedRow } from '../syncRefusals';
import { insertLocalRule, makeAdapter } from '../testing/syncFixture';

const WRITTEN_AT = '2026-10-15T08:00:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let discard: ReturnType<typeof useDiscardRefusedRow>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useDiscardRefusedRow();
  useEffect(() => {
    discard = mutation;
  });
  return null;
}

/** A rule whose template this device cannot prepare (#129). */
const REFUSED: RefusedRow = {
  table: 'recurring_rules',
  id: 'r1',
  kind: 'unprepared',
  code: '',
  since: WRITTEN_AT,
  updatedAt: WRITTEN_AT,
  accountId: 'a2',
  accountName: 'Savings',
  accountLive: true,
  frequency: 'monthly',
  nextDate: '2026-11-01',
  payee: null,
  amount: null,
};

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  (getSyncMeta as unknown as jest.Mock).mockImplementation(async (k: string) =>
    k === 'push_refusals:u'
      ? JSON.stringify([
          {
            table: 'recurring_rules',
            id: 'r1',
            updatedAt: WRITTEN_AT,
            accountId: 'a2',
            kind: 'unprepared',
            code: '',
            accountName: null,
            since: WRITTEN_AT,
          },
        ])
      : null
  );
  await insertLocalRule(adapter, {
    id: 'r1',
    account_id: 'a2',
    template: '{oops',
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
  // Settings has shown the rule: the store lists it.
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

async function discardThrough(row: RefusedRow = REFUSED): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await discard.mutateAsync(row).then(
      () => 'resolved',
      (e) => String(e)
    );
  });
  return outcome;
}

const status = () =>
  (
    adapter._sqlite
      .prepare('SELECT _sync_status FROM recurring_rules WHERE id = ?')
      .get('r1') as { _sync_status: string }
  )._sync_status;

describe('useDiscardRefusedRow (#115)', () => {
  it('H4: marks the rule deleted, requests one push, refetches the rules and refreshes the list', async () => {
    const listed = getSyncSnapshot().refusedCount;
    expect(await discardThrough()).toBe('resolved');

    expect({
      status: status(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls,
      keys: invalidate.mock.calls.map((c) => c[0]?.queryKey),
      listed,
      refused: getSyncSnapshot().refusedCount,
    }).toEqual({
      status: 'deleted',
      pushes: [['u']],
      keys: [['recurring_rules']],
      listed: 1,
      refused: 0,
    });
  });

  it('H5: a second tap resolves with nothing to send', async () => {
    await discardThrough();
    (requestPush as unknown as jest.Mock).mockClear();

    expect(await discardThrough()).toBe('resolved');
    expect((requestPush as unknown as jest.Mock).mock.calls.length).toBe(0);
  });

  it('H6: a row changed since the list was read is refused, with no push, and the list refetches', async () => {
    adapter._sqlite
      .prepare(
        "UPDATE recurring_rules SET updated_at = '2026-10-15T09:00:00.000Z' WHERE id = 'r1'"
      )
      .run();

    expect({
      outcome: await discardThrough(),
      status: status(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
      keys: invalidate.mock.calls.length,
    }).toEqual({
      outcome:
        'Error: This rule changed on this device since the list was shown, so it was not discarded.',
      status: 'pending',
      pushes: 0,
      keys: 1,
    });
  });

  it('H7: offline, the discard still runs at once: it is a local write', async () => {
    onlineManager.setOnline(false);
    let settled = '';
    await act(async () => {
      const run = discard.mutateAsync(REFUSED).then(
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
    expect(status()).toBe('deleted');
  });
});

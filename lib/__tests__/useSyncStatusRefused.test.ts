// The data Settings shows for the rows the push can never upload (#115),
// through the hook it reads: useSyncStatus gives the signed-in user's refused
// rows and counts, and nobody else's. The status store is shared by every
// account signed in on this device, and a refresh for another one -- a stale
// requestPush for the outgoing user after a switch (#111), or that user's own
// session -- publishes that account's rows into it; Settings must not show
// them (payees and amounts of another account: #177's class).
//
// Imports only the hook, the status store and the fixture, so it loads on the
// code before #115, where the hook had no refused rows to give.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ fullSync: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDb, getSyncMeta } from '../db';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import { useSyncStatus } from '../hooks/useSyncStatus';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

const WRITTEN_AT = '2026-10-15T08:00:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let seen: ReturnType<typeof useSyncStatus>;
/** What each render handed out, in order. */
let views: ReturnType<typeof viewOf>[];
let known: boolean[];

function Harness() {
  const status = useSyncStatus();
  useEffect(() => {
    seen = status;
    views.push(viewOf(status));
    known.push(status.refusedKnown);
  });
  return null;
}

const entry = (id: string, accountId: string, accountName: string) => ({
  table: 'transactions',
  id,
  updatedAt: WRITTEN_AT,
  accountId,
  kind: 'account',
  code: '23503',
  accountName,
  since: WRITTEN_AT,
});

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  const keys = new Map([
    ['push_refusals:u', JSON.stringify([entry('t-u', 'a1', 'Old')])],
    ['push_refusals:b', JSON.stringify([entry('t-b', 'b1', 'Theirs')])],
  ]);
  (getSyncMeta as unknown as jest.Mock).mockImplementation(
    async (k: string) => keys.get(k) ?? null
  );
  await insertLocalTxn(adapter, {
    id: 't-u',
    account_id: 'a1',
    payee: 'Grocer',
    amount: -12.34,
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  await insertLocalAccount(adapter, { id: 'b1', user_id: 'b', name: 'Theirs' });
  await insertLocalTxn(adapter, {
    id: 't-b',
    user_id: 'b',
    account_id: 'b1',
    payee: 'Their payee',
    amount: -99,
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  // b has a second unsynced row, so its count tells the two stores apart.
  await insertLocalTxn(adapter, {
    id: 't-b2',
    user_id: 'b',
    account_id: 'b1',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  views = [];
  known = [];
  qc = new QueryClient();
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
  // The hook's mount refresh, for the signed-in user.
  await act(async () => {
    await refreshSyncState('u');
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.clear();
  adapter._sqlite.close();
});

const viewOf = (status: ReturnType<typeof useSyncStatus>) => ({
  count: status.refusedCount,
  rows: (status.refusedRows ?? []).map(
    (r: any) => `${r.id}:${r.payee}:${r.accountName}`
  ),
  pending: status.pendingCount,
});
const shown = () => viewOf(seen);
/** Consecutive repeats collapsed: what the screen went through. */
const went = <T>(list: T[]) =>
  list.filter(
    (v, i) => i === 0 || JSON.stringify(v) !== JSON.stringify(list[i - 1])
  );

describe('useSyncStatus and the rows the push can never upload (#115)', () => {
  it("S1: gives the signed-in user's refused rows, by name, and never another account's", async () => {
    const mine = shown();
    views = [];
    // Another account's refresh lands in the shared store.
    await act(async () => {
      await refreshSyncState('b');
    });

    expect({
      mine,
      afterOthers: went(views),
      store: getSyncSnapshot().snapshotUserId,
    }).toEqual({
      mine: { count: 1, rows: ['t-u:Grocer:Old'], pending: 1 },
      // Nothing of the other account's, its pending count included since
      // #193 (it showed b's 2 before), for the one render until the hook has
      // read this user's back (useSyncStatusSwitch.test.ts).
      afterOthers: [{ count: 0, rows: [], pending: 0 }, mine],
      store: 'u',
    });
  });

  it("S2: says whether this user's refusals have been read, so the list never claims none before it knows", async () => {
    const afterMine = seen.refusedKnown;
    known = [];
    await act(async () => {
      await refreshSyncState('b');
    });
    // Unknown while the store holds the other account's; known again once
    // the hook has read this user's back (#193).
    const afterOthers = went(known);
    await act(async () => {
      await refreshSyncState('u');
    });

    expect({ afterMine, afterOthers, again: seen.refusedKnown }).toEqual({
      afterMine: true,
      afterOthers: [false, true],
      again: true,
    });
  });
});

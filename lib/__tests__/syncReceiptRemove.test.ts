// A removed receipt travels like any field edit (#23). The engine needed
// nothing new: the push uploads the whole local row, so `receipt_path: null`
// goes up and PostgREST writes it (it sets every key the payload carries),
// and the pull, the reconcile and realtime upsert the server's receipt_path
// whatever it holds, null included. The first test drives the removal through
// useRemoveReceipt and the real pushChanges; the others PIN the engine's half:
// each was run green on the code before #23, with the hook's import stubbed
// out, since that module is new.
//
// The Storage bucket is the fixture's fake (lib/testing/syncFixture.ts). The
// hooks' push is inert (the repo's partial mock of '../sync', as
// syncAccountEditAfterDelete.test.ts has it) while the tests run the real
// pushChanges and pullChanges.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({
  ...jest.requireActual('../sync'),
  requestPush: jest.fn(),
}));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pullChanges, pushChanges } from '../sync';
import { applyTransactionEvent } from '../realtimeHandlers';
import { useRemoveReceipt } from '../hooks/useRemoveReceipt';
import {
  insertLocalAccount,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When t1 last synced, in PostgREST's rendering. */
const SYNCED_AT = '2026-05-10T00:00:00+00:00';
/** When another device removed t1's receipt. */
const REMOVED_AT = '2026-10-15T09:00:00+00:00';
const PATH = 'u/t1.n1.jpg';

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let removeReceipt: ReturnType<typeof useRemoveReceipt>;
let quiet: jest.SpyInstance[];

function Harness() {
  const mutation = useRemoveReceipt();
  useEffect(() => {
    removeReceipt = mutation;
  });
  return null;
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  // a1 and t1, naming its receipt: on the server and, as of the last pull,
  // here; the photo in the bucket.
  ctx.store.accounts = [remoteAccount({ id: 'a1', updated_at: SYNCED_AT })];
  ctx.store.transactions = [
    remoteTxn({ id: 't1', receipt_path: PATH, updated_at: SYNCED_AT }),
  ];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    receipt_path: PATH,
    updated_at: SYNCED_AT,
  });
  ctx.objects.set(`receipts/${PATH}`, { contentType: 'image/jpeg', body: 'J' });

  qc = new QueryClient({
    defaultOptions: { mutations: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
});

/** t1 here, as the assertions compare it. */
function localT1() {
  return ctx.adapter._sqlite
    .prepare(
      "SELECT receipt_path, _sync_status FROM transactions WHERE id = 't1'"
    )
    .get();
}

const serverT1 = () => ctx.store.transactions.find((r: any) => r.id === 't1');

describe('a receipt removed here reaches the server (#23)', () => {
  it('the removal clears the photo and the transaction, and the next push uploads receipt_path null (mutant: the removal leaves the row synced)', async () => {
    await act(async () => {
      await removeReceipt.mutateAsync({ transactionId: 't1', path: PATH });
    });
    await pushChanges('u');

    // With the row left 'synced': the push skips it, and the server keeps
    // naming a photo that is gone.
    expect(serverT1().receipt_path).toBeNull();
    expect(localT1()).toEqual({ receipt_path: null, _sync_status: 'synced' });
    expect(ctx.objects.has(`receipts/${PATH}`)).toBe(false);
    // Every other field as it was.
    expect(serverT1().payee).toBe('Payee');
  });

  it('pin: the push uploads a NULL receipt_path like any field edit', async () => {
    // The removal's local write, written out: what any build's UPDATE of the
    // column leaves.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET receipt_path = NULL, updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(new Date().toISOString());

    await pushChanges('u');

    expect(serverT1().receipt_path).toBeNull();
    expect(localT1()).toEqual({ receipt_path: null, _sync_status: 'synced' });
  });
});

describe("another device's removal reaches this one (#23)", () => {
  it('pin: the pull lands receipt_path null, so the register and the screen drop the receipt', async () => {
    ctx.store.transactions = [
      remoteTxn({ id: 't1', receipt_path: null, updated_at: REMOVED_AT }),
    ];

    await pullChanges('u');

    expect(localT1()).toEqual({ receipt_path: null, _sync_status: 'synced' });
  });

  it('pin: a realtime update lands receipt_path null', async () => {
    await applyTransactionEvent(ctx.adapter, {
      eventType: 'UPDATE',
      new: remoteTxn({ id: 't1', receipt_path: null, updated_at: REMOVED_AT }),
    });

    expect(localT1()).toEqual({ receipt_path: null, _sync_status: 'synced' });
  });

  it('pin: a removal made here and not pushed yet survives a pull of the receipt it removed', async () => {
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET receipt_path = NULL, updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
      )
      .run(new Date().toISOString());

    await pullChanges('u');

    // The pull's upserts skip a pending row: the removal waits for its push.
    expect(localT1()).toEqual({ receipt_path: null, _sync_status: 'pending' });
    expect(serverT1().receipt_path).toBe(PATH);
  });
});

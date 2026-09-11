// Which handler is attached to which channel is the one thing the realtime
// refactor cannot get wrong safely, and the one thing types cannot catch:
// applyAccountEvent and applyTransactionEvent have identical signatures, so
// swapping them compiles, lints, and passes every other test while silently
// doing nothing at runtime. This asserts the wiring by driving each captured
// handler and checking which table actually moved.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { getDb } from '../db';
import { supabase } from '../supabase';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

type Handler = (payload: any) => void | Promise<void>;

let adapter: ReturnType<typeof makeAdapter>;
let handlers: Record<string, Handler>;

beforeEach(() => {
  adapter = makeAdapter();
  handlers = {};
  (getDb as unknown as jest.Mock).mockImplementation(async () => adapter);

  const channel: any = {
    on: (_event: string, config: any, handler: Handler) => {
      handlers[config.table] = handler;
      return channel;
    },
    subscribe: () => channel,
  };
  (supabase as any).channel = () => channel;
  (supabase as any).removeChannel = () => {};
});

afterEach(() => {
  adapter._sqlite.close();
});

async function mountHook() {
  await act(async () => {
    TestRenderer.create(createElement(() => (useRealtimeSync(), null)));
  });
}

const tombstone = (row: any) => ({
  eventType: 'UPDATE',
  new: { ...row, deleted_at: '2026-06-16T00:00:00Z' },
  old: {},
});

describe('useRealtimeSync channel wiring', () => {
  it('routes the accounts channel to the accounts handler', async () => {
    await insertLocalAccount(adapter, { id: 'a1' });
    await mountHook();

    await act(async () => {
      await handlers.accounts(tombstone({ id: 'a1', user_id: 'u' }));
    });

    expect(adapter._sqlite.prepare('SELECT id FROM accounts').all()).toEqual(
      []
    );
  });

  it('routes the transactions channel to the transactions handler', async () => {
    await insertLocalTxn(adapter, { id: 't1' });
    await mountHook();

    await act(async () => {
      await handlers.transactions(
        tombstone({ id: 't1', user_id: 'u', account_id: 'a1' })
      );
    });

    expect(
      adapter._sqlite.prepare('SELECT id FROM transactions').all()
    ).toEqual([]);
  });

  it('subscribes to all three tables', async () => {
    await mountHook();
    expect(Object.keys(handlers).sort()).toEqual([
      'accounts',
      'transaction_splits',
      'transactions',
    ]);
  });
});

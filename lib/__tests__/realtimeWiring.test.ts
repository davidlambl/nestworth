// Which handler is attached to which channel is the one thing the realtime
// refactor cannot get wrong safely, and the one thing types cannot catch:
// applyAccountEvent, applyTransactionEvent and applyRuleEvent (#21) have
// identical signatures, so swapping two compiles, lints, and passes every
// other test while silently doing nothing at runtime. This asserts the wiring
// by driving each captured handler and checking which table actually moved.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
const mockInvalidate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { getDb } from '../db';
import { supabase } from '../supabase';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

type Handler = (payload: any) => void | Promise<void>;

let adapter: ReturnType<typeof makeAdapter>;
let handlers: Record<string, Handler>;
let configs: Record<string, any>;

beforeEach(() => {
  adapter = makeAdapter();
  handlers = {};
  configs = {};
  mockInvalidate.mockClear();
  (getDb as unknown as jest.Mock).mockImplementation(async () => adapter);

  const channel: any = {
    on: (_event: string, config: any, handler: Handler) => {
      handlers[config.table] = handler;
      configs[config.table] = config;
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

  // #76's finding 5, closed by #163: an archive made on another device
  // arrives as a plain UPDATE, not a tombstone, and a register open on the
  // account reads ['account', id] -- its banner and its "+" follow the
  // archive only if that key is refetched for every accounts event.
  it('refetches the account a register reads when another device archives it', async () => {
    await insertLocalAccount(adapter, {
      id: 'a1',
      updated_at: '2026-05-10T00:00:00Z',
    });
    await mountHook();

    await act(async () => {
      await handlers.accounts({
        eventType: 'UPDATE',
        new: {
          id: 'a1',
          user_id: 'u',
          name: 'Checking',
          type: 'checking',
          initial_balance: 0,
          sort_order: 0,
          is_archived: true,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-10-20T00:00:00Z',
        },
        old: {},
      });
    });

    expect({
      local: adapter._sqlite
        .prepare('SELECT is_archived FROM accounts WHERE id = ?')
        .get('a1'),
      refetched: mockInvalidate.mock.calls.map((c) => c[0].queryKey),
    }).toEqual({
      local: { is_archived: 1 },
      refetched: [['accounts'], ['account', 'a1']],
    });
  });

  // #21 added the fourth: recurring_rules, filtered on the user like the
  // accounts and transactions listeners (it was "all three tables").
  it('subscribes to all four tables', async () => {
    await mountHook();
    expect(Object.keys(handlers).sort()).toEqual([
      'accounts',
      'recurring_rules',
      'transaction_splits',
      'transactions',
    ]);
  });

  // The three tables with a user_id are filtered on it, so the server sends
  // each subscriber its own rows' events only; transaction_splits has none
  // (#21: splitEventParent decides what of it to act on).
  it('filters every table that has a user_id on the signed-in user (#21)', async () => {
    await mountHook();
    expect(
      Object.fromEntries(
        Object.entries(configs).map(([table, c]) => [
          table,
          `${c.event} ${c.schema} ${c.filter ?? '(none)'}`,
        ])
      )
    ).toEqual({
      accounts: '* public user_id=eq.u',
      transactions: '* public user_id=eq.u',
      transaction_splits: '* public (none)',
      recurring_rules: '* public user_id=eq.u',
    });
  });

  it('routes the recurring_rules channel to the rules handler (#21)', async () => {
    await insertLocalRule(adapter, { id: 'r1' });
    await mountHook();

    await act(async () => {
      await handlers.recurring_rules(
        tombstone({ id: 'r1', user_id: 'u', account_id: 'a1' })
      );
    });

    expect(
      adapter._sqlite.prepare('SELECT id FROM recurring_rules').all()
    ).toEqual([]);
  });
});

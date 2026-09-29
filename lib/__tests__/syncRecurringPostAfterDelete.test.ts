// A recurring post of a rule this device has deleted (#154), through the hooks
// the Recurring screen calls and the real push.
//
// The Recurring list keeps a deleted rule's card until the delete's refetch,
// and the post reads its rule from the list. Before #154 a Post of that card
// inserted a transaction from the rule and set the rule back to 'pending',
// advanced: the push uploaded the rule live and the transaction with it, and
// the delete was lost on every device.
//
// The hooks' requestPush is inert here, so each test runs the push itself;
// everything else in lib/sync.ts is the real engine, over the fixture's
// in-memory SQLite and fake Supabase.
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
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { pushChanges } from '../sync';
import { mapRecurringRule } from '../mappers';
import { RULE_DELETE_SQL } from '../recurringRuleDelete';
import { useDeleteAccount } from '../hooks/useAccounts';
import {
  useDeleteRecurringRule,
  usePostRecurringTransaction,
} from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalRule,
  remoteAccount,
  remoteRule,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';
import type { DbRecurringRule, RecurringRule } from '../types';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';

const TEMPLATE = {
  payee: 'Rent',
  amount: -1200,
  checkNumber: null,
  memo: null,
  splits: [{ amount: -1200, memo: 'rent' }],
};

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let hooks: {
  del: ReturnType<typeof useDeleteRecurringRule>;
  post: ReturnType<typeof usePostRecurringTransaction>;
  delAccount: ReturnType<typeof useDeleteAccount>;
};
let quiet: jest.SpyInstance[];

function Harness() {
  const del = useDeleteRecurringRule();
  const post = usePostRecurringTransaction();
  const delAccount = useDeleteAccount();
  useEffect(() => {
    hooks = { del, post, delAccount };
  });
  return null;
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  // a1 and its rule r1, due on 2026-09-01, synced: on the server and here.
  ctx.store.accounts = [
    remoteAccount({ id: 'a1', updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  ctx.store.recurring_rules = [
    remoteRule({
      id: 'r1',
      next_date: '2026-09-01',
      template: TEMPLATE,
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalRule(ctx.adapter, {
    id: 'r1',
    next_date: '2026-09-01',
    template: TEMPLATE,
    updated_at: SYNCED_AT,
  });

  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
});

afterEach(async () => {
  onlineManager.setOnline(true);
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
});

/** The rule as the Recurring list holds it. */
function listRule(): RecurringRule {
  return mapRecurringRule(
    ctx.adapter._sqlite
      .prepare("SELECT * FROM recurring_rules WHERE id = 'r1'")
      .get() as DbRecurringRule
  );
}

function rejection(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e) => String(e)
  );
}

/** What the server and this device hold once the push is done. */
function state() {
  return {
    server: {
      rules: (ctx.store.recurring_rules as any[]).map(
        (r) =>
          `${r.id}:${r.deleted_at != null ? 'tombstoned' : 'live'} next=${r.next_date}`
      ),
      transactions: (ctx.store.transactions as any[]).map((t) => t.id),
      splits: (ctx.store.transaction_splits as any[]).map((s) => s.id),
    },
    local: {
      rules: (
        ctx.adapter._sqlite
          .prepare('SELECT id, _sync_status FROM recurring_rules')
          .all() as any[]
      ).map((r) => `${r.id}:${r._sync_status}`),
      transactions: (
        ctx.adapter._sqlite
          .prepare('SELECT id FROM transactions')
          .all() as any[]
      ).map((t) => t.id),
    },
  };
}

const DELETED_EVERYWHERE = {
  server: {
    rules: ['r1:tombstoned next=2026-09-01'],
    transactions: [],
    splits: [],
  },
  local: { rules: [], transactions: [] },
};

/**
 * Records which of the two writes lands first once a Delete and a Post of r1
 * resume: the rule delete's single statement, or the post's rule advance.
 * The two hooks share a mutation scope (#154), so TanStack runs them one at a
 * time in the order they were made; without it, it continued them together
 * (query-core 5.96's resumePausedMutations) and the delete's statement landed
 * before the post's transaction whichever was tapped first. The tests read
 * the order rather than assume it, so they say what each order must leave.
 * r1 has no end date, so RULE_DELETE_SQL here is only ever the user's delete.
 */
function watchOrder(): string[] {
  const seen: string[] = [];
  const real = ctx.adapter.runAsync.bind(ctx.adapter);
  (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
    if (sql === RULE_DELETE_SQL) seen.push('delete');
    else if (/^\s*UPDATE recurring_rules SET next_date/.test(sql)) {
      seen.push('post');
    }
    return real(sql, params);
  };
  return seen;
}

/**
 * What the push must leave for that order. The rule is never brought back.
 * A post that lands after the delete is refused and writes nothing; one that
 * lands before it is the post the user made before deleting the rule, and
 * its transaction stays.
 */
function expectedFor(order: string[]) {
  if (order[0] === 'delete') {
    return {
      post: expect.stringMatching(/was deleted on this device/),
      ...DELETED_EVERYWHERE,
    };
  }
  return {
    post: null,
    server: {
      rules: ['r1:tombstoned next=2026-09-01'],
      transactions: ['id-1'],
      splits: ['id-2'],
    },
    local: { rules: [], transactions: ['id-1'] },
  };
}

describe('a recurring post of a rule this device has deleted (#154)', () => {
  // Before #154: the post resolved; the push upserted r1 live with next_date
  // 2026-10-01, and uploaded id-1 and its split: the delete lost, and a
  // transaction posted from a rule the user deleted.
  it('F3: Delete then Post, in turn: the post is refused, and the push tombstones the rule and uploads no transaction', async () => {
    const rule = listRule();
    let err: string | null = null;
    await act(async () => {
      await hooks.del.mutateAsync('r1');
      err = await rejection(hooks.post.mutateAsync(rule));
    });
    await pushChanges('u');

    expect({ err, ...state() }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      ...DELETED_EVERYWHERE,
    });
  });

  // The same two taps made offline: TanStack pauses both mutations and, on
  // reconnect, resumes them; the delete, tapped first, lands first
  // (watchOrder reads it). Before #154, as in F3: the post resolved, r1 live
  // on the server with next_date 2026-10-01.
  it('F4: Delete then Post offline, resumed together on reconnect: the delete stands', async () => {
    const rule = listRule();
    const order = watchOrder();
    onlineManager.setOnline(false);
    let delDone: Promise<string | null> | null = null;
    let postDone: Promise<string | null> | null = null;
    await act(async () => {
      delDone = rejection(hooks.del.mutateAsync('r1'));
      postDone = rejection(hooks.post.mutateAsync(rule));
    });
    const paused = qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state.isPaused);

    let outcomes: (string | null)[] = [];
    await act(async () => {
      onlineManager.setOnline(true);
      outcomes = await Promise.all([delDone!, postDone!]);
    });
    await pushChanges('u');

    expect({
      paused,
      deleted: outcomes[0],
      post: outcomes[1],
      ...state(),
    }).toEqual({ paused: [true, true], deleted: null, ...expectedFor(order) });
  });

  // The taps the other way round: Post, then Delete of the same rule, both
  // offline. With the shared scope they resume as tapped: the post lands,
  // and then the delete, the user's last word, stands. Without the scope the
  // delete's single statement landed first (measured under query-core
  // 5.96.2), and the post the user made before deleting was refused. Before
  // #154 the post then un-deleted r1: live on the server with next_date
  // 2026-10-01, the transaction uploaded, the delete lost.
  it('F6: Post then Delete offline, resumed together on reconnect: the rule stays deleted', async () => {
    const rule = listRule();
    const order = watchOrder();
    onlineManager.setOnline(false);
    let postDone: Promise<string | null> | null = null;
    let delDone: Promise<string | null> | null = null;
    await act(async () => {
      postDone = rejection(hooks.post.mutateAsync(rule));
      delDone = rejection(hooks.del.mutateAsync('r1'));
    });

    let outcomes: (string | null)[] = [];
    await act(async () => {
      onlineManager.setOnline(true);
      outcomes = await Promise.all([postDone!, delDone!]);
    });
    await pushChanges('u');

    expect({
      deleted: outcomes[1],
      post: outcomes[0],
      ...state(),
    }).toEqual({ deleted: null, ...expectedFor(order) });
    // With the shared scope the post runs first, as it was tapped.
    expect(order).toEqual(['post', 'delete']);
  });

  // The account's delete marks r1 too. Offline, Delete of a1 on the Accounts
  // tab and then Post of r1 on the Recurring screen resume together: the
  // post's account check reads a1 live before the account delete's
  // transaction starts, and its own transaction queues behind that one.
  // Before #154 it then posted id-1 into the deleted a1 and set r1 back to
  // 'pending': the push tombstoned a1 (its cascade stamped r1, so r1's upload
  // met a tombstone and was dropped), and this fake stored id-1 live under
  // the tombstoned a1. The real server refuses that insert with 23503 (005's
  // inherit_account_tombstone, which the fake does not model), and id-1 stays
  // pending here forever. Either way it was written here, which is what this
  // asserts against. In the other order the account delete marks the posted
  // transaction too, so the end state is the same.
  it('F5: Delete of the account then Post offline, resumed together: nothing is posted into the deleted account', async () => {
    const rule = listRule();
    onlineManager.setOnline(false);
    let delDone: Promise<string | null> | null = null;
    let postDone: Promise<string | null> | null = null;
    await act(async () => {
      delDone = rejection(hooks.delAccount.mutateAsync('a1'));
      postDone = rejection(hooks.post.mutateAsync(rule));
    });

    let outcomes: (string | null)[] = [];
    await act(async () => {
      onlineManager.setOnline(true);
      outcomes = await Promise.all([delDone!, postDone!]);
    });
    await pushChanges('u');

    expect({
      deleted: outcomes[0],
      post:
        outcomes[1] === null || /was deleted on this device/.test(outcomes[1]),
      accounts: (ctx.store.accounts as any[]).map(
        (a) => `${a.id}:${a.deleted_at != null ? 'tombstoned' : 'live'}`
      ),
      ...state(),
    }).toEqual({
      deleted: null,
      post: true,
      accounts: ['a1:tombstoned'],
      ...DELETED_EVERYWHERE,
    });
  });
});

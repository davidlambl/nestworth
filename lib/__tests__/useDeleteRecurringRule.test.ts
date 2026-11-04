// useDeleteRecurringRule refuses a delete of a rule this device no longer has
// (#138). Its UPDATE used to match nothing and the mutation still resolved,
// having requested a push with nothing in it: the rule had gone through a
// pulled tombstone (already deleted on the server) or the reset's wipe (whose
// re-download brings it back live), and the user was told neither. Now the
// mutation rejects with a readable message, which the mutation cache renders
// as "Save failed: …", and requests no push. The rules list refetches whether
// the delete went through or not, so a refused rule's card does not stay on
// screen: requestPush never refetches it.
//
// And a deleted rule stays off the list (#224). The list drops the card as
// soon as the delete settles, push or no push; what brought it back was the
// realtime echo of the rule's own earlier upload, arriving after the push had
// removed the rule here: written as a live rule it put the card back, until
// the tombstone's echo or the next pull took it away again.
//
// Own file, importing only the hooks and the fixture, so it loads on the code
// before each fix: that is where the regression tests were proven red (#138's
// before #147, #224's on 1.6.0). The hook's imports are stubbed as in
// applyAccountDelete.test.ts, whose harness this follows: react-test-renderer
// and createElement, a real QueryClient, getDb answering with the fixture's
// better-sqlite3 adapter, and the fixture's fake PostgREST behind the real
// engine. The hooks' requestPush is inert unless a test runs the real one
// through it; the realtime hook runs with its channel captured, as in
// realtimeHardening.test.ts.
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { fullSync, requestPush } from '../sync';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  useDeleteRecurringRule,
  useRecurringRules,
} from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalRule,
  remoteAccount,
  remoteRule,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When the seeded rule last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';

const REFUSAL =
  'This recurring rule no longer exists on this device. It may have been deleted elsewhere or by a reset.';

type Handler = (payload: any) => void | Promise<void>;

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let deleteRule: ReturnType<typeof useDeleteRecurringRule>;
let invalidate: jest.SpyInstance;
/** The realtime hook's listeners, by table. */
let handlers: Record<string, Handler>;

function Harness() {
  // The Recurring screen's list and delete, and the realtime hook the root
  // layout mounts.
  useRealtimeSync();
  useRecurringRules();
  const mutation = useDeleteRecurringRule();
  useEffect(() => {
    deleteRule = mutation;
  });
  return null;
}

/** r1 as the server holds it: uploaded, live. */
const serverRule = (over: Record<string, unknown> = {}) =>
  remoteRule({
    id: 'r1',
    updated_at: toPgTimestamp(SYNCED_AT),
    ...over,
  });

beforeEach(async () => {
  ctx = wireSyncMocks();
  // This device has pulled before (a full sync needs no first download).
  ctx.meta.set('last_pull_at:u', '2026-05-10T00:00:01.000Z');
  ctx.meta.set('last_pull_attempt_at:u', '2026-05-10T00:00:01.000Z');
  (requestPush as unknown as jest.Mock).mockReset();
  ctx.store.accounts = [
    remoteAccount({ id: 'a1', updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  ctx.store.recurring_rules = [serverRule()];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalRule(ctx.adapter, { id: 'r1', updated_at: SYNCED_AT });

  handlers = {};
  const channel: any = {
    on: (_event: string, config: any, handler: Handler) => {
      handlers[config.table] = handler;
      return channel;
    },
    subscribe: () => channel,
  };
  (supabase as any).channel = () => channel;
  (supabase as any).removeChannel = () => {};

  qc = new QueryClient({
    defaultOptions: {
      // lib/query.tsx's staleTime: an invalidation refetches a list on screen
      // however fresh it is.
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  invalidate = jest.spyOn(qc, 'invalidateQueries');
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
  ctx.adapter._sqlite.close();
});

/** `id:status@updated_at` for every rule, by id. */
function rules(): string[] {
  return (
    ctx.adapter._sqlite
      .prepare(
        'SELECT id, _sync_status, updated_at FROM recurring_rules ORDER BY id'
      )
      .all() as { id: string; _sync_status: string; updated_at: string }[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}`);
}

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  return 'resolved';
}

/** Deletes `id` through the hook. */
async function deleteThrough(id: string): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(deleteRule.mutateAsync(id));
  });
  return outcome;
}

describe('useDeleteRecurringRule (#138)', () => {
  it('refuses a delete of a rule this device no longer has, requests no push, and refetches the list', async () => {
    const outcome = await deleteThrough('r-gone');

    // Before #138: 'resolved', with a push requested for nothing.
    expect(outcome).toContain(REFUSAL);
    expect(requestPush).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['recurring_rules'] });
    expect(rules()).toEqual([`r1:synced@${SYNCED_AT}`]);
  });

  it('pin: marks a rule that is still here deleted, requests one push, and refetches the list once', async () => {
    expect(await deleteThrough('r1')).toBe('resolved');

    const [row] = rules();
    expect(row.startsWith('r1:deleted@')).toBe(true);
    expect(row.slice('r1:deleted@'.length) > SYNCED_AT).toBe(true);
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
    // Once: a delete that refetched on success AND on settle would do it twice.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['recurring_rules'] });
  });
});

describe('a deleted rule stays off the list (#224)', () => {
  /** The pushes the hook requested, run for real. */
  let pushes: Promise<void>[];
  /** Answers a test held back, given at the end even when the test failed. */
  let held: (() => void)[];
  let quiet: jest.SpyInstance[];

  beforeEach(() => {
    pushes = [];
    held = [];
    const real: typeof requestPush = jest.requireActual('../sync').requestPush;
    (requestPush as unknown as jest.Mock).mockImplementation((uid: string) => {
      const push = real(uid);
      pushes.push(push);
      return push;
    });
    quiet = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {})
    );
  });

  afterEach(async () => {
    // A push left waiting would hold the sync lock into the next test.
    held.forEach((release) => release());
    await settle();
    quiet.forEach((spy) => spy.mockRestore());
  });

  /** Lets every refetch finish; a push held open stays out. */
  async function flush() {
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (qc.isFetching() === 0 && qc.isMutating() === 0) return;
    }
  }

  /** Lets every requested push and every refetch finish. */
  async function settle() {
    await act(async () => {
      await Promise.all(pushes);
    });
    await flush();
  }

  /** The ids the list shows: the query the Recurring screen renders. */
  const listed = () =>
    (qc.getQueryData<{ id: string }[]>(['recurring_rules']) ?? []).map(
      (r) => r.id
    );

  const serverRules = () =>
    ctx.store.recurring_rules.map(
      (r: any) => `${r.id}:${r.deleted_at == null ? 'live' : 'tombstone'}`
    );

  /**
   * Holds the answer to the push's tombstone PATCH of a rule until the
   * returned function is called: the request's round trip.
   */
  function holdTombstones(): () => void {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'recurring_rules') {
        const update = builder.update;
        builder.update = (patch: any) => {
          const request = update(patch);
          const then = request.then;
          request.then = (resolve: any, reject: any) =>
            answered.then(() => then.call(request, resolve, reject));
          return request;
        };
      }
      return builder;
    };
    held.push(release);
    return release;
  }

  /** Delivers one realtime event to the rules listener. */
  async function ruleEvent(payload: any) {
    await act(async () => {
      await handlers.recurring_rules(payload);
    });
    await settle();
  }

  it('pin: the list drops the rule as soon as the delete settles, while its push is still out', async () => {
    await settle();
    expect(listed()).toEqual(['r1']);
    const answer = holdTombstones();

    expect(await deleteThrough('r1')).toBe('resolved');
    await flush();

    // The issue's candidate cause does not hold: the refetch on settle reads
    // the rule 'deleted', before the server has its tombstone.
    expect(listed()).toEqual([]);
    expect(rules()[0].startsWith('r1:deleted@')).toBe(true);
    expect(serverRules()).toEqual(['r1:live']);

    answer();
    await settle();
    expect(serverRules()).toEqual(['r1:tombstone']);
    expect(rules()).toEqual([]);
    expect(listed()).toEqual([]);
  });

  it('pin: and while another sync holds the lock, whose drain pushes the delete', async () => {
    await settle();
    let release!: () => void;
    const pulled = new Promise<void>((resolve) => {
      release = resolve;
    });
    held.push(release);
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'accounts') {
        const range = builder.range;
        builder.range = (a: number, b: number) =>
          pulled.then(() => range(a, b));
      }
      return builder;
    };
    let sync!: Promise<void>;
    await act(async () => {
      sync = fullSync('u');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await deleteThrough('r1')).toBe('resolved');
    await flush();

    // requestPush found the lock held, queued the push and returned.
    expect(listed()).toEqual([]);
    expect(serverRules()).toEqual(['r1:live']);

    release();
    await act(async () => {
      await sync;
    });
    await settle();
    expect(serverRules()).toEqual(['r1:tombstone']);
    expect(rules()).toEqual([]);
    expect(listed()).toEqual([]);
  });

  it('a late echo of the rule’s own upload, after its delete was pushed, leaves it off the list', async () => {
    expect(await deleteThrough('r1')).toBe('resolved');
    await settle();
    expect(serverRules()).toEqual(['r1:tombstone']);
    expect(rules()).toEqual([]);

    // The INSERT the upload made, delivered after the delete's push had
    // answered; the tombstone's own echo comes later, if at all.
    await ruleEvent({ eventType: 'INSERT', new: serverRule(), old: {} });

    // Before #224: ['r1'], and r1 back here 'synced', live.
    expect(listed()).toEqual([]);
    expect(rules()).toEqual([]);
  });

  it('and so does a late echo of an earlier change to it', async () => {
    expect(await deleteThrough('r1')).toBe('resolved');
    await settle();

    // An advance uploaded just before the delete (a Post), echoed late.
    await ruleEvent({
      eventType: 'UPDATE',
      new: serverRule({
        next_date: '2026-03-01',
        updated_at: '2026-05-10T00:00:00.500+00:00',
      }),
      old: { id: 'r1' },
    });

    // Before #224: ['r1'], at next_date 2026-03-01.
    expect(listed()).toEqual([]);
    expect(rules()).toEqual([]);
  });

  it('two rules deleted one after the other: late echoes of both uploads leave both off the list', async () => {
    // Two rules, one after the other: a registry that kept a single id (the
    // first, or the latest) would pass every test that deletes one rule.
    for (const id of ['r7', 'r8']) {
      ctx.store.recurring_rules.push(serverRule({ id }));
      await insertLocalRule(ctx.adapter, { id, updated_at: SYNCED_AT });
    }
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['recurring_rules'] });
    });
    await flush();
    expect(listed()).toEqual(['r1', 'r7', 'r8']);

    expect(await deleteThrough('r7')).toBe('resolved');
    await settle();
    expect(await deleteThrough('r8')).toBe('resolved');
    await settle();
    expect(serverRules()).toEqual(['r1:live', 'r7:tombstone', 'r8:tombstone']);

    await ruleEvent({
      eventType: 'INSERT',
      new: serverRule({ id: 'r7' }),
      old: {},
    });
    await ruleEvent({
      eventType: 'INSERT',
      new: serverRule({ id: 'r8' }),
      old: {},
    });

    // Before #224: both back 'synced'; r7 listed at once, r8 a second later.
    expect(listed()).toEqual(['r1']);
    expect(rules()).toEqual([`r1:synced@${SYNCED_AT}`]);
  });

  it('pin: a rule created on another device still arrives through realtime', async () => {
    expect(await deleteThrough('r1')).toBe('resolved');
    await settle();

    ctx.store.recurring_rules.push(remoteRule({ id: 'r2' }));
    await ruleEvent({
      eventType: 'INSERT',
      new: remoteRule({ id: 'r2' }),
      old: {},
    });

    expect(listed()).toEqual(['r2']);
    expect(rules()).toEqual(['r2:synced@2026-01-01T00:00:00Z']);
  });

  it('pin: a refused delete (#138) remembers nothing, so a later live event of that rule is written', async () => {
    expect(await deleteThrough('r-gone')).toContain(REFUSAL);
    await settle();

    // The reset's re-download brought it back, and another device edits it.
    await ruleEvent({
      eventType: 'UPDATE',
      new: remoteRule({ id: 'r-gone', next_date: '2026-04-01' }),
      old: { id: 'r-gone' },
    });

    expect(listed()).toEqual(['r1', 'r-gone']);
    expect(rules()).toContain('r-gone:synced@2026-01-01T00:00:00Z');
  });
});

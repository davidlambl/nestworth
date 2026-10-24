// Realtime hardening (#21), through the hook the app mounts
// (lib/hooks/useRealtimeSync.ts): the channel's handlers are captured from a
// fake channel and driven with the payloads Supabase delivers, against the
// fixture's real SQLite adapter and fake PostgREST (wireSyncMocks).
//
// What Supabase delivers, read from production's realtime.apply_rls and the
// Postgres Changes guide on 2026-10-23: an INSERT or UPDATE reaches a
// subscriber only when RLS lets it read the row (a split through its parent's
// policy), with the whole row; a DELETE skips RLS, and with RLS on its `old`
// carries the primary key alone, so the unfiltered split listener hears every
// user's split deletes, as `{ id }`. A DELETE never reaches a listener
// filtered on user_id while the table keeps the default replica identity.
//
// Own file, importing the hook and the fixture only: every test loads on
// 112b060, and all but H5 and H9 are red there (those two are pins: see
// there).
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
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { supabase } from '../supabase';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteRule,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

type Handler = (payload: any) => void | Promise<void>;

// lib/realtimeBatch.ts's REALTIME_WINDOW_MS, as a literal so that this file
// loads on 112b060, which has no such module.
const WINDOW_MS = 1000;

let f: ReturnType<typeof wireSyncMocks>;
let handlers: Record<string, Handler>;
let renderer: ReactTestRenderer | null;

beforeEach(() => {
  jest.useFakeTimers();
  f = wireSyncMocks();
  // This device has pulled before: a split refresh waits for its first
  // download otherwise (S19).
  f.meta.set('last_pull_at:u', '2026-10-20T00:00:00.000Z');
  handlers = {};
  renderer = null;
  mockInvalidate.mockClear();
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

afterEach(async () => {
  if (renderer) {
    const r = renderer;
    await act(async () => {
      r.unmount();
    });
  }
  jest.useRealTimers();
  f.adapter._sqlite.close();
});

async function mountHook() {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(() => (useRealtimeSync(), null))
    );
  });
}

/** Runs every timer due within `ms`, letting the promises they start settle. */
async function elapse(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

const keys = () => mockInvalidate.mock.calls.map((c) => c[0].queryKey);

const splitRows = () =>
  f.adapter._sqlite
    .prepare(
      'SELECT id, transaction_id, amount, _sync_status FROM transaction_splits ORDER BY id'
    )
    .all();

const SERVER_AT = '2026-10-20T10:00:00.000000+00:00';

/** What a split row looks like on the server (and in an event's `new`). */
const serverSplit = (s: any) => ({
  id: s.id,
  transaction_id: s.transaction_id,
  category_id: null,
  amount: s.amount ?? 0,
  memo: s.memo ?? null,
  updated_at: s.updated_at ?? SERVER_AT,
});

describe('useRealtimeSync hardening (#21)', () => {
  // The issue's second bullet. Another device re-split t1: the server replaced
  // its set wholesale (s1 deleted, s2 and s3 inserted), and realtime delivered
  // the three events. On 112b060 the split listener only invalidated
  // ['transactions']: the register refetched from SQLite, which still held s1.
  it('H1: a split set another device replaced lands here', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      amount: -10,
      updated_at: SERVER_AT,
    });
    f.store.transactions.push(remoteTxn({ id: 't1', updated_at: SERVER_AT }));
    const s2 = serverSplit({ id: 's2', transaction_id: 't1', amount: -4 });
    const s3 = serverSplit({ id: 's3', transaction_id: 't1', amount: -6 });
    f.store.transaction_splits.push(s2, s3);
    await mountHook();

    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'DELETE',
        new: {},
        old: { id: 's1' },
      });
      await handlers.transaction_splits({
        eventType: 'INSERT',
        new: s2,
        old: {},
      });
      await handlers.transaction_splits({
        eventType: 'INSERT',
        new: s3,
        old: {},
      });
    });
    await elapse(1000);

    expect(splitRows()).toEqual([
      { id: 's2', transaction_id: 't1', amount: -4, _sync_status: 'synced' },
      { id: 's3', transaction_id: 't1', amount: -6, _sync_status: 'synced' },
    ]);
  });

  // The issue's third bullet: no recurring_rules channel, so a rule another
  // device edited (or advanced by posting) waited for the next pull.
  it('H2: a rule another device advanced lands here and refreshes the list', async () => {
    await insertLocalRule(f.adapter, {
      id: 'r1',
      next_date: '2026-11-01',
      updated_at: '2026-10-01T00:00:00+00:00',
    });
    await mountHook();

    await act(async () => {
      await handlers.recurring_rules({
        eventType: 'UPDATE',
        new: remoteRule({
          id: 'r1',
          next_date: '2026-12-01',
          updated_at: '2026-10-20T00:00:00+00:00',
        }),
        old: { id: 'r1' },
      });
    });
    await elapse(1000);

    expect({
      local: f.adapter._sqlite
        .prepare('SELECT next_date, _sync_status FROM recurring_rules')
        .all(),
      refetched: keys(),
    }).toEqual({
      local: [{ next_date: '2026-12-01', _sync_status: 'synced' }],
      refetched: [['recurring_rules']],
    });
  });

  // The issue's fourth bullet. Another device imported 200 transactions into
  // a1: 200 INSERT events, each of which invalidated ['accounts'] (the
  // balance aggregate every Accounts screen reads) on 112b060 -- 200 refetches
  // of the same list, each cancelling the one before.
  it('H3: a burst of 200 transaction events refreshes each list at most twice', async () => {
    await mountHook();

    await act(async () => {
      const events = [];
      for (let i = 0; i < 200; i++) {
        const id = `t${String(i).padStart(3, '0')}`;
        events.push(
          handlers.transactions({
            eventType: 'INSERT',
            new: remoteTxn({ id, updated_at: SERVER_AT }),
            old: {},
          })
        );
      }
      await Promise.all(events);
    });
    await elapse(1000);

    const count = (k: unknown[]) =>
      keys().filter((q) => JSON.stringify(q) === JSON.stringify(k)).length;
    expect({
      rows: (
        f.adapter._sqlite
          .prepare('SELECT COUNT(*) AS c FROM transactions')
          .get() as any
      ).c,
      accounts: count(['accounts']),
      all: count(['transactions', '__all__']),
      register: count(['transactions', 'a1']),
    }).toEqual({ rows: 200, accounts: 2, all: 2, register: 2 });
  });

  // The same import as this app's push delivers it: pushChanges uploads one
  // transaction per request, so the 200 events come one round trip of the
  // pushing device apart (150 ms: a phone), not in one act as in H3. On
  // 112b060 each list was refetched 200 times; a 250 ms window, shorter
  // than that round trip, still refetched each one 121 times.
  it('H3c: an import pushed one row per request refreshes each list about once a second, not once per row', async () => {
    await mountHook();

    for (let i = 0; i < 200; i++) {
      const id = `t${String(i).padStart(3, '0')}`;
      await act(async () => {
        await handlers.transactions({
          eventType: 'INSERT',
          new: remoteTxn({ id, updated_at: SERVER_AT }),
          old: {},
        });
      });
      await elapse(150);
    }
    await elapse(3000);

    const count = (k: unknown[]) =>
      keys().filter((q) => JSON.stringify(q) === JSON.stringify(k)).length;
    expect({
      accounts: count(['accounts']),
      all: count(['transactions', '__all__']),
      register: count(['transactions', 'a1']),
    }).toEqual({ accounts: 31, all: 31, register: 31 });
  });

  // The issue's storm with splits: another device imported 200
  // transactions, each with a split (a legacy template's post, say): 200
  // INSERT events on transactions, then 200 on transaction_splits. On
  // 112b060 that was 1000 invalidations: four per transaction event, and
  // ['transactions'] -- every register and the all-accounts list -- once per
  // split event. Measured here: the calls per key, and in all.
  it('H3b: a burst of 200 transactions with their splits refreshes each list a few times, not hundreds', async () => {
    await mountHook();

    await act(async () => {
      const events = [];
      for (let i = 0; i < 200; i++) {
        const id = `t${String(i).padStart(3, '0')}`;
        f.store.transaction_splits.push(
          serverSplit({ id: `s${id}`, transaction_id: id })
        );
        events.push(
          handlers.transactions({
            eventType: 'INSERT',
            new: remoteTxn({ id, updated_at: SERVER_AT }),
            old: {},
          })
        );
      }
      await Promise.all(events);
      const splitEvents = [];
      for (let i = 0; i < 200; i++) {
        const id = `t${String(i).padStart(3, '0')}`;
        splitEvents.push(
          handlers.transaction_splits({
            eventType: 'INSERT',
            new: serverSplit({ id: `s${id}`, transaction_id: id }),
            old: {},
          })
        );
      }
      await Promise.all(splitEvents);
    });
    await elapse(2000);

    const count = (k: unknown[]) =>
      keys().filter((q) => JSON.stringify(q) === JSON.stringify(k)).length;
    expect({
      splits: (
        f.adapter._sqlite
          .prepare('SELECT COUNT(*) AS c FROM transaction_splits')
          .get() as any
      ).c,
      accounts: count(['accounts']),
      everyRegister: count(['transactions']),
      all: count(['transactions', '__all__']),
      register: count(['transactions', 'a1']),
      total: keys().length,
    }).toEqual({
      splits: 200,
      accounts: 2,
      everyRegister: 0,
      all: 3,
      register: 3,
      total: 408,
    });
  });

  // RLS is not applied to a DELETE, so the unfiltered split listener hears
  // every user's split deletes as `{ id }`. On 112b060 each one invalidated
  // ['transactions']. Now an id that ties to no split of this user's is
  // dropped: nothing written, nothing refetched.
  it("H4: another user's split DELETE writes nothing and refreshes nothing", async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      updated_at: SERVER_AT,
    });
    // A split of another account's, held on this device from its session
    // (sign-out wipes no local rows), and one never held here at all.
    await insertLocalTxn(f.adapter, {
      id: 'tx',
      user_id: 'other',
      updated_at: SERVER_AT,
    });
    await insertLocalSplit(f.adapter, {
      id: 'sx',
      transaction_id: 'tx',
      updated_at: SERVER_AT,
    });
    await mountHook();

    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'DELETE',
        new: {},
        old: { id: 'sx' },
      });
      await handlers.transaction_splits({
        eventType: 'DELETE',
        new: {},
        old: { id: 'never-here' },
      });
    });
    await elapse(1000);

    expect({
      splits: splitRows().map((s: any) => s.id),
      refetched: keys(),
    }).toEqual({
      splits: ['s1', 'sx'],
      refetched: [],
    });
  });

  // PIN (green on 112b060, which holds nothing back): an event's refresh
  // held in the window when the account changes is dropped with the
  // subscription, never run against the next account's cache (#177's class).
  // Red under the mutant whose cleanup leaves the window's timer running.
  it('H5: nothing is refreshed after the subscription is torn down', async () => {
    await mountHook();
    await act(async () => {
      await handlers.transactions({
        eventType: 'INSERT',
        new: remoteTxn({ id: 't1', updated_at: SERVER_AT }),
        old: {},
      });
      await handlers.transactions({
        eventType: 'INSERT',
        new: remoteTxn({ id: 't2', account_id: 'a2', updated_at: SERVER_AT }),
        old: {},
      });
    });
    const before = mockInvalidate.mock.calls.length;
    const r = renderer!;
    renderer = null;
    await act(async () => {
      r.unmount();
    });
    await elapse(1000);

    expect(mockInvalidate.mock.calls.length).toBe(before);
  });

  // The own echo. This device pushed t1's re-split: the server's set is now
  // this device's own (same ids, the stamps the read-back adopted), and its
  // INSERT events come back. Nothing may be rewritten or refetched: on
  // 112b060 each event invalidated ['transactions'].
  it("H6: the echo of this device's own split push rewrites and refreshes nothing", async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    const mine = [
      { id: 's2', transaction_id: 't1', amount: -4, updated_at: SERVER_AT },
      { id: 's3', transaction_id: 't1', amount: -6, updated_at: SERVER_AT },
    ];
    for (const s of mine) await insertLocalSplit(f.adapter, s);
    f.store.transactions.push(remoteTxn({ id: 't1', updated_at: SERVER_AT }));
    f.store.transaction_splits.push(...mine.map(serverSplit));
    const statements: string[] = [];
    const run = f.adapter.runAsync;
    f.adapter.runAsync = async (sql: string, params?: any[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      return run(sql, params);
    };
    await mountHook();

    await act(async () => {
      for (const s of mine) {
        await handlers.transaction_splits({
          eventType: 'INSERT',
          new: serverSplit(s),
          old: {},
        });
      }
    });
    await elapse(1000);

    expect({
      splits: splitRows().map((s: any) => s.id),
      writes: statements,
      refetched: keys(),
    }).toEqual({ splits: ['s2', 's3'], writes: [], refetched: [] });
  });
  // What the refresh refetches once it has rewritten a set: the parent's
  // register, the all-accounts list and the parent itself -- the keys the
  // transactions listener uses for the parent's own event. One read for the
  // burst's three events, made once the window closes.
  it('H7: a rewritten set refetches its parent once, after one read for the burst', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      updated_at: SERVER_AT,
    });
    f.store.transaction_splits.push(
      serverSplit({ id: 's2', transaction_id: 't1', amount: -4 }),
      serverSplit({ id: 's3', transaction_id: 't1', amount: -6 })
    );
    let reads = 0;
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = (a: number, b: number) => {
          reads++;
          return range(a, b);
        };
      }
      return builder;
    };
    await mountHook();

    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'DELETE',
        new: {},
        old: { id: 's1' },
      });
      for (const id of ['s2', 's3']) {
        await handlers.transaction_splits({
          eventType: 'INSERT',
          new: serverSplit({ id, transaction_id: 't1' }),
          old: {},
        });
      }
    });
    const beforeWindow = { reads, refetched: keys() };
    await elapse(1000);

    expect({ beforeWindow, reads, refetched: keys() }).toEqual({
      beforeWindow: { reads: 0, refetched: [] },
      // One page with the two splits, then the empty page ending the read.
      reads: 2,
      refetched: [
        ['transactions', 'a1'],
        ['transactions', '__all__'],
        ['transaction', 't1'],
      ],
    });
  });

  // A refresh whose read is out when the subscription goes (a sign-out, a
  // change of account) refetches nothing when it comes back.
  it('H8: a split refresh still reading at teardown refetches nothing afterwards', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    f.store.transaction_splits.push(
      serverSplit({ id: 's2', transaction_id: 't1' })
    );
    let answer: () => void = () => {};
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = async (a: number, b: number) => {
          const page = await range(a, b);
          await new Promise<void>((resolve) => (answer = resolve));
          return page;
        };
      }
      return builder;
    };
    await mountHook();
    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'INSERT',
        new: serverSplit({ id: 's2', transaction_id: 't1' }),
        old: {},
      });
    });
    await elapse(WINDOW_MS);
    const r = renderer!;
    renderer = null;
    await act(async () => {
      r.unmount();
    });
    for (let i = 0; i < 3; i++) {
      answer();
      await elapse(WINDOW_MS);
    }

    expect(keys()).toEqual([]);
  });
  // A split event whose read has not started when the subscription goes
  // starts none afterwards.
  it('H9: a split refresh still waiting for its window at teardown never reads', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    let reads = 0;
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      if (table === 'transaction_splits') {
        const range = builder.range;
        builder.range = (a: number, b: number) => {
          reads++;
          return range(a, b);
        };
      }
      return builder;
    };
    await mountHook();
    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'INSERT',
        new: serverSplit({ id: 's2', transaction_id: 't1' }),
        old: {},
      });
    });
    const r = renderer!;
    renderer = null;
    await act(async () => {
      r.unmount();
    });
    await elapse(1000);

    expect(reads).toBe(0);
  });

  // Splits removed on another device, none left: only DELETE events arrive,
  // each carrying the split's id alone, and they alone start the read that
  // empties the set here (in H1 the INSERTs would start it anyway). Found by
  // the review of #21. On 112b060 the listener refetched every register from
  // a SQLite still holding s1.
  it('H10: splits removed on another device go here too, from their DELETE events alone', async () => {
    await insertLocalTxn(f.adapter, { id: 't1', updated_at: SERVER_AT });
    await insertLocalSplit(f.adapter, {
      id: 's1',
      transaction_id: 't1',
      amount: -10,
      updated_at: SERVER_AT,
    });
    f.store.transactions.push(remoteTxn({ id: 't1', updated_at: SERVER_AT }));
    await mountHook();

    await act(async () => {
      await handlers.transaction_splits({
        eventType: 'DELETE',
        new: {},
        old: { id: 's1' },
      });
    });
    await elapse(WINDOW_MS);

    expect({ splits: splitRows(), refetched: keys() }).toEqual({
      splits: [],
      refetched: [
        ['transactions', 'a1'],
        ['transactions', '__all__'],
        ['transaction', 't1'],
      ],
    });
  });
});

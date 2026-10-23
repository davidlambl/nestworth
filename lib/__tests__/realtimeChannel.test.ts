// The realtime channel's own life (#21), through the hook the app mounts
// (lib/hooks/useRealtimeSync.ts) and a fake channel that records its topic
// and the status callback subscribe() is given. What the fake cannot show --
// realtime-js reusing a channel by topic, the socket routing by topic, a
// binding with no server id matching every change -- C5 drives through the
// installed realtime-js client itself, behind a fake WebSocket.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
let mockUserId = 'u';
jest.mock('../auth', () => ({
  // An empty id is a sign-out: no user at all.
  useAuth: () => ({ user: mockUserId ? { id: mockUserId } : null }),
}));
const mockInvalidate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { RealtimeClient } from '@supabase/realtime-js';
import { supabase } from '../supabase';
import * as sync from '../sync';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { remoteRule, remoteTxn, wireSyncMocks } from '../testing/syncFixture';

let f: ReturnType<typeof wireSyncMocks>;
let topics: string[];
let statusCallbacks: ((status: string, err?: Error) => void)[];
let renderer: ReactTestRenderer | null;
const Comp = () => (useRealtimeSync(), null);

beforeEach(() => {
  f = wireSyncMocks();
  f.meta.set('last_pull_at:u', '2026-10-20T00:00:00.000Z');
  mockUserId = 'u';
  mockInvalidate.mockClear();
  topics = [];
  statusCallbacks = [];
  renderer = null;
  (supabase as any).channel = (topic: string) => {
    topics.push(topic);
    const channel: any = {
      on: () => channel,
      subscribe: (cb: any) => {
        statusCallbacks.push(cb);
        channel.status = cb;
        return channel;
      },
    };
    return channel;
  };
  // As realtime-js does: removing a channel reports CLOSED to its callback.
  (supabase as any).removeChannel = (channel: any) =>
    channel.status?.('CLOSED');
});

afterEach(async () => {
  if (renderer) {
    const r = renderer;
    await act(async () => r.unmount());
  }
  jest.restoreAllMocks();
  f.adapter._sqlite.close();
});

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(Comp));
  });
}

describe('useRealtimeSync channel life (#21)', () => {
  it('C1: a sign-in straight over another account subscribes under a topic of its own', async () => {
    await mount();
    mockUserId = 'v';
    await act(async () => {
      renderer!.update(createElement(Comp));
    });
    expect({ count: topics.length, distinct: new Set(topics).size }).toEqual({
      count: 2,
      distinct: 2,
    });
  });

  it('C2: a channel that comes back after an error or a timeout runs one sync, then refreshes every list', async () => {
    const full = jest.spyOn(sync, 'fullSync').mockResolvedValue();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    const status = statusCallbacks[0];

    await act(async () => {
      status('SUBSCRIBED');
    });
    const afterFirstJoin = full.mock.calls.length;
    await act(async () => {
      status('CHANNEL_ERROR');
      status('TIMED_OUT');
      status('SUBSCRIBED');
    });
    // A rejoin that timed out before it was answered is a gap too.
    await act(async () => {
      status('TIMED_OUT');
      status('SUBSCRIBED');
    });

    expect({
      afterFirstJoin,
      synced: full.mock.calls,
      refreshedAll: mockInvalidate.mock.calls.filter((c) => c.length === 0)
        .length,
      warned: warn.mock.calls.map((c) => String(c[0])),
    }).toEqual({
      afterFirstJoin: 0,
      synced: [['u'], ['u']],
      refreshedAll: 2,
      warned: [
        '[realtime] channel CHANNEL_ERROR; changes made elsewhere meanwhile come with the next sync',
        '[realtime] channel TIMED_OUT; changes made elsewhere meanwhile come with the next sync',
      ],
    });
  });

  it('C3: no sync before this device has downloaded once, and none once the subscription is torn down', async () => {
    const full = jest.spyOn(sync, 'fullSync').mockResolvedValue();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    f.meta.delete('last_pull_at:u');
    await mount();
    const status = statusCallbacks[0];
    await act(async () => {
      status('CHANNEL_ERROR');
      status('SUBSCRIBED');
    });
    const beforeFirstPull = full.mock.calls.length;

    f.meta.set('last_pull_at:u', '2026-10-20T00:00:00.000Z');
    const r = renderer!;
    await act(async () => r.unmount());
    renderer = null;
    await act(async () => {
      status('CHANNEL_ERROR');
      status('SUBSCRIBED');
    });

    expect({ beforeFirstPull, after: full.mock.calls.length }).toEqual({
      beforeFirstPull: 0,
      after: 0,
    });
  });

  it('C4: our own removal is not logged, and a channel the server closes is', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Removed by the hook's cleanup: the fake reports CLOSED as realtime-js
    // does, after the cleanup has marked the subscription stopped.
    await mount();
    const r = renderer!;
    await act(async () => r.unmount());
    renderer = null;
    const afterRemoval = warn.mock.calls.length;
    // A new subscription whose channel the server closes.
    await mount();
    await act(async () => {
      statusCallbacks[1]('CLOSED');
    });
    expect({
      afterRemoval,
      warned: warn.mock.calls.map((c) => String(c[0])),
    }).toEqual({
      afterRemoval: 0,
      warned: [
        '[realtime] channel CLOSED; changes made elsewhere meanwhile come with the next sync',
      ],
    });
  });

  // The rejoin's sync reads the first-download marker before it starts. A
  // sign-out landing there tore the subscription down, and the sync still ran
  // for the user who had gone: a push and a pull with no session, whose
  // refusal became the sync error, holding the lock the next sign-in's
  // startup sync wants. Found by the review of #21's rejoin sync.
  it('C6: a subscription torn down while its rejoin sync reads the first-download marker starts no sync', async () => {
    const full = jest.spyOn(sync, 'fullSync').mockResolvedValue();
    let marker: (needed: boolean) => void = () => {};
    jest
      .spyOn(sync, 'needsInitialPull')
      .mockReturnValue(new Promise<boolean>((r) => (marker = r)));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    const status = statusCallbacks[0];
    await act(async () => {
      status('CHANNEL_ERROR');
      status('SUBSCRIBED');
    });
    mockUserId = '';
    await act(async () => {
      renderer!.update(createElement(Comp));
    });
    await act(async () => {
      marker(false);
    });

    expect({
      synced: full.mock.calls,
      refreshedAll: mockInvalidate.mock.calls.filter((c) => c.length === 0)
        .length,
    }).toEqual({ synced: [], refreshedAll: 0 });
  });

  // PIN (green before C6's fix too): a rejoin sync already out when the
  // subscription goes cannot be called back; it runs to its end and refreshes
  // no list then -- the lists are the next account's by that time (#177).
  it('C7: a rejoin sync still running at teardown refreshes no list when it ends', async () => {
    let done: () => void = () => {};
    const full = jest
      .spyOn(sync, 'fullSync')
      .mockReturnValue(new Promise<void>((r) => (done = r)));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    const status = statusCallbacks[0];
    await act(async () => {
      status('CHANNEL_ERROR');
      status('SUBSCRIBED');
    });
    const startedBeforeTeardown = full.mock.calls.length;
    mockUserId = '';
    await act(async () => {
      renderer!.update(createElement(Comp));
    });
    await act(async () => {
      done();
    });

    expect({
      startedBeforeTeardown,
      synced: full.mock.calls,
      refreshedAll: mockInvalidate.mock.calls.filter((c) => c.length === 0)
        .length,
    }).toEqual({ startedBeforeTeardown: 1, synced: [['u']], refreshedAll: 0 });
  });
});

/**
 * A WebSocket the installed realtime-js client is handed as its transport:
 * it records what the client sends, and the test plays the server.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  binaryType: any;
  timeout: any;
  onopen: any;
  onmessage: any;
  onclose: any;
  onerror: any;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, wasClean: true });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverPush(msg: any) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('useRealtimeSync over the real realtime-js client (#21)', () => {
  const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  const joins = () => sock().sent.filter((m) => m.event === 'phx_join');

  /** The server's answer to a join: a server id for each of its bindings. */
  function answerJoin(join: any, firstId: number) {
    const bindings = join.payload.config.postgres_changes.map(
      (b: any, i: number) => ({ ...b, id: firstId + i })
    );
    sock().serverPush({
      topic: join.topic,
      event: 'phx_reply',
      payload: { status: 'ok', response: { postgres_changes: bindings } },
      ref: join.ref,
      join_ref: join.ref,
    });
    return (table: string) => bindings.find((b: any) => b.table === table)?.id;
  }

  function change(topic: string, id: number, table: string, record: any) {
    return {
      topic,
      event: 'postgres_changes',
      payload: {
        ids: [id],
        data: {
          schema: 'public',
          table,
          commit_timestamp: '2026-10-23T05:00:00.000Z',
          type: 'UPDATE',
          columns: Object.keys(record).map((name) => ({ name, type: 'text' })),
          record,
          old_record: { id: record.id },
          errors: null,
        },
      },
      ref: null,
    };
  }

  const rows = (sql: string) => f.adapter._sqlite.prepare(sql).all();

  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    mockUserId = 'A';
    f.meta.set('last_pull_at:A', '2026-10-20T00:00:00.000Z');
    f.meta.set('last_pull_at:B', '2026-10-20T00:00:00.000Z');
    const client = new RealtimeClient('wss://example.supabase.co/realtime/v1', {
      params: { apikey: 'test-key' },
      transport: FakeSocket as any,
      vsn: '1.0.0',
      heartbeatIntervalMs: 1e9,
    } as any);
    (supabase as any).channel = (topic: string) => client.channel(topic);
    (supabase as any).removeChannel = (channel: any) =>
      client.removeChannel(channel);
  });

  afterEach(async () => {
    // Unmounted under the fake timers the client's own timers were set with.
    if (renderer) {
      const r = renderer;
      await act(async () => r.unmount());
      renderer = null;
    }
    jest.useRealTimers();
  });

  // Measured while designing #21, and kept. React runs the cleanup for A and
  // the effect for B in one commit; the server sends A's changes until it
  // handles A's leave. Under one fixed topic, B's channel took A's topic, and
  // its bindings, unanswered yet, matched every change: A's rule was written as
  // a transaction and A's transaction as a rule, both 'synced' (on 112b060,
  // with three listeners, A's transaction was written under B's subscription).
  // B's own change, once its join is answered, still lands.
  it('C5: a sign-in straight over another account writes none of its in-flight changes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    sock().open();
    const joinA = joins()[0];
    const idOfA = answerJoin(joinA, 1);

    mockUserId = 'B';
    await act(async () => {
      renderer!.update(createElement(Comp));
    });
    await act(async () => {
      sock().serverPush(
        change(
          joinA.topic,
          idOfA('transactions'),
          'transactions',
          remoteTxn({ id: 't9', user_id: 'A', account_id: 'aA' })
        )
      );
      // The server sends a change only for a table the join named, and a
      // join names the rules table only since #21.
      if (idOfA('recurring_rules') !== undefined) {
        sock().serverPush(
          change(
            joinA.topic,
            idOfA('recurring_rules'),
            'recurring_rules',
            remoteRule({ id: 'r9', user_id: 'A', account_id: 'aA' })
          )
        );
      }
      await jest.advanceTimersByTimeAsync(600);
    });
    const fromA = {
      transactions: rows('SELECT id FROM transactions'),
      rules: rows('SELECT id FROM recurring_rules'),
      accounts: rows('SELECT id FROM accounts'),
      warned: warn.mock.calls.map((c) => String(c[0])),
    };

    const joinB = joins()[1];
    const idOfB = answerJoin(joinB, 11);
    await act(async () => {
      sock().serverPush(
        change(
          joinB.topic,
          idOfB('transactions'),
          'transactions',
          remoteTxn({ id: 't10', user_id: 'B', account_id: 'aB' })
        )
      );
      await jest.advanceTimersByTimeAsync(600);
    });

    expect({
      topicsDiffer: joinA.topic !== joinB.topic,
      fromA,
      afterB: rows('SELECT id, user_id FROM transactions'),
    }).toEqual({
      topicsDiffer: true,
      fromA: { transactions: [], rules: [], accounts: [], warned: [] },
      afterB: [{ id: 't10', user_id: 'B' }],
    });
  });
});

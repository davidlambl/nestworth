// The edit screen's gone line through a refetch (#195). useTransaction throws
// for a not-found, so its query holds no data, and TanStack Query puts a query
// without data back to pending, its error cleared, each time it fetches again:
// after the startup sequence and every sync (each ends by invalidating every
// query, lib/query.tsx), on a reconnect, and on web on each return to the
// window. Read from the error alone, the screen's line went away for each
// refetch and came back with the answer: a new addition to FormError's live
// region, read out again on web, and on iOS a new VoiceOver move to it.
// useTransactionGone keeps the last answer a read settled on while a refetch
// is in flight. The screen itself has no component test (the repo has none):
// what it shows is verified in a browser and under the iOS preset; these tests
// pin the signal it is built on.
//
// Own file, importing the hooks and the fixture (useAccountGone.test.ts's
// harness). useTransactionGone is new in #195, so the red proofs are its
// mutants: R1 and R2 fail with `return notFound` (the screen's reading
// before) and with the answer replaced while a read is in flight, R2 also
// with the answer kept only while `fetchStatus` is 'fetching' (not paused).
// P1-P3 are pins, green with the reading before too: P1 fails if the answer
// outlives another error, P3 if it is kept for another id.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { getDb } from '../db';
import { useTransaction, useTransactionGone } from '../hooks/useTransactions';
import { insertLocalTxn, makeAdapter } from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';

/** What the screen was given at one commit. */
type Shown = { id: string; gone: boolean; fetchStatus: string; row: boolean };

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer | undefined;
let shown: Shown[];
/** The transaction reads made, by id. */
let reads: string[];
/** How many of the next transaction reads fail with another error. */
let failures: number;
/** While set, a transaction read waits in `held` for the test to answer it. */
let holding: boolean;
let held: (() => void)[];

/** The edit screen's read of its transaction, and its gone line's signal. */
function Harness({ id }: { id: string }) {
  const query = useTransaction(id);
  const gone = useTransactionGone(id, query);
  useEffect(() => {
    shown.push({
      id,
      gone,
      fetchStatus: query.fetchStatus,
      row: query.data !== undefined,
    });
  });
  return null;
}

/** The values in order, each repeat of the one before dropped. */
function changes(values: boolean[]): boolean[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

/**
 * Lets every read in flight settle and its result reach the harness
 * (useAccountGone.test.ts): TanStack hands a result to its observers on a
 * setTimeout(0), so the loop stops only after a whole turn with nothing
 * fetching. A paused read is not fetching.
 */
async function settle() {
  for (let i = 0, idle = 0; i < 50 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

async function open(id: string) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Harness, { id })
      )
    );
  });
  await settle();
}

/** Turns of the event loop, for TanStack to hand a new state to the harness. */
async function turns(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/**
 * Runs `start` with the transaction reads it starts held, lets the screen be
 * given what it has while they wait, then answers them. A read of the app's
 * database answers a while later (a native call on iOS, a worker on web), so
 * a refetch's pending state reaches the screen before its answer. The
 * fixture's reads answer within the same turn, and TanStack would then hand
 * the screen both at once, or not, by timing alone.
 */
async function whileReading(start: () => void) {
  holding = true;
  await act(async () => {
    start();
  });
  await turns();
  holding = false;
  await act(async () => {
    for (const answer of held.splice(0)) {
      answer();
    }
  });
  await settle();
}

/** What every sync ends with (lib/query.tsx): every query refetched. */
async function sync() {
  await whileReading(() => {
    void qc.invalidateQueries();
  });
}

beforeEach(async () => {
  renderer = undefined;
  shown = [];
  reads = [];
  failures = 0;
  holding = false;
  held = [];
  adapter = makeAdapter();
  await insertLocalTxn(adapter, {
    id: 't1',
    user_id: 'u',
    payee: 'Rent',
    updated_at: SYNCED_AT,
  });
  // The transaction reads, counted, held while `holding` (whileReading),
  // and failing while `failures` lasts.
  const read = adapter.getFirstAsync.bind(adapter);
  adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
    if (/FROM transactions WHERE id = \?/.test(sql)) {
      reads.push(String(params?.[0]));
      await new Promise<void>((r) =>
        holding ? held.push(r) : setTimeout(r, 0)
      );
      if (failures > 0) {
        failures -= 1;
        throw new Error('database is locked');
      }
    }
    return read(sql, params as any);
  }) as typeof adapter.getFirstAsync;
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  qc = new QueryClient({
    defaultOptions: {
      // useTransaction's own retry rule applies (QUERY_RETRY, not for a
      // not-found); a retry is not delayed here.
      queries: { retryDelay: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
});

afterEach(async () => {
  // R2 takes the app offline; a failure there must not leave every later
  // test paused.
  onlineManager.setOnline(true);
  await act(async () => {
    renderer?.unmount();
  });
  qc.clear();
  adapter._sqlite.close();
});

describe("the edit screen's gone line through a refetch (#195)", () => {
  // Before: the line, then for each sync the spinner and the line again --
  // [false, true, false, true, false, true, false, true] -- each a new
  // reading on web and a new VoiceOver move on iOS.
  it('R1: a transaction that is not here is gone from its first answer on, through the refetches of three syncs', async () => {
    await open('t9');
    await sync();
    await sync();
    await sync();

    expect({ reads, gone: changes(shown.map((s) => s.gone)) }).toEqual({
      reads: ['t9', 't9', 't9', 't9'],
      gone: [false, true],
    });
  });

  // lib/query.tsx wires TanStack's onlineManager to NetInfo, so offline a
  // refetch is paused, not fetching: it keeps the answer too, until it runs.
  it('R2: offline, a refetch waits paused and keeps the answer; back online, it runs and answers the same', async () => {
    await open('t9');
    await act(async () => {
      onlineManager.setOnline(false);
    });
    await sync();
    const offline = shown[shown.length - 1];
    await act(async () => {
      onlineManager.setOnline(true);
    });
    await settle();

    expect({
      offline: { fetchStatus: offline.fetchStatus, gone: offline.gone },
      reads,
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      offline: { fetchStatus: 'paused', gone: true },
      reads: ['t9', 't9'],
      gone: [false, true],
    });
  });

  // Any other failure says nothing about the row: once the refetch and its
  // retry have failed, the screen shows the spinner, as for any failed read,
  // and the next sync's refetch does not bring the line back while it runs.
  it('P1 (pin): a refetch that fails for another reason, its retry too, ends the answer: the spinner', async () => {
    await open('t9');
    failures = 4;
    await sync();
    await sync();

    const last = shown[shown.length - 1];
    expect({
      reads,
      last: { fetchStatus: last.fetchStatus, gone: last.gone },
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      reads: ['t9', 't9', 't9', 't9', 't9'],
      last: { fetchStatus: 'idle', gone: false },
      gone: [false, true, false],
    });
  });

  // A link opened before the row is here (a deep link during the first
  // download): the line, then the form once a refetch reads the row
  // (useUserScopedReads.test.ts U8).
  it('P2 (pin): a refetch that finds the row ends the answer: the form', async () => {
    await open('t9');
    await insertLocalTxn(adapter, {
      id: 't9',
      user_id: 'u',
      payee: 'Coffee',
      updated_at: SYNCED_AT,
    });
    await sync();

    const last = shown[shown.length - 1];
    expect({
      reads,
      last: { row: last.row, gone: last.gone },
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      reads: ['t9', 't9'],
      last: { row: true, gone: false },
      gone: [false, true, false],
    });
  });

  // The answer is the id's. The screen is opened per transaction, but should
  // one be given another id, that one's read starts without an answer.
  it('P3 (pin): given another id, the screen does not say that one is gone while it loads', async () => {
    await open('t9');
    await whileReading(() => {
      renderer!.update(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Harness, { id: 't1' })
        )
      );
    });

    const t1 = shown.filter((s) => s.id === 't1');
    expect({
      t9: changes(shown.filter((s) => s.id === 't9').map((s) => s.gone)),
      t1: changes(t1.map((s) => s.gone)),
      t1Loading: t1.some((s) => !s.row),
      t1Row: t1[t1.length - 1]?.row,
    }).toEqual({
      t9: [false, true],
      t1: [false],
      t1Loading: true,
      t1Row: true,
    });
  });
});

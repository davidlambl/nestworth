// The register's signal that its account is gone (#163). The register reads
// ['account', id] (useAccount), and neither an account delete nor a realtime
// account tombstone invalidated it: a register re-opened on the account (the
// browser's Forward, a stale link), or on screen when another device deleted
// it, kept its last data, "+" and the transfer button, until some later sync
// happened to refetch it -- and a refetch then failed with 'Account not
// found' while TanStack kept the last data, which the register did not look
// at. Now the delete and the realtime handler refetch ['account', id], a
// not-found is not retried, and the register reads the error through
// isAccountNotFound and offers nothing that writes into the account. The
// screen itself has no component test (the repo has none): what it shows is
// verified in a browser; these tests pin the signal it is built on.
//
// Own file, importing the hooks and the fixture; G1, G2, G4, G5 and G7 load
// on the code before #163 (G1 and G5 are red there). G3 needs
// isAccountNotFound, new in #163, and G6 the not-found retry rule. The
// register now reads it through useAccountGone (#212), which keeps it through
// a refetch: the block at the end.
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
import { supabase } from '../supabase';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import {
  isAccountNotFound,
  useAccount,
  useAccountGone,
  useAccounts,
  useDeleteAccount,
} from '../hooks/useAccounts';
import { insertLocalAccount, makeAdapter } from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let register: ReturnType<typeof useAccount>;
let picker: ReturnType<typeof useAccounts>;
let delAccount: ReturnType<typeof useDeleteAccount>;

/**
 * A register open on `id`, a picker's list (the transfer, rule and import
 * screens read ['accounts']), and the Accounts screen's delete.
 */
function Harness({ id }: { id: string }) {
  const query = useAccount(id);
  const list = useAccounts();
  const del = useDeleteAccount();
  useEffect(() => {
    register = query;
    picker = list;
    delAccount = del;
  });
  return null;
}

/** What the register was given at one commit (#212). */
type Shown = { id: string; gone: boolean; fetchStatus: string; row: boolean };
let shown: Shown[];

/** The register's read of its account, and its gone banner's signal (#212). */
function Register({ id }: { id: string }) {
  const query = useAccount(id);
  const gone = useAccountGone(id, query);
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

/** The app's realtime subscription (lib/hooks/useRealtimeSync.ts). */
function Realtime() {
  useRealtimeSync();
  return null;
}

type RealtimeHandler = (payload: unknown) => void | Promise<void>;
let realtime: Record<string, RealtimeHandler>;

/**
 * Lets every query in flight settle and its result reach the harness.
 * TanStack hands a result to its observers on a setTimeout(0)
 * (notifyManager), so a query that stops fetching inside one turn is
 * rendered in the next: the loop stops only after a whole turn with nothing
 * fetching. Stopping at the first idle turn lost a retry's result about one
 * run in thirty (G7: two reads, status still 'pending').
 */
async function settle() {
  for (let i = 0, idle = 0; i < 20 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() > 0 ? 0 : idle + 1;
  }
}

async function open(id: string, screen = Harness) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(screen, { id })
      )
    );
  });
  await settle();
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  await insertLocalAccount(adapter, {
    id: 'a1',
    name: 'Old',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(adapter, {
    id: 'a2',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  // A channel that hands each table's handler to the test (G5).
  realtime = {};
  const channel = {
    on: (_event: string, filter: { table: string }, h: RealtimeHandler) => {
      realtime[filter.table] = h;
      return channel;
    },
    subscribe: () => channel,
  };
  Object.assign(supabase, { channel: () => channel, removeChannel: () => {} });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

describe("the register's signal that its account is gone (#163)", () => {
  // Before #163 the delete left ['account', 'a1'] alone: the register's
  // query stayed a success with the account's data, and nothing told it.
  it('G1: deleting the account a register is open on fails its query with Account not found, keeping the last data', async () => {
    await open('a1');
    const before = { name: register.data?.name, error: register.error };

    await act(async () => {
      await delAccount.mutateAsync('a1');
    });
    await settle();

    expect({
      before,
      after: {
        status: register.status,
        error: String(register.error),
        name: register.data?.name,
      },
    }).toEqual({
      before: { name: 'Old', error: null },
      after: {
        status: 'error',
        error: 'Error: Account not found',
        name: 'Old',
      },
    });
  });

  it('G2 (pin): deleting another account leaves the register as it was', async () => {
    await open('a1');

    await act(async () => {
      await delAccount.mutateAsync('a2');
    });
    await settle();

    expect({
      status: register.status,
      error: register.error,
      name: register.data?.name,
    }).toEqual({ status: 'success', error: null, name: 'Old' });
  });

  // Only the not-found error is "gone": a read that fails for any other
  // reason says nothing about the account, and the register must not tell
  // the user it was deleted.
  it('G3: isAccountNotFound is true for the not-found error alone', () => {
    expect({
      notFound: isAccountNotFound(new Error('Account not found')),
      otherError: isAccountNotFound(new Error('database is locked')),
      bareString: isAccountNotFound('Account not found'),
      none: isAccountNotFound(null),
    }).toEqual({
      notFound: true,
      otherError: false,
      bareString: false,
      none: false,
    });
  });

  // What a picker lists. The delete refetches ['accounts'] (it always did),
  // and the list reads live accounts only, so a mounted picker drops the
  // account as soon as the delete settles. What it does not drop is an id
  // already chosen: the transfer, rule and import screens keep their chosen
  // account in their own state, which is why their writers check it (#163).
  it('G4 (pin): a mounted picker list drops a deleted account once the delete settles', async () => {
    await open('a1');
    const before = (picker.data ?? []).map((a) => a.id);

    await act(async () => {
      await delAccount.mutateAsync('a1');
    });
    await settle();

    expect({ before, after: (picker.data ?? []).map((a) => a.id) }).toEqual({
      before: ['a1', 'a2'],
      after: ['a2'],
    });
  });

  // The app retries a failed query once, a second later (lib/query.tsx). For
  // 'Account not found' that second is a register re-opened on a dead account
  // (web history Forward, a reload, a stale link) still offering "+" and the
  // transfer button: the retry reads the same local row and fails the same way.
  it('G6: a missing account fails its query on the first read, without the app retry', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    let accountReads = 0;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM accounts WHERE id = \?/.test(sql)) accountReads++;
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('gone');

    expect({
      status: register.status,
      error: String(register.error),
      accountReads,
    }).toEqual({
      status: 'error',
      error: 'Error: Account not found',
      accountReads: 1,
    });
  });

  it('G7 (pin): any other read failure keeps the app retry', async () => {
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const read = adapter.getFirstAsync.bind(adapter);
    let accountReads = 0;
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM accounts WHERE id = \?/.test(sql)) {
        accountReads++;
        if (accountReads === 1) throw new Error('database is locked');
      }
      return read(sql, params as any);
    }) as typeof adapter.getFirstAsync;

    await open('a1');

    expect({
      status: register.status,
      name: register.data?.name,
      accountReads,
    }).toEqual({ status: 'success', name: 'Old', accountReads: 2 });
  });

  // The register on screen when another device deletes its account: on iOS
  // the only way a register meets a dead account (it cannot stay mounted under
  // the Accounts tab, where this device deletes one), and on web the likeliest.
  // The tombstone arrives by realtime and removes the synced account here, but
  // the handler refetched ['accounts'] only, so the register kept "+" and the
  // transfer button until a background sync or a refused write.
  it('G5: an account tombstone from realtime fails a mounted register with Account not found', async () => {
    let rt: ReactTestRenderer;
    await act(async () => {
      rt = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Realtime)
        )
      );
    });
    await open('a1');

    await act(async () => {
      await realtime.accounts({
        eventType: 'UPDATE',
        new: { id: 'a1', user_id: 'u', deleted_at: '2026-10-01T00:00:00Z' },
        old: {},
      });
    });
    await settle();
    await act(async () => {
      rt.unmount();
    });

    expect({
      local: adapter._sqlite.prepare('SELECT id FROM accounts').all(),
      picker: (picker.data ?? []).map((a) => a.id),
      register: {
        status: register.status,
        error: String(register.error),
        name: register.data?.name,
      },
    }).toEqual({
      local: [{ id: 'a2' }],
      picker: ['a2'],
      register: {
        status: 'error',
        error: 'Error: Account not found',
        name: 'Old',
      },
    });
  });
});

// The register's gone banner through a refetch (#212). A register opened on an
// account that is not the user's here -- never downloaded, or another
// account's (#177), reached by a stale link or the browser's history -- reads
// a query that holds no data, and TanStack Query puts a query without data
// back to pending, its error cleared, each time it fetches again: after the
// startup sequence and every sync (each ends by invalidating every query,
// lib/query.tsx), on a reconnect, and on web on each return to the window.
// Read from the error alone, the register left its gone state for each
// refetch -- its search bar, filters and empty list for a moment -- and came
// back to it with the answer: the banner a new addition to FormError's live
// region, read out again on web, and on iOS a new VoiceOver move to it.
// useAccountGone keeps the last answer a read settled on while a refetch is
// in flight (#195's rule for the edit screen, lib/hooks/useGoneAnswer.ts).
//
// useAccountGone is new in #212, so the red proofs are its mutants: R1-R3
// fail with the register's reading before it (isAccountNotFound on the error
// alone) and with the answer replaced while a read is in flight, R3 also with
// the answer kept only while `fetchStatus` is 'fetching' (not paused). P1-P4
// are pins, green with the reading before too: P1 fails if the answer
// outlives another error, P2 if it outlives the row, P3 if it is kept for
// another id; P4 is the account that goes while its register is open, whose
// error TanStack kept through a refetch before #212 too.
describe("the register's gone banner through a refetch (#212)", () => {
  /** The account reads made, by id. */
  let reads: string[];
  /** How many of the next account reads fail with another error. */
  let failures: number;
  /** While set, an account read waits in `held` for the test to answer it. */
  let holding: boolean;
  let held: (() => void)[];

  /** The values in order, each repeat of the one before dropped. */
  function changes(values: boolean[]): boolean[] {
    return values.filter((v, i) => i === 0 || v !== values[i - 1]);
  }

  /** Turns of the event loop, for TanStack to hand a new state to the screen. */
  async function turns(n = 3) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  /**
   * Runs `start` with the account reads it starts held, lets the register be
   * given what it has while they wait, then answers them
   * (useTransactionGone.test.ts): a read of the app's database answers a
   * while later (a native call on iOS, a worker on web), so a refetch's
   * pending state reaches the screen before its answer.
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

  beforeEach(() => {
    shown = [];
    reads = [];
    failures = 0;
    holding = false;
    held = [];
    // The account reads, counted, held while `holding` (whileReading), and
    // failing while `failures` lasts.
    const read = adapter.getFirstAsync.bind(adapter);
    adapter.getFirstAsync = (async (sql: string, params?: unknown[]) => {
      if (/FROM accounts WHERE id = \?/.test(sql)) {
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
    qc = new QueryClient({
      defaultOptions: {
        // useAccount's own retry rule applies (QUERY_RETRY, not for a
        // not-found); a retry is not delayed here.
        queries: { retryDelay: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
  });

  afterEach(() => {
    // R3 takes the app offline; a failure there must not leave every later
    // test paused.
    onlineManager.setOnline(true);
  });

  // Before: the banner, then for each sync the register and the banner again
  // -- [false, true, false, true, false, true, false, true] -- each a new
  // reading on web and a new VoiceOver move on iOS.
  it('R1: a register opened on an account that is not here is gone from its first answer on, through the refetches of three syncs', async () => {
    await open('gone', Register);
    await sync();
    await sync();
    await sync();

    expect({ reads, gone: changes(shown.map((s) => s.gone)) }).toEqual({
      reads: ['gone', 'gone', 'gone', 'gone'],
      gone: [false, true],
    });
  });

  // Another account's account on this device reads as missing (#177), the
  // same answer, refetched the same way.
  it("R2: another account's account is gone from its first answer on, through a sync", async () => {
    await insertLocalAccount(adapter, {
      id: 'b1',
      user_id: 'v',
      name: 'Theirs',
      updated_at: SYNCED_AT,
    });
    await open('b1', Register);
    await sync();

    expect({ reads, gone: changes(shown.map((s) => s.gone)) }).toEqual({
      reads: ['b1', 'b1'],
      gone: [false, true],
    });
  });

  // lib/query.tsx wires TanStack's onlineManager to NetInfo, so offline a
  // refetch is paused, not fetching: it keeps the answer too, until it runs.
  it('R3: offline, a refetch waits paused and keeps the answer; back online, it runs and answers the same', async () => {
    await open('gone', Register);
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
      reads: ['gone', 'gone'],
      gone: [false, true],
    });
  });

  // Any other failure says nothing about the account: once the refetch and
  // its retry have failed, the register is not said to be gone (it offers
  // nothing that writes, for want of the account's row, as while it loads),
  // and the next sync's refetch does not bring the banner back while it runs.
  it('P1 (pin): a refetch that fails for another reason, its retry too, ends the answer', async () => {
    await open('gone', Register);
    failures = 4;
    await sync();
    await sync();

    const last = shown[shown.length - 1];
    expect({
      reads,
      last: { fetchStatus: last.fetchStatus, gone: last.gone },
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      reads: ['gone', 'gone', 'gone', 'gone', 'gone'],
      last: { fetchStatus: 'idle', gone: false },
      gone: [false, true, false],
    });
  });

  // A link opened before the account is here (a deep link during the first
  // download, or a reset before its re-download): the banner, then the
  // register once a refetch reads the row.
  it('P2 (pin): a refetch that finds the account ends the answer: the register', async () => {
    await open('a9', Register);
    await insertLocalAccount(adapter, {
      id: 'a9',
      name: 'Joint',
      updated_at: SYNCED_AT,
    });
    await sync();

    const last = shown[shown.length - 1];
    expect({
      reads,
      last: { row: last.row, gone: last.gone },
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      reads: ['a9', 'a9'],
      last: { row: true, gone: false },
      gone: [false, true, false],
    });
  });

  // The answer is the id's: given another id (the accounts panel opens
  // another account's register), that one's read starts without an answer.
  it('P3 (pin): given another id, the register does not say that one is gone while it loads', async () => {
    await open('gone', Register);
    await whileReading(() => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Register, { id: 'a1' })
        )
      );
    });

    const a1 = shown.filter((s) => s.id === 'a1');
    expect({
      gone: changes(shown.filter((s) => s.id === 'gone').map((s) => s.gone)),
      a1: changes(a1.map((s) => s.gone)),
      a1Loading: a1.some((s) => !s.row),
      a1Row: a1[a1.length - 1]?.row,
    }).toEqual({
      gone: [false, true],
      a1: [false],
      a1Loading: true,
      a1Row: true,
    });
  });

  // The register on screen when its account goes (a realtime or pulled
  // tombstone removes the synced row, G5): its query keeps the last data, and
  // TanStack keeps the error of a query with data through a refetch, so this
  // banner never flashed; useAccountGone keeps it too.
  it('P4 (pin): an account that goes while its register is open is gone from the refetch that misses it on, through two more syncs', async () => {
    await open('a1', Register);
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();
    await sync();
    await sync();
    await sync();

    const last = shown[shown.length - 1];
    expect({
      reads,
      last: { row: last.row, gone: last.gone },
      gone: changes(shown.map((s) => s.gone)),
    }).toEqual({
      reads: ['a1', 'a1', 'a1', 'a1'],
      last: { row: true, gone: true },
      gone: [false, true],
    });
  });
});

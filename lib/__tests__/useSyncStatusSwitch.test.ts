// What the sync status shows the account signed in after a change of account
// on one device (#193). The status store is shared by every account signed in
// on the device, and the outgoing account's sync keeps the lock after the
// switch (#111): it ends in finishSync, whose refresh publishes THAT
// account's pending count, refused rows and "Last synced" into the store
// after the new account's own refresh. The header's dot and Settings read the
// store through useSyncStatus, which showed them to the new account until its
// own sync ended. A stale requestPush for the outgoing account (a mutation hook
// that captured its id) publishes the same way.
//
// Through the real engine (requestPush, its entry check, finishSync) and the
// shared fixture, with the hook rendered by react-test-renderer: the account
// signed in is the auth mock's `mockUser`, the session the engine sees is the
// fixture's `sessionUserId`, and a switch moves both, as AuthProvider does.
//
// Own file: lib/sync.ts and lib/syncStatus.ts hold module state (the lock,
// the snapshot), and every test here awaits what it started.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
let mockUser: { id: string } | null = null;
jest.mock('../auth', () => ({ useAuth: () => ({ user: mockUser }) }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getSyncMeta } from '../db';
import { supabase } from '../supabase';
import { fullSync, requestPush } from '../sync';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import { useSyncStatus } from '../hooks/useSyncStatus';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  type SupabaseOpts,
  wireSyncMocks,
} from '../testing/syncFixture';

const WRITTEN_AT = '2026-10-15T08:00:00.000Z';
/** Each account's last complete pull on this device ("Last synced"). */
const PULLED_A = '2026-10-20T08:00:00.000Z';
const PULLED_B = '2026-10-22T09:30:00.000Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let remote: SupabaseOpts;
let qc: QueryClient;
let renderer: ReactTestRenderer | null;
let seen: ReturnType<typeof useSyncStatus>;
/** What the hook handed out, one entry per commit, in order. */
let renders: Shown[];
/** How many times each user's "Last synced" was read: one per refresh. */
let pullKeyReads: Map<string, number>;
let quiet: jest.SpyInstance[];

type Shown = ReturnType<typeof view>;

/** The per-account part of what the hook hands out, and whose it is. */
function view(s: ReturnType<typeof useSyncStatus>) {
  return {
    userId: s.userId,
    pendingCount: s.pendingCount,
    pendingAccounts: s.pendingAccounts,
    pendingTransactions: s.pendingTransactions,
    pendingSplits: s.pendingSplits,
    pendingRules: s.pendingRules,
    refusedCount: s.refusedCount,
    refusedTransactions: s.refusedTransactions,
    refusedRules: s.refusedRules,
    refusedSplits: s.refusedSplits,
    refused: (s.refusedRows ?? []).map((r) => `${r.id}:${r.payee}`),
    lastSyncedAt: s.lastSyncedAt,
  };
}

/** A's numbers: one unsynced row of every kind, two of them refused for good. */
const A_VIEW: Shown = {
  userId: 'a',
  pendingCount: 6,
  pendingAccounts: 1,
  pendingTransactions: 2,
  pendingSplits: 2,
  pendingRules: 1,
  refusedCount: 2,
  refusedTransactions: 1,
  refusedRules: 1,
  refusedSplits: 1,
  refused: ['ta2:Refused payee', 'ra1:Rule payee'],
  lastSyncedAt: PULLED_A,
};

/** B's numbers: three transactions waiting, nothing refused. */
const B_VIEW: Shown = {
  userId: 'b',
  pendingCount: 3,
  pendingAccounts: 0,
  pendingTransactions: 3,
  pendingSplits: 0,
  pendingRules: 0,
  refusedCount: 0,
  refusedTransactions: 0,
  refusedRules: 0,
  refusedSplits: 0,
  refused: [],
  lastSyncedAt: PULLED_B,
};

/** What the hook shows before it has read the signed-in account's numbers. */
const nothingFor = (userId: string | null): Shown => ({
  userId,
  pendingCount: 0,
  pendingAccounts: 0,
  pendingTransactions: 0,
  pendingSplits: 0,
  pendingRules: 0,
  refusedCount: 0,
  refusedTransactions: 0,
  refusedRules: 0,
  refusedSplits: 0,
  refused: [],
  lastSyncedAt: null,
});

function Harness() {
  const status = useSyncStatus();
  useEffect(() => {
    seen = status;
    renders.push(view(status));
  });
  return null;
}

const tree = () =>
  createElement(QueryClientProvider, { client: qc }, createElement(Harness));

const refusal = (table: string, id: string) => ({
  table,
  id,
  updatedAt: WRITTEN_AT,
  accountId: 'a1',
  kind: 'rejected',
  code: '22P02',
  accountName: 'Ours',
  since: WRITTEN_AT,
});

beforeEach(async () => {
  ctx = wireSyncMocks();
  remote = { sessionUserId: 'a' };
  ctx.installSupabase(remote);
  pullKeyReads = new Map();
  (getSyncMeta as unknown as jest.Mock).mockImplementation(
    async (k: string) => {
      if (k.startsWith('last_pull_at:')) {
        const user = k.slice('last_pull_at:'.length);
        pullKeyReads.set(user, (pullKeyReads.get(user) ?? 0) + 1);
      }
      return ctx.meta.get(k) ?? null;
    }
  );

  // A: an account, two transactions with a split line each, and a rule, all
  // unsynced; the second transaction and the rule refused for good (#115).
  await insertLocalAccount(ctx.adapter, {
    id: 'a1',
    user_id: 'a',
    name: 'Ours',
    _sync_status: 'pending',
  });
  for (const [id, payee] of [
    ['ta1', 'Waiting payee'],
    ['ta2', 'Refused payee'],
  ]) {
    await insertLocalTxn(ctx.adapter, {
      id,
      user_id: 'a',
      account_id: 'a1',
      payee,
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
  }
  await insertLocalSplit(ctx.adapter, {
    id: 'sa1',
    transaction_id: 'ta1',
    _sync_status: 'pending',
  });
  await insertLocalSplit(ctx.adapter, {
    id: 'sa2',
    transaction_id: 'ta2',
    _sync_status: 'pending',
  });
  await insertLocalRule(ctx.adapter, {
    id: 'ra1',
    user_id: 'a',
    account_id: 'a1',
    template: { payee: 'Rule payee', amount: -5 },
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  ctx.meta.set(
    'push_refusals:a',
    JSON.stringify([
      refusal('transactions', 'ta2'),
      refusal('recurring_rules', 'ra1'),
    ])
  );
  ctx.meta.set('last_pull_at:a', PULLED_A);

  // B: a synced account with three transactions waiting to upload.
  await insertLocalAccount(ctx.adapter, {
    id: 'b1',
    user_id: 'b',
    name: 'Theirs',
  });
  for (const id of ['tb1', 'tb2', 'tb3']) {
    await insertLocalTxn(ctx.adapter, {
      id,
      user_id: 'b',
      account_id: 'b1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
  }
  ctx.meta.set('last_pull_at:b', PULLED_B);

  renders = [];
  renderer = null;
  qc = new QueryClient();
  quiet = (['log', 'warn'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  quiet.forEach((spy) => spy.mockRestore());
  qc.clear();
  // Nothing left holding the lock, or the next test's sync would queue.
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

/** Lets every read already started land (the fixture resolves in microtasks). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** Mounts the hook as `userId`; its mount refresh lands. */
async function mountAs(userId: string): Promise<void> {
  mockUser = { id: userId };
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  await settle();
}

/**
 * The account signed in becomes `userId`: the session first, then the screens
 * (AuthProvider publishes the session, React renders the new user). The same
 * hook instance re-renders, as the sidebar's does; the tabs' are remounted
 * (`<Tabs key={user.id}>`), which W6 covers.
 */
async function switchTo(userId: string): Promise<void> {
  remote.sessionUserId = userId;
  mockUser = { id: userId };
  await act(async () => {
    renderer!.update(tree());
  });
}

/**
 * Parks the next session read until `gate` opens: the sync that makes it
 * holds the lock meanwhile. Resolves once that read has been reached.
 */
function parkNextSessionRead(gate: Promise<void>): Promise<void> {
  const auth = (supabase as any).auth;
  const real = auth.getSession.bind(auth);
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let fired = false;
  auth.getSession = async () => {
    if (!fired) {
      fired = true;
      arrive();
      await gate;
    }
    return real();
  };
  return arrived;
}

/** The push's first read: its pending accounts (pushTable). */
const PENDING_ACCOUNTS_READ = /FROM accounts WHERE _sync_status = 'pending'/;

/**
 * Parks the first read matching `match` until `gate` opens, as
 * syncLockQueueUsers.test.ts's gateFirstRead does. Resolves once reached.
 */
function parkFirstRead(match: RegExp, gate: Promise<void>): Promise<void> {
  const real = ctx.adapter.getAllAsync.bind(ctx.adapter);
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let fired = false;
  ctx.adapter.getAllAsync = async (sql: string, params: any[] = []) => {
    if (!fired && match.test(sql)) {
      fired = true;
      arrive();
      await gate;
    }
    return real(sql, params);
  };
  return arrived;
}

/** A's push, started while A is signed in and parked in its entry check. */
async function holdLockAsA(): Promise<{
  open: () => void;
  holder: Promise<void>;
}> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const parked = parkNextSessionRead(gate);
  let holder!: Promise<void>;
  await act(async () => {
    holder = requestPush('a');
    await parked;
  });
  expect(getSyncSnapshot().isSyncing).toBe(true);
  return { open, holder };
}

/** Consecutive identical entries collapsed: the values the screen went through. */
const went = (list: Shown[]) =>
  list.filter(
    (s, i) => i === 0 || JSON.stringify(s) !== JSON.stringify(list[i - 1])
  );

describe('one account on the device: unchanged (pins)', () => {
  // FIRST in the file: the store is module state, and only the first test
  // sees it as the app starts, before any refresh (asserted, so a reorder
  // fails here rather than passing on another test's leftovers).
  it('P1: hands out the store as it stands at every render, and reads once per mount', async () => {
    expect({
      pending: getSyncSnapshot().pendingCount,
      lastSynced: getSyncSnapshot().lastSyncedAt,
    }).toEqual({ pending: 0, lastSynced: null });
    // A is the only account: its push runs under its own session and uploads
    // what the server takes.
    renders = [];
    mockUser = { id: 'a' };
    const raw: Shown[] = [];
    function Raw() {
      const status = useSyncStatus();
      const store = getSyncSnapshot();
      useEffect(() => {
        renders.push(view(status));
        raw.push(
          view({
            ...status,
            ...store,
            // As 112b060 handed them out: refused rows only once read for A.
            refusedCount: status.refusedCount,
            refusedTransactions: status.refusedTransactions,
            refusedRules: status.refusedRules,
            refusedSplits: status.refusedSplits,
            refusedRows: status.refusedRows,
          } as any)
        );
      });
      return null;
    }
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(QueryClientProvider, { client: qc }, createElement(Raw))
      );
    });
    await settle();
    const mountReads = pullKeyReads.get('a');
    await act(async () => {
      await requestPush('a');
    });
    await settle();

    expect({ mountReads, renders }).toEqual({ mountReads: 1, renders: raw });
  });

  it("P2: shows the signed-in account its own sync's numbers as soon as that sync ends", async () => {
    await mountAs('a');
    await act(async () => {
      await requestPush('a');
    });
    await settle();
    const store = getSyncSnapshot();

    expect({ shown: view(seen), known: seen.refusedKnown }).toEqual({
      shown: {
        userId: 'a',
        pendingCount: store.pendingCount,
        pendingAccounts: store.pendingAccounts,
        pendingTransactions: store.pendingTransactions,
        pendingSplits: store.pendingSplits,
        pendingRules: store.pendingRules,
        refusedCount: store.refusedCount,
        refusedTransactions: store.refusedTransactions,
        refusedRules: store.refusedRules,
        refusedSplits: store.refusedSplits,
        refused: store.refusedRows.map((r) => `${r.id}:${r.payee}`),
        lastSyncedAt: store.lastSyncedAt,
      },
      known: true,
    });
  });
});

describe('the sync status after a change of account (#193)', () => {
  beforeEach(async () => {
    // A was the account signed in before each scenario: the store holds its
    // numbers, as every sync for A leaves it.
    await refreshSyncState('a');
    pullKeyReads.clear();
  });

  it("W1: shows the signed-in account its own count and last-synced time once the previous account's sync ends", async () => {
    await mountAs('a');
    const asA = view(seen);
    const { open, holder } = await holdLockAsA();

    await switchTo('b');
    await settle();
    const beforeTheirSyncEnds = view(seen);

    // A's push is refused at its entry check under B's session (#111), and
    // its finishSync refreshes the status for A.
    await act(async () => {
      open();
      await holder;
    });
    await settle();

    expect({
      asA,
      beforeTheirSyncEnds,
      afterTheirSyncEnds: view(seen),
    }).toEqual({
      asA: A_VIEW,
      beforeTheirSyncEnds: B_VIEW,
      afterTheirSyncEnds: B_VIEW,
    });
  });

  it("W2: never shows one of the previous account's numbers, not even for a render", async () => {
    await mountAs('a');
    const { open, holder } = await holdLockAsA();
    await switchTo('b');
    await settle();

    renders = [];
    await act(async () => {
      open();
      await holder;
    });
    await settle();

    // Another account's refresh reads as nothing for one render, while this
    // account's own refresh is read back; then this account's numbers.
    expect(went(renders)).toEqual([nothingFor('b'), B_VIEW]);
  });

  it('W3: reads the signed-in account back once per refresh for another, and nothing more (no ping-pong)', async () => {
    await mountAs('a');
    const { open, holder } = await holdLockAsA();
    await switchTo('b');
    await settle();
    const mountReads = { ...Object.fromEntries(pullKeyReads) };

    await act(async () => {
      open();
      await holder;
    });
    await settle();
    const afterOne = { ...Object.fromEntries(pullKeyReads) };

    // A stale requestPush for A (a hook that captured A's id): refused at its
    // entry check, it publishes A's numbers once more.
    await act(async () => {
      await requestPush('a');
    });
    await settle();
    await settle();
    const afterTwo = { ...Object.fromEntries(pullKeyReads) };

    expect({ mountReads, afterOne, afterTwo, shown: view(seen) }).toEqual({
      // A's mount refresh; B's mount refresh, and B's read back of the A
      // numbers A's mount refresh left in the store.
      mountReads: { a: 1, b: 2 },
      // A's finishSync: one read for A, one read back for B.
      afterOne: { a: 2, b: 3 },
      afterTwo: { a: 3, b: 4 },
      shown: B_VIEW,
    });
  });

  it('W4: a refresh for the previous account landing after a quick switch back is read over', async () => {
    await mountAs('a');
    // B's mount refresh is parked at its last read, "Last synced".
    let release!: () => void;
    const parkedRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plain = (
      getSyncMeta as unknown as jest.Mock
    ).getMockImplementation()!;
    let parkedOnce = false;
    (getSyncMeta as unknown as jest.Mock).mockImplementation(
      async (k: string) => {
        if (k === 'last_pull_at:b' && !parkedOnce) {
          parkedOnce = true;
          await parkedRead;
        }
        return plain(k);
      }
    );

    await switchTo('b');
    await switchTo('a');
    await settle();
    const backAsA = view(seen);

    // B's refresh, started before the switch back, lands last. It never
    // passes through finishSync, so it is recorded commit by commit as W2
    // records that path: nothing for one render while A's own numbers are
    // read back, then A's.
    renders = [];
    await act(async () => {
      release();
    });
    await settle();

    expect({ backAsA, afterTheirsLands: went(renders) }).toEqual({
      backAsA: A_VIEW,
      afterTheirsLands: [nothingFor('a'), A_VIEW],
    });
  });

  it("W5: while the new account's own sync runs (it waited for the lock, as startSyncSession's does), shows that account's numbers, then the ones its sync leaves", async () => {
    // B's account is on the server, so B's pull completes and stamps its key.
    ctx.store.accounts = [
      remoteAccount({ id: 'b1', user_id: 'b', name: 'Theirs' }),
    ];
    await mountAs('a');
    const { open, holder } = await holdLockAsA();
    await switchTo('b');
    // B's sync, started by useSyncEngine for the new account, waits for A's
    // lock (#63) and runs as B once A's sync has released it; it is parked at
    // its first read, so the screen can be read while it runs.
    let openB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      openB = resolve;
    });
    const parkedB = parkFirstRead(PENDING_ACCOUNTS_READ, gateB);
    let theirs!: Promise<void>;
    await act(async () => {
      theirs = fullSync('b');
    });
    await settle();

    await act(async () => {
      open();
      await holder;
      await parkedB;
    });
    await settle();
    const whileTheirsRuns = view(seen);
    const syncing = seen.isSyncing;

    await act(async () => {
      openB();
      await theirs;
    });
    await settle();

    expect({
      syncing,
      whileTheirsRuns,
      afterTheirs: {
        userId: seen.userId,
        pendingCount: seen.pendingCount,
        pulledNow: seen.lastSyncedAt !== null && seen.lastSyncedAt > PULLED_B,
        lastError: seen.lastError,
      },
    }).toEqual({
      syncing: true,
      whileTheirsRuns: B_VIEW,
      // B's three transactions reached the server and B's pull stamped its key.
      afterTheirs: {
        userId: 'b',
        pendingCount: 0,
        pulledNow: true,
        lastError: null,
      },
    });
  });

  it('W6: a screen mounted for the new account (the tabs are keyed by the account) reads its own numbers back too', async () => {
    await mountAs('a');
    const { open, holder } = await holdLockAsA();
    // B signs in: the screens mounted for A unmount, and B's mount.
    remote.sessionUserId = 'b';
    await act(async () => {
      renderer!.unmount();
    });
    await mountAs('b');
    const fresh = view(seen);

    await act(async () => {
      open();
      await holder;
    });
    await settle();

    expect({ fresh, afterTheirSyncEnds: view(seen) }).toEqual({
      fresh: B_VIEW,
      afterTheirSyncEnds: B_VIEW,
    });
  });

  it('S0: signed out, shows nothing of the account that was signed in', async () => {
    await mountAs('a');
    mockUser = null;
    await act(async () => {
      renderer!.update(tree());
    });
    await settle();

    expect(view(seen)).toEqual(nothingFor(null));
  });
});

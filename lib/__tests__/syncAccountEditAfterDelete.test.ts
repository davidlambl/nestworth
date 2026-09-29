// An account edit that reaches the account after this device deleted it
// (#153), through the hooks the Accounts screen calls and the real push.
//
// Delete and then Archive on the same row of the Accounts list (it stays
// listed until the delete's refetch). Before #153 the archive's UPDATE set
// the account back to 'pending': the push uploaded the account live
// (archived) and tombstoned its transactions and rules, which
// applyAccountDelete had marked: an account delete half-undone, on every
// device (F1). The same two taps made offline, paused and resumed together
// on reconnect, did not un-delete even before #153, as measured here (F2).
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
import { pushChanges } from '../sync';
import { useDeleteAccount, useUpdateAccount } from '../hooks/useAccounts';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let hooks: {
  del: ReturnType<typeof useDeleteAccount>;
  update: ReturnType<typeof useUpdateAccount>;
};
let quiet: jest.SpyInstance[];

function Harness() {
  const del = useDeleteAccount();
  const update = useUpdateAccount();
  useEffect(() => {
    hooks = { del, update };
  });
  return null;
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  // a1 with a transaction and a rule, synced: on the server and here.
  ctx.store.accounts = [
    remoteAccount({ id: 'a1', updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  ctx.store.transactions = [
    remoteTxn({ id: 't1', updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  ctx.store.recurring_rules = [
    remoteRule({ id: 'r1', updated_at: toPgTimestamp(SYNCED_AT) }),
  ];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalTxn(ctx.adapter, { id: 't1', updated_at: SYNCED_AT });
  await insertLocalRule(ctx.adapter, { id: 'r1', updated_at: SYNCED_AT });

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

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
function rejection(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e) => String(e)
  );
}

/** The server's copy of a row: live, or tombstoned, and whether archived. */
function server(table: 'accounts' | 'transactions' | 'recurring_rules') {
  return (ctx.store[table] as any[]).map(
    (r) =>
      `${r.id}:${r.deleted_at != null ? 'tombstoned' : 'live'}` +
      (table === 'accounts' ? (r.is_archived ? ',archived' : '') : '')
  );
}

function local(table: 'accounts' | 'transactions' | 'recurring_rules') {
  return (
    ctx.adapter._sqlite
      .prepare(`SELECT id, _sync_status FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);
}

describe('an account edit after this device deleted the account (#153)', () => {
  // Before #153: the archive resolved and set a1 back to 'pending'
  // (archived). The push upserted a1 live and archived and tombstoned t1 and
  // r1: a1 came back on every device, emptied, and local a1 was synced.
  it('F1: Delete then Archive, in turn: the archive is refused, and the push tombstones the account with its children', async () => {
    let err: string | null = null;
    await act(async () => {
      await hooks.del.mutateAsync('a1');
      err = await rejection(
        hooks.update.mutateAsync({ id: 'a1', isArchived: true })
      );
    });
    await pushChanges('u');

    expect({
      err,
      server: {
        accounts: server('accounts'),
        transactions: server('transactions'),
        rules: server('recurring_rules'),
      },
      local: {
        accounts: local('accounts'),
        transactions: local('transactions'),
        rules: local('recurring_rules'),
      },
    }).toEqual({
      err: expect.stringMatching(/was deleted on this device/),
      server: {
        accounts: ['a1:tombstoned'],
        transactions: ['t1:tombstoned'],
        rules: ['r1:tombstoned'],
      },
      local: { accounts: [], transactions: [], rules: [] },
    });
  });

  // The same two taps made offline: TanStack pauses both mutations before
  // their mutationFn and, on reconnect, continues them together (query-core
  // 5.96's resumePausedMutations). Green before #153 too: the archive is one
  // plain statement and lands before the delete's queued transaction marks
  // the account, so the delete stands whichever way the archive goes. What
  // this pins is that outcome, as measured, for either order of the two
  // writes: an archive that runs first is overwritten by the delete, one
  // that runs after it is refused.
  it('F2 (pin): Delete then Archive offline, resumed together on reconnect: the delete stands', async () => {
    onlineManager.setOnline(false);
    let delDone: Promise<string | null> | null = null;
    let updDone: Promise<string | null> | null = null;
    await act(async () => {
      delDone = rejection(hooks.del.mutateAsync('a1'));
      updDone = rejection(
        hooks.update.mutateAsync({ id: 'a1', isArchived: true })
      );
    });
    // Both paused: nothing written yet.
    const paused = qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state.isPaused);
    const beforeResume = local('accounts');

    let outcomes: (string | null)[] = [];
    await act(async () => {
      onlineManager.setOnline(true);
      outcomes = await Promise.all([delDone!, updDone!]);
    });
    await pushChanges('u');

    expect({
      paused,
      beforeResume,
      deleted: outcomes[0],
      archive:
        outcomes[1] === null || /was deleted on this device/.test(outcomes[1]),
      server: server('accounts'),
      local: local('accounts'),
    }).toEqual({
      paused: [true, true],
      beforeResume: ['a1:synced'],
      deleted: null,
      archive: true,
      server: ['a1:tombstoned'],
      local: [],
    });
  });
});

// Writes into an account this device has deleted, through the hooks the
// screens call and the real push (#163).
//
// A register re-opened on a deleted account (the browser's Forward, a stale
// link), or on screen when another device deleted it, still offered "+" and
// its transfer button, and the New Recurring Rule screen keeps the account it
// was given. Before #163 each writer put a NEW row 'pending' under the dead
// account, and the server refuses a new child of a tombstoned account with
// 23503 and no hint (005's inherit_account_tombstone, modelled by the fixture
// since #163): the push warns, keeps the row pending, and retries it on every
// push, forever. The row is in no register, and the reset guard counts it, so
// "Reset & re-download" refuses. For a transfer, the other leg uploads alone
// with its link dangling. Now each writer refuses, and nothing reaches the
// server.
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
import { pullChanges, pushChanges, resetLocalData } from '../sync';
import { useDeleteAccount } from '../hooks/useAccounts';
import {
  useCreateTransaction,
  useCreateTransfer,
} from '../hooks/useTransactions';
import { useCreateRecurringRule } from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalTxn,
  remoteAccount,
  remoteTxn,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When another device deleted a1, as the server stamped it. */
const ELSEWHERE_AT = '2026-10-14T09:00:00+00:00';

const GONE =
  /This account no longer exists on this device, so the transaction was not saved\./;
const DELETED_HERE =
  /This account was deleted on this device, so the transaction was not saved\./;

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let hooks: {
  delAccount: ReturnType<typeof useDeleteAccount>;
  create: ReturnType<typeof useCreateTransaction>;
  transfer: ReturnType<typeof useCreateTransfer>;
  rule: ReturnType<typeof useCreateRecurringRule>;
};
let warnings: string[];
let quiet: jest.SpyInstance[];

function Harness() {
  const delAccount = useDeleteAccount();
  const create = useCreateTransaction();
  const transfer = useCreateTransfer();
  const rule = useCreateRecurringRule();
  useEffect(() => {
    hooks = { delAccount, create, transfer, rule };
  });
  return null;
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  warnings = [];
  quiet = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    }),
  ];
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  // a1 with one transaction and a2 empty, all synced: on the server and here.
  ctx.store.accounts = [
    remoteAccount({
      id: 'a1',
      name: 'Old',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
    remoteAccount({
      id: 'a2',
      name: 'Savings',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  ctx.store.transactions = [
    remoteTxn({
      id: 't1',
      account_id: 'a1',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  await insertLocalAccount(ctx.adapter, {
    id: 'a1',
    name: 'Old',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(ctx.adapter, {
    id: 'a2',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    account_id: 'a1',
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

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
function rejection(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e) => String(e)
  );
}

/** The server's rows: `id:live|tombstoned`, and the account for a child. */
function server(table: 'accounts' | 'transactions' | 'recurring_rules') {
  return (ctx.store[table] as any[]).map(
    (r) =>
      `${r.id}:${r.deleted_at != null ? 'tombstoned' : 'live'}` +
      (table === 'accounts' ? '' : `@${r.account_id}`)
  );
}

function local(table: 'accounts' | 'transactions' | 'recurring_rules') {
  return (
    ctx.adapter._sqlite
      .prepare(`SELECT id, _sync_status FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string }[]
  ).map((r) => `${r.id}:${r._sync_status}`);
}

/** The rows the reset guard counts (lib/sync.ts countUnsyncedRows). */
function unsynced(): number {
  const one = (sql: string) =>
    (ctx.adapter._sqlite.prepare(sql).get() as { n: number }).n;
  return (
    one(
      "SELECT COUNT(*) AS n FROM accounts WHERE user_id = 'u' AND _sync_status IN ('pending','deleted')"
    ) +
    one(
      "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'u' AND _sync_status IN ('pending','deleted')"
    ) +
    one(
      "SELECT COUNT(*) AS n FROM recurring_rules WHERE user_id = 'u' AND _sync_status IN ('pending','deleted')"
    )
  );
}

/** The push's warnings about a refused row, as the console printed them. */
function refusals(): string[] {
  return warnings.filter((w) => / rejected: /.test(w));
}

/** The account delete as the Accounts screen makes it, then its push. */
async function deleteA1AndPush() {
  await act(async () => {
    await hooks.delAccount.mutateAsync('a1');
  });
  await pushChanges('u');
}

const TXN = {
  accountId: 'a1',
  txnDate: '2026-10-15',
  payee: 'Grocer',
  amount: -12.34,
  status: 'pending' as const,
};

describe('a write into an account this device has deleted (#163)', () => {
  // A register re-opened, online: the delete's push has uploaded the
  // tombstone and removed a1 here before the register can be re-opened.
  // Before #163 the create resolved; each push sent id-1 and the server
  // refused it ("account a1 is deleted", 23503, no hint); id-1 stayed
  // pending, counted by the reset guard.
  it('W1: a register re-opened after the delete uploaded: the new transaction is refused and nothing stays pending', async () => {
    await deleteA1AndPush();
    let err: string | null = null;
    await act(async () => {
      err = await rejection(hooks.create.mutateAsync(TXN));
    });
    await pushChanges('u');
    await pushChanges('u');

    expect({
      err,
      local: local('transactions'),
      unsynced: unsynced(),
      server: server('transactions'),
      refusals: refusals(),
    }).toEqual({
      err: expect.stringMatching(GONE),
      local: [],
      unsynced: 0,
      server: ['t1:tombstoned@a1'],
      refusals: [],
    });
  });

  // The issue's own symptom, through the reset itself: with id-1 pending
  // forever, "Reset & re-download" refused on every attempt ("Couldn't
  // upload 1 unsynced change(s) — reset cancelled so they aren't lost.").
  // Refused at the create, the row is never written, and the reset runs.
  it('W1b: after the refused create, "Reset & re-download" runs', async () => {
    wireSqliteSyncMeta(ctx.adapter);
    await deleteA1AndPush();
    let err: string | null = null;
    await act(async () => {
      err = await rejection(hooks.create.mutateAsync(TXN));
    });
    await pushChanges('u');
    const reset = await rejection(resetLocalData('u'));

    expect({
      err,
      reset,
      accounts: local('accounts'),
      txns: local('transactions'),
    }).toEqual({
      err: expect.stringMatching(GONE),
      reset: null,
      accounts: ['a2:synced'],
      txns: [],
    });
  });

  // The same, before the delete's push has run (in flight, failing, or
  // offline with the delete applied): a1 is still here, marked deleted.
  it('W2: a register re-opened before the delete uploaded: refused in its own words, and the push sends only the delete', async () => {
    await act(async () => {
      await hooks.delAccount.mutateAsync('a1');
    });
    let err: string | null = null;
    await act(async () => {
      err = await rejection(hooks.create.mutateAsync(TXN));
    });
    await pushChanges('u');

    expect({
      err,
      local: local('transactions'),
      unsynced: unsynced(),
      server: {
        accounts: server('accounts'),
        transactions: server('transactions'),
      },
      refusals: refusals(),
    }).toEqual({
      err: expect.stringMatching(DELETED_HERE),
      local: [],
      unsynced: 0,
      server: {
        accounts: ['a1:tombstoned', 'a2:live'],
        transactions: ['t1:tombstoned@a1'],
      },
      refusals: [],
    });
  });

  // The register's transfer button: from the dead a1 into the live a2.
  // Before #163 both legs went in; the a1 leg was refused for good and the
  // a2 leg uploaded alone, live on the server with its link dangling.
  it('W3: a transfer out of the deleted account is refused, and neither leg reaches the server', async () => {
    await deleteA1AndPush();
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    let err: string | null = null;
    await act(async () => {
      err = await rejection(
        hooks.transfer.mutateAsync({
          fromAccountId: 'a1',
          toAccountId: 'a2',
          fromAccountName: '',
          toAccountName: 'Savings',
          amount: 50,
          txnDate: '2026-10-15',
        })
      );
    });
    await pushChanges('u');

    expect({
      err,
      local: local('transactions'),
      unsynced: unsynced(),
      server: server('transactions'),
      refusals: refusals(),
      // The register that opened the transfer reads ['account', 'a1'], and
      // the pickers ['accounts']: a refused transfer refetches both.
      refetched: invalidate.mock.calls.map((c) => c[0]?.queryKey),
    }).toEqual({
      err: expect.stringMatching(
        /The account you are transferring from no longer exists on this device, so the transfer was not saved\./
      ),
      local: [],
      unsynced: 0,
      server: ['t1:tombstoned@a1'],
      refusals: [],
      refetched: expect.arrayContaining([['account', 'a1'], ['accounts']]),
    });
  });

  it('W4: a rule for the deleted account is refused, and nothing stays pending', async () => {
    await deleteA1AndPush();
    let err: string | null = null;
    await act(async () => {
      err = await rejection(
        hooks.rule.mutateAsync({
          accountId: 'a1',
          frequency: 'monthly',
          nextDate: '2026-11-01',
          template: {
            payee: 'Rent',
            amount: -1500,
            checkNumber: null,
            memo: null,
            splits: [],
          },
        })
      );
    });
    await pushChanges('u');

    expect({
      err,
      local: local('recurring_rules'),
      unsynced: unsynced(),
      server: server('recurring_rules'),
      refusals: refusals(),
    }).toEqual({
      err: expect.stringMatching(
        /This account no longer exists on this device, so the rule was not created\./
      ),
      local: [],
      unsynced: 0,
      server: [],
      refusals: [],
    });
  });

  // Deleted on another device and pulled here before the write: a1 is gone
  // from this device, which knows it. Before #163 the write went in and was
  // refused by the server for good.
  it('W5: an account deleted elsewhere whose tombstone was pulled: the write is refused', async () => {
    ctx.store.accounts[0] = {
      ...ctx.store.accounts[0],
      deleted_at: ELSEWHERE_AT,
      updated_at: ELSEWHERE_AT,
    };
    ctx.store.transactions[0] = {
      ...ctx.store.transactions[0],
      deleted_at: ELSEWHERE_AT,
      updated_at: ELSEWHERE_AT,
    };
    await pullChanges('u');
    const pulled = local('accounts');
    let err: string | null = null;
    await act(async () => {
      err = await rejection(hooks.create.mutateAsync(TXN));
    });
    await pushChanges('u');

    expect({
      pulled,
      err,
      local: local('transactions'),
      unsynced: unsynced(),
      refusals: refusals(),
    }).toEqual({
      pulled: ['a2:synced'],
      err: expect.stringMatching(GONE),
      local: [],
      unsynced: 0,
      refusals: [],
    });
  });

  // Offline, the account Delete and a Create into it both wait for the
  // network; on reconnect TanStack continues them together. Whichever write
  // lands first (read, not assumed): a create that lands first is taken by
  // the delete with the account's other rows, and one that lands after it is
  // refused. Either way nothing is left pending. Green before #163, as
  // measured here: the create's plain INSERT landed before the delete's
  // queued transaction.
  it('W6 (pin): Delete then Create offline, resumed together: nothing stays pending, whatever the order', async () => {
    const order: string[] = [];
    const real = ctx.adapter.runAsync.bind(ctx.adapter);
    (ctx.adapter as any).runAsync = async (sql: string, params: any[] = []) => {
      if (/^\s*INSERT INTO transactions/.test(sql)) order.push('create');
      else if (/^UPDATE accounts SET _sync_status = 'deleted'/.test(sql)) {
        order.push('delete');
      }
      return real(sql, params);
    };
    onlineManager.setOnline(false);
    let delDone: Promise<string | null> | null = null;
    let createDone: Promise<string | null> | null = null;
    await act(async () => {
      delDone = rejection(hooks.delAccount.mutateAsync('a1'));
      createDone = rejection(hooks.create.mutateAsync(TXN));
    });
    const paused = qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state.isPaused);
    let outcomes: (string | null)[] = [];
    await act(async () => {
      onlineManager.setOnline(true);
      outcomes = await Promise.all([delDone!, createDone!]);
    });
    await pushChanges('u');

    expect({
      paused,
      deleted: outcomes[0],
      created:
        order[0] === 'create'
          ? outcomes[1] === null
          : DELETED_HERE.test(outcomes[1] ?? ''),
      local: local('transactions'),
      unsynced: unsynced(),
      server: server('accounts'),
      refusals: refusals(),
    }).toEqual({
      paused: [true, true],
      deleted: null,
      created: true,
      local: [],
      unsynced: 0,
      server: ['a1:tombstoned', 'a2:live'],
      refusals: [],
    });
  });

  it('W7 (pin): a live account takes the transaction and the push uploads it', async () => {
    let err: string | null = 'not run';
    await act(async () => {
      err = await rejection(
        hooks.create.mutateAsync({ ...TXN, accountId: 'a2' })
      );
    });
    await pushChanges('u');

    expect({
      err,
      local: local('transactions'),
      server: server('transactions'),
    }).toEqual({
      err: null,
      local: ['id-1:synced', 't1:synced'],
      server: ['t1:live@a1', 'id-1:live@a2'],
    });
  });

  // The boundary (#115), not closed here: another device has deleted a1,
  // and this device has not pulled its tombstone. Nothing here can know, so
  // the write goes in, and the server refuses it for good: the born-dead row
  // of CONTRIBUTING's Known Issues, which Settings now lists (#115). This is
  // also the fixture's model of 005's trigger, through the real push.
  it('W8 (pin, boundary #115): deleted elsewhere and not yet pulled: the write goes in and the server refuses it with a hint-less 23503', async () => {
    ctx.store.accounts[0] = {
      ...ctx.store.accounts[0],
      deleted_at: ELSEWHERE_AT,
      updated_at: ELSEWHERE_AT,
    };
    // The server's cascade stamped a1's transaction with it.
    ctx.store.transactions[0] = {
      ...ctx.store.transactions[0],
      deleted_at: ELSEWHERE_AT,
      updated_at: ELSEWHERE_AT,
    };
    let err: string | null = 'not run';
    await act(async () => {
      err = await rejection(hooks.create.mutateAsync(TXN));
    });
    await pushChanges('u');
    await pushChanges('u');

    expect({
      err,
      local: local('transactions'),
      unsynced: unsynced(),
      server: server('transactions'),
      refusals: refusals(),
    }).toEqual({
      err: null,
      local: ['id-1:pending', 't1:synced'],
      unsynced: 1,
      server: ['t1:tombstoned@a1'],
      refusals: [
        '[sync] push transactions id-1 rejected: 23503 account a1 is deleted',
        '[sync] push transactions id-1 rejected: 23503 account a1 is deleted',
      ],
    });
  });
});

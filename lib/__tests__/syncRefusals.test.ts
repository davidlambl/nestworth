// Rows the push can never upload as they are (#115), through the real push.
//
// A transaction or rule written under an account another device deleted is
// refused by the server with a hint-less 23503 -- 005's trigger while the
// account is tombstoned, the foreign key once it is purged -- and the push
// leaves it 'pending' on purpose (stamping it dead would destroy what the
// user typed). So does a rule whose template this device cannot prepare
// (#129), and a row whose own data the server refuses (a day-first date the
// old CSV import wrote, 22008). Before #115 the push only warned and went
// on: nothing remembered the refusal, Settings counted the row as "waiting to
// upload" for ever, and the reset refused over it with "Check your
// connection", which no connection clears. Now the push records each such
// row under one per-user sync_meta key, the status store counts them apart
// and lists them, and the reset's refusal says to move, edit or discard them.
//
// What must NOT change: the push's handling of the row and of every other row
// (each pending row is its own upsert, so a refused row holds back nothing
// else), and a transient failure is never remembered.
//
// This file imports only the engine, the status store and the fixture, so it
// loads on the code before #115: that is where its regression tests were
// proven red. The fixture's foreign key and row-error models came with it.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { setSyncMeta } from '../db';
import { fullSync, pushChanges, resetLocalData } from '../sync';
import { getSyncSnapshot, refreshSyncState, setLastError } from '../syncStatus';
import {
  inheritRefusal,
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  toPgTimestamp,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When another device deleted a1, as the server stamped it. */
const ELSEWHERE_AT = '2026-10-14T09:00:00+00:00';
/** When the rows below were written offline. */
const WRITTEN_AT = '2026-10-15T08:00:00.000Z';
const KEY = 'push_refusals:u';

let ctx: ReturnType<typeof wireSyncMocks>;
let warnings: string[];
let spies: jest.SpyInstance[];

beforeEach(async () => {
  ctx = wireSyncMocks();
  setLastError(null);
  warnings = [];
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    }),
  ];
  // a1 deleted on another device, its tombstone not pulled here yet; a2 and
  // a3 live. All three synced here.
  ctx.store.accounts = [
    remoteAccount({
      id: 'a1',
      name: 'Old',
      deleted_at: ELSEWHERE_AT,
      updated_at: ELSEWHERE_AT,
    }),
    remoteAccount({
      id: 'a2',
      name: 'Savings',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
    remoteAccount({
      id: 'a3',
      name: 'Brokerage',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  for (const [id, name] of [
    ['a1', 'Old'],
    ['a2', 'Savings'],
    ['a3', 'Brokerage'],
  ]) {
    await insertLocalAccount(ctx.adapter, { id, name, updated_at: SYNCED_AT });
  }
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  ctx.adapter._sqlite.close();
});

/** A transaction written offline, pending. */
function txn(id: string, account: string, extra: Record<string, unknown> = {}) {
  return insertLocalTxn(ctx.adapter, {
    id,
    account_id: account,
    payee: `Payee ${id}`,
    amount: -12.34,
    txn_date: '2026-10-15',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
    ...extra,
  });
}

/** The key's entries, reduced to what the tests read. */
function remembered(key = KEY): string[] {
  const raw = ctx.meta.get(key);
  if (raw === undefined) return ['<no key>'];
  let entries: any[];
  try {
    entries = JSON.parse(raw);
  } catch {
    return [`<unreadable ${raw}>`];
  }
  return entries.map(
    (e) =>
      `${e.table}:${e.id}:${e.kind}:${e.code}@${e.accountId}` +
      (e.accountName ? `(${e.accountName})` : '')
  );
}

/** The status store's refusal fields after a refresh for `user`. */
async function status(user = 'u') {
  await refreshSyncState(user);
  const s: any = getSyncSnapshot();
  return {
    pending: s.pendingCount,
    refused: s.refusedCount,
    refusedSplits: s.refusedSplits,
    rows: (s.refusedRows ?? []).map(
      (r: any) =>
        `${r.table}:${r.id}:${r.kind}@${r.accountName ?? '?'}` +
        (r.table === 'transactions' ? `:${r.payee}:${r.amount}` : '')
    ),
    user: s.refusedUserId,
  };
}

const local = (table: string) =>
  (
    ctx.adapter._sqlite
      .prepare(`SELECT id, account_id, _sync_status FROM ${table} ORDER BY id`)
      .all() as any[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.account_id}`);

const server = (table: string) =>
  (ctx.store[table] as any[]).map(
    (r) =>
      `${r.id}:${r.deleted_at != null ? 'tombstoned' : 'live'}@${r.account_id}`
  );

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => String(e)
  );

describe('rows the push can never upload are remembered (#115)', () => {
  it('R1: a transaction and a rule under an account deleted elsewhere are listed apart from the rows waiting to upload', async () => {
    await txn('t-dead', 'a1');
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 't-dead',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await txn('t-ok', 'a2');
    await insertLocalRule(ctx.adapter, {
      id: 'r-dead',
      account_id: 'a1',
      template: { payee: 'Rent', amount: -1500 },
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect({
      local: local('transactions'),
      rules: local('recurring_rules'),
      remembered: remembered(),
      status: await status(),
    }).toEqual({
      local: ['t-dead:pending@a1', 't-ok:synced@a2'],
      rules: ['r-dead:pending@a1'],
      remembered: [
        'recurring_rules:r-dead:account:23503@a1(Old)',
        'transactions:t-dead:account:23503@a1(Old)',
      ],
      status: {
        // t-dead, its split line and the rule: nothing else is waiting.
        pending: 3,
        refused: 2,
        refusedSplits: 1,
        rows: [
          'transactions:t-dead:account@Old:Payee t-dead:-12.34',
          'recurring_rules:r-dead:account@Old',
        ],
        user: 'u',
      },
    });
  });

  it('R2: a child of a purged account (the foreign key) is listed, by the name the push recorded once the account is gone here', async () => {
    // Purged on the server; this device still has a1 when it first pushes.
    ctx.store.accounts = ctx.store.accounts.filter((a: any) => a.id !== 'a1');
    ctx.installSupabase({ foreignKeys: true });
    await txn('t-fk', 'a1');

    await pushChanges('u');
    const first = remembered();
    // The pull's full read no longer finds a1 and removes it here; the next
    // push meets the foreign key again, with no account row to name it by.
    await fullSync('u');
    await pushChanges('u');

    expect({
      first,
      accounts: ctx.adapter._sqlite
        .prepare('SELECT id FROM accounts ORDER BY id')
        .all(),
      remembered: remembered(),
      status: await status(),
      refusal: warnings.filter((w) => /t-fk rejected/.test(w))[0],
    }).toEqual({
      first: ['transactions:t-fk:account:23503@a1(Old)'],
      accounts: [{ id: 'a2' }, { id: 'a3' }],
      remembered: ['transactions:t-fk:account:23503@a1(Old)'],
      status: {
        pending: 1,
        refused: 1,
        refusedSplits: 0,
        rows: ['transactions:t-fk:account@Old:Payee t-fk:-12.34'],
        user: 'u',
      },
      refusal:
        '[sync] push transactions t-fk rejected: 23503 insert or update on table "transactions" violates foreign key constraint "transactions_account_id_fkey"',
    });
  });

  it('R3: a rule whose template this device cannot prepare (#129) is listed', async () => {
    await insertLocalRule(ctx.adapter, {
      id: 'r-bad',
      account_id: 'a2',
      template: '{oops',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect({ remembered: remembered(), status: await status() }).toEqual({
      remembered: ['recurring_rules:r-bad:unprepared:@a2'],
      status: {
        pending: 1,
        refused: 1,
        refusedSplits: 0,
        rows: ['recurring_rules:r-bad:unprepared@Savings'],
        user: 'u',
      },
    });
  });

  it('R4: a row whose own data the server refuses (a day-first date from the old import, 22008) is listed', async () => {
    ctx.installSupabase({
      rowErrors: new Map([
        [
          't-date',
          {
            code: '22008',
            message: 'date/time field value out of range: "2026-15-01"',
            details: null,
            hint: 'Perhaps you need a different "datestyle" setting.',
          },
        ],
      ]),
    });
    await txn('t-date', 'a2', { txn_date: '2026-15-01' });

    await pushChanges('u');

    expect({ remembered: remembered(), status: await status() }).toEqual({
      remembered: ['transactions:t-date:rejected:22008@a2'],
      status: {
        pending: 1,
        refused: 1,
        refusedSplits: 0,
        rows: ['transactions:t-date:rejected@Savings:Payee t-date:-12.34'],
        user: 'u',
      },
    });
  });

  // A pin (green before #115, when nothing was remembered at all): every
  // answer the next push may not get again is left alone.
  it('R5 (pin): a transient failure is never remembered: no network, a timeout, RLS, a missing column, PostgREST, a serialization failure', async () => {
    const transient: [string, any][] = [
      [
        't-net',
        {
          message: 'TypeError: Failed to fetch',
          details: '',
          hint: '',
          code: '',
        },
      ],
      [
        't-abort',
        {
          message: 'AbortError: The operation was aborted.',
          details: '',
          hint: 'Request was aborted (timeout or manual cancellation)',
          code: '',
        },
      ],
      [
        't-rls',
        {
          code: '42501',
          message:
            'new row violates row-level security policy for table "transactions"',
        },
      ],
      [
        't-col',
        { code: '42703', message: 'column "deleted_at" does not exist' },
      ],
      ['t-jwt', { code: 'PGRST301', message: 'JWT expired' }],
      ['t-ser', { code: '40001', message: 'could not serialize access' }],
      [
        't-time',
        {
          code: '57014',
          message: 'canceling statement due to statement timeout',
        },
      ],
    ];
    ctx.installSupabase({ rowErrors: new Map(transient) });
    for (const [id] of transient) await txn(id, 'a2');

    await pushChanges('u');

    expect({
      local: local('transactions').every((r) => r.includes(':pending@')),
      remembered: remembered(),
      refused: (await status()).refused ?? 0,
    }).toEqual({ local: true, remembered: ['<no key>'], refused: 0 });
  });

  it('R5b: a push that gets only transient answers does not forget what an earlier one was told', async () => {
    await txn('t-dead', 'a1');
    await pushChanges('u');
    ctx.installSupabase({ offline: true });

    await pushChanges('u');

    expect({
      remembered: remembered(),
      refused: (await status()).refused,
    }).toEqual({
      remembered: ['transactions:t-dead:account:23503@a1(Old)'],
      refused: 1,
    });
  });

  // The W-tests' property (#163), with everything else a push does in the
  // same run: green before #115, and it must stay green.
  it('R6 (pin): the refused row holds back nothing else, and the push warns as before', async () => {
    await txn('t-a', 'a2');
    await txn('t-dead', 'a1');
    await txn('t-b', 'a3');
    await insertLocalRule(ctx.adapter, {
      id: 'r-ok',
      account_id: 'a2',
      template: { payee: 'Gym', amount: -40 },
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    ctx.store.transactions = [
      {
        id: 't-gone',
        user_id: 'u',
        account_id: 'a2',
        updated_at: toPgTimestamp(SYNCED_AT),
      },
    ];
    await insertLocalTxn(ctx.adapter, {
      id: 't-gone',
      account_id: 'a2',
      updated_at: SYNCED_AT,
      _sync_status: 'deleted',
    });

    await pushChanges('u');
    await pushChanges('u');

    expect({
      local: local('transactions'),
      rules: local('recurring_rules'),
      server: server('transactions'),
      warnings: warnings.filter((w) => /rejected|skipped/.test(w)),
    }).toEqual({
      local: ['t-a:synced@a2', 't-b:synced@a3', 't-dead:pending@a1'],
      rules: ['r-ok:synced@a2'],
      server: ['t-gone:tombstoned@a2', 't-a:live@a2', 't-b:live@a3'],
      warnings: [
        '[sync] push transactions t-dead rejected: 23503 account a1 is deleted',
        '[sync] push transactions t-dead rejected: 23503 account a1 is deleted',
      ],
    });
  });

  it('R7: a moved row leaves the list at once, waits to upload, and the push uploads it and forgets it', async () => {
    await txn('t-dead', 'a1');
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 't-dead',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await pushChanges('u');
    // The move's statement, as lib/refusedRowActions.ts writes it.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET account_id = 'a3', updated_at = '2026-10-16T10:00:00.000Z', _sync_status = 'pending' WHERE id = 't-dead'"
      )
      .run();
    const moved = await status();

    await pushChanges('u');

    expect({
      moved,
      local: local('transactions'),
      server: server('transactions'),
      splits: (ctx.store.transaction_splits as any[]).map((s) => s.id),
      remembered: remembered(),
    }).toEqual({
      moved: { pending: 2, refused: 0, refusedSplits: 0, rows: [], user: 'u' },
      local: ['t-dead:synced@a3'],
      server: ['t-dead:live@a3'],
      splits: ['s1'],
      remembered: [],
    });
  });

  it('R8: a discarded row leaves the list at once, and the push removes it and its split lines here, sending nothing the server keeps', async () => {
    await txn('t-dead', 'a1');
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 't-dead',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await pushChanges('u');
    // The discard's statement: the row only, as lib/refusedRowActions.ts.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE transactions SET _sync_status = 'deleted', updated_at = '2026-10-16T10:00:00.000Z' WHERE id = 't-dead'"
      )
      .run();
    const discarded = await status();

    await pushChanges('u');

    expect({
      discarded,
      local: local('transactions'),
      splits: ctx.adapter._sqlite
        .prepare('SELECT COUNT(*) AS n FROM transaction_splits')
        .get(),
      server: server('transactions'),
      remembered: remembered(),
    }).toEqual({
      discarded: {
        pending: 2,
        refused: 0,
        refusedSplits: 0,
        rows: [],
        user: 'u',
      },
      local: [],
      splits: { n: 0 },
      server: [],
      remembered: [],
    });
  });

  it("R9: each account signed in on this device has its own list, and never sees the other's rows", async () => {
    await txn('t-u', 'a1');
    await pushChanges('u');
    // b signs in on the same device: its own account, deleted elsewhere too.
    ctx.store.accounts.push(
      remoteAccount({
        id: 'b1',
        user_id: 'b',
        name: 'B-old',
        deleted_at: ELSEWHERE_AT,
        updated_at: ELSEWHERE_AT,
      })
    );
    await insertLocalAccount(ctx.adapter, {
      id: 'b1',
      user_id: 'b',
      name: 'B-old',
      updated_at: SYNCED_AT,
    });
    await insertLocalTxn(ctx.adapter, {
      id: 't-b',
      user_id: 'b',
      account_id: 'b1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    ctx.installSupabase({ sessionUserId: 'b' });
    await pushChanges('b');
    // A key that names another user's row is not believed either.
    ctx.meta.set(
      KEY,
      JSON.stringify([
        ...JSON.parse(ctx.meta.get(KEY) ?? '[]'),
        ...JSON.parse(ctx.meta.get('push_refusals:b') ?? '[]'),
      ])
    );

    expect({
      u: await status('u'),
      b: await status('b'),
      bKey: remembered('push_refusals:b'),
    }).toEqual({
      u: {
        pending: 1,
        refused: 1,
        refusedSplits: 0,
        rows: ['transactions:t-u:account@Old:Payee t-u:-12.34'],
        user: 'u',
      },
      b: {
        pending: 1,
        refused: 1,
        refusedSplits: 0,
        rows: ['transactions:t-b:account@B-old:Payee:0'],
        user: 'b',
      },
      bKey: ['transactions:t-b:account:23503@b1(B-old)'],
    });
  });

  // A pin: green before #115, when nothing was remembered. The foreign key
  // also answers a row whose account the server does not have YET (its own
  // upload failed this time): that row waits behind its account.
  it('R10 (pin): a 23503 for a row whose account is still waiting to upload here is not listed, and both go up next time', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a4',
      name: 'New',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await txn('t4', 'a4');
    ctx.installSupabase({
      foreignKeys: true,
      failWritesOn: new Set(['accounts']),
    });

    await pushChanges('u');
    const after = {
      remembered: remembered(),
      refused: (await status()).refused ?? 0,
      refusal: warnings.filter((w) => /t4 rejected: 23503/.test(w)).length,
    };
    ctx.installSupabase({ foreignKeys: true });
    await pushChanges('u');

    expect({ after, local: local('transactions') }).toEqual({
      after: { remembered: ['<no key>'], refused: 0, refusal: 1 },
      local: ['t4:synced@a4'],
    });
  });

  it('R11: a stale entry (its row uploaded or gone) is never shown, and the next push drops it', async () => {
    await insertLocalTxn(ctx.adapter, {
      id: 't-synced',
      account_id: 'a2',
      updated_at: SYNCED_AT,
      _sync_status: 'synced',
    });
    await txn('t-wait', 'a2');
    ctx.meta.set(
      KEY,
      JSON.stringify([
        {
          table: 'transactions',
          id: 't-synced',
          updatedAt: SYNCED_AT,
          accountId: 'a2',
          kind: 'rejected',
          code: '22008',
          accountName: null,
          since: SYNCED_AT,
        },
        {
          table: 'transactions',
          id: 't-missing',
          updatedAt: SYNCED_AT,
          accountId: 'a2',
          kind: 'account',
          code: '23503',
          accountName: null,
          since: SYNCED_AT,
        },
        // The right row, but not the version the push was refused.
        {
          table: 'transactions',
          id: 't-wait',
          updatedAt: SYNCED_AT,
          accountId: 'a2',
          kind: 'rejected',
          code: '22008',
          accountName: null,
          since: SYNCED_AT,
        },
      ])
    );
    const before = await status();

    await pushChanges('u');

    expect({ before, remembered: remembered() }).toEqual({
      before: { pending: 1, refused: 0, refusedSplits: 0, rows: [], user: 'u' },
      remembered: [],
    });
  });

  it('R15: a key that is not a list of refusals reads as none and does not stop the push', async () => {
    ctx.meta.set(KEY, '{not json');
    await txn('t-ok', 'a2');
    const before = await status();

    await pushChanges('u');

    expect({
      before,
      local: local('transactions'),
      remembered: remembered(),
    }).toEqual({
      before: { pending: 1, refused: 0, refusedSplits: 0, rows: [], user: 'u' },
      local: ['t-ok:synced@a2'],
      remembered: [],
    });
  });

  it('R16: a refusal keeps the time it was first seen while the row is unchanged, and the account name with its account', async () => {
    await txn('t-dead', 'a1');
    await pushChanges('u');
    const first = JSON.parse(ctx.meta.get(KEY) ?? '[]')[0];
    await pushChanges('u');
    const second = JSON.parse(ctx.meta.get(KEY) ?? '[]')[0];

    expect(second).toEqual(first);
    expect(first).toEqual({
      table: 'transactions',
      id: 't-dead',
      updatedAt: WRITTEN_AT,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: expect.any(String),
    });
  });

  it('R17 (pin): a push refused for want of a session leaves the key as it was', async () => {
    await txn('t-dead', 'a1');
    await pushChanges('u');
    const before = ctx.meta.get(KEY);
    ctx.installSupabase({ anonRejected: true });
    await insertLocalTxn(ctx.adapter, {
      id: 't-more',
      account_id: 'a1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect(ctx.meta.get(KEY)).toBe(before);
  });

  // R19-R22 came from the sync attack on the design (SYNC1-SYNC3, SYNC5).

  it('R19: an account created during a push, after the rules pass read the accounts, keeps its new rows waiting: they are not listed as its account deleted', async () => {
    ctx.installSupabase({ foreignKeys: true });
    await insertLocalRule(ctx.adapter, {
      id: 'r-dead',
      account_id: 'a1',
      template: { payee: 'Rent', amount: -1500 },
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    // Lands after the accounts and rules passes, before the transactions
    // pass reads its pending rows: the user creates an account and its first
    // transaction while this push runs.
    const orig = ctx.adapter.getAllAsync.bind(ctx.adapter);
    let fired = false;
    (ctx.adapter as any).getAllAsync = async (sql: string, params: any[]) => {
      if (
        !fired &&
        /SELECT \* FROM transactions WHERE _sync_status = 'pending'/.test(sql)
      ) {
        fired = true;
        await insertLocalAccount(ctx.adapter, {
          id: 'a4',
          name: 'New',
          updated_at: '2026-10-16T09:00:00.000Z',
          _sync_status: 'pending',
        });
        await insertLocalTxn(ctx.adapter, {
          id: 't-new',
          account_id: 'a4',
          payee: 'First',
          amount: -5,
          txn_date: '2026-10-16',
          updated_at: '2026-10-16T09:00:01.000Z',
          _sync_status: 'pending',
        });
      }
      return orig(sql, params);
    };

    await pushChanges('u');
    const first = { remembered: remembered(), rows: (await status()).rows };
    await pushChanges('u');

    expect({
      first,
      remembered: remembered(),
      local: local('transactions'),
    }).toEqual({
      first: {
        remembered: ['recurring_rules:r-dead:account:23503@a1(Old)'],
        rows: ['recurring_rules:r-dead:account@Old'],
      },
      remembered: ['recurring_rules:r-dead:account:23503@a1(Old)'],
      local: ['t-new:synced@a4'],
    });
  });

  it('R20: an account edited here and deleted elsewhere is dropped by the push, and its born-dead row is listed in that same push, with no name', async () => {
    // a1 carries a rename this device has not pushed; another device deleted it.
    ctx.adapter._sqlite
      .prepare(
        "UPDATE accounts SET name = 'Old (renamed)', updated_at = '2026-10-15T07:00:00.000Z', _sync_status = 'pending' WHERE id = 'a1'"
      )
      .run();
    await insertLocalTxn(ctx.adapter, {
      id: 't-dead',
      account_id: 'a1',
      payee: 'Cash',
      amount: -9,
      txn_date: '2026-10-15',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    await pushChanges('u');

    expect({
      accounts: ctx.adapter._sqlite
        .prepare('SELECT id FROM accounts ORDER BY id')
        .all(),
      remembered: remembered(),
      rows: (await status()).rows,
    }).toEqual({
      accounts: [{ id: 'a2' }, { id: 'a3' }],
      remembered: ['transactions:t-dead:account:23503@a1'],
      rows: ['transactions:t-dead:account@?:Cash:-9'],
    });
  });

  it('R21: a failed write of the key fails neither the push nor the pull; it is warned', async () => {
    await txn('t-dead', 'a1');
    await txn('t-ok', 'a2');
    (setSyncMeta as unknown as jest.Mock).mockImplementation(
      async (k: string, v: string) => {
        if (k === KEY) throw new Error('disk I/O error');
        ctx.meta.set(k, v);
      }
    );

    await fullSync('u');

    expect({
      local: local('transactions'),
      lastError: getSyncSnapshot().lastError,
      pulled: ctx.meta.get('last_pull_at:u') != null,
      warned: warnings.filter((w) =>
        /could not record the rows the push was refused/.test(w)
      ).length,
    }).toEqual({
      local: ['t-dead:pending@a1', 't-ok:synced@a2'],
      lastError: null,
      pulled: true,
      warned: 1,
    });
  });

  it("R22: a rule edited or discarded since leaves the list at once, and a key entry naming another user's rule is not believed", async () => {
    for (const id of ['r-edit', 'r-disc', 'r-keep']) {
      await insertLocalRule(ctx.adapter, {
        id,
        account_id: 'a1',
        template: { payee: id, amount: -1 },
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    await pushChanges('u');
    const before = (await status()).rows;
    ctx.adapter._sqlite
      .prepare(
        "UPDATE recurring_rules SET updated_at = '2026-10-16T08:00:00.000Z' WHERE id = 'r-edit'"
      )
      .run();
    ctx.adapter._sqlite
      .prepare(
        "UPDATE recurring_rules SET _sync_status = 'deleted' WHERE id = 'r-disc'"
      )
      .run();
    // b's rule at the version u's key names, under b (the key is u's, the row b's).
    await insertLocalRule(ctx.adapter, {
      id: 'r-b',
      user_id: 'b',
      account_id: 'b1',
      template: { payee: 'b', amount: -1 },
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    ctx.meta.set(
      KEY,
      JSON.stringify([
        ...JSON.parse(ctx.meta.get(KEY) ?? '[]'),
        {
          table: 'recurring_rules',
          id: 'r-b',
          updatedAt: WRITTEN_AT,
          accountId: 'b1',
          kind: 'account',
          code: '23503',
          accountName: null,
          since: WRITTEN_AT,
        },
      ])
    );

    expect({ before, after: (await status()).rows }).toEqual({
      before: [
        'recurring_rules:r-disc:account@Old',
        'recurring_rules:r-edit:account@Old',
        'recurring_rules:r-keep:account@Old',
      ],
      after: ['recurring_rules:r-keep:account@Old'],
    });
  });
});

describe('the reset says what clears the rows that can never upload (#115)', () => {
  it('R12: over refused rows only, it says to move, edit or discard them, not to check the connection', async () => {
    wireSqliteSyncMeta(ctx.adapter);
    await txn('t-dead', 'a1');
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 't-dead',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    const err = await rejection(resetLocalData('u'));

    expect(err).toBe(
      "Error: Couldn't upload 2 unsynced change(s) — reset cancelled so they aren't lost. They can't be uploaded as they are: move, edit or discard them in Settings first."
    );
    expect(local('transactions')).toEqual(['t-dead:pending@a1']);
  });

  it('R13: over refused rows and rows a connection may still clear, it says both', async () => {
    wireSqliteSyncMeta(ctx.adapter);
    ctx.installSupabase({
      rowErrors: new Map([
        [
          't-slow',
          {
            code: '57014',
            message: 'canceling statement due to statement timeout',
          },
        ],
      ]),
    });
    await txn('t-dead', 'a1');
    await txn('t-slow', 'a2');

    const err = await rejection(resetLocalData('u'));

    expect(err).toBe(
      "Error: Couldn't upload 2 unsynced change(s) — reset cancelled so they aren't lost. Some can't be uploaded as they are: move, edit or discard them in Settings first. Check your connection and try again."
    );
  });

  it('R12b (pin): over rows a connection may clear, the words are as before', async () => {
    wireSqliteSyncMeta(ctx.adapter);
    ctx.installSupabase({ failWritesOn: new Set(['transactions']) });
    await txn('t-net', 'a2');

    const err = await rejection(resetLocalData('u'));

    expect(err).toBe(
      "Error: Couldn't upload 1 unsynced change(s) — reset cancelled so they aren't lost. Check your connection and try again."
    );
  });

  it('R14: the wipe clears the refusals key with the four pull keys', async () => {
    const table = wireSqliteSyncMeta(ctx.adapter);
    // Left by a push before the row was discarded and its discard uploaded.
    table.set(
      KEY,
      JSON.stringify([
        {
          table: 'transactions',
          id: 't-gone',
          updatedAt: WRITTEN_AT,
          accountId: 'a1',
          kind: 'account',
          code: '23503',
          accountName: 'Old',
          since: WRITTEN_AT,
        },
      ])
    );
    table.set('push_refusals:b', '[]');

    const err = await rejection(resetLocalData('u'));

    expect({
      err,
      key: table.get(KEY),
      other: table.get('push_refusals:b'),
    }).toEqual({
      err: null,
      key: undefined,
      other: '[]',
    });
  });

  it('R18 (pin): the inherit refusal the fixture gives is the hint-less one these rows meet', () => {
    expect(inheritRefusal('a1')).toEqual({
      code: '23503',
      message: 'account a1 is deleted',
      details: null,
      hint: null,
    });
  });
});

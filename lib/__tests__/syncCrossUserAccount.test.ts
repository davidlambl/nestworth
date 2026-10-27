// A transaction or a rule filed under another user's account (#189), through
// the real push.
//
// Several accounts sign in on one device in turn and sign-out wipes no local
// rows, so another account's accounts stay on the device. Since #177 every
// creator refuses them (O4 pins it), but a build without that check filed
// the signed-in user's row under the other account's id, and the server took
// it: 001's policy and foreign key look at the row's own user only, and 005's
// trigger reads accounts under the caller's RLS. Migration 010 refuses such a
// row with a hint-less 23503, so the push leaves it pending and #115's list
// offers to move it to one of the user's own accounts. The rows below are
// written straight into SQLite, as such a build wrote them and as they wait
// on a device upgraded since; the fake models 010 (checkAccountOwner).
//
// Own file, importing only the engine, the status store, the refused-row
// writers and the fixture, so it loads on the code before #189: O1 and O2 are
// red there (the old fake stores the row), O3 and O4 are pins.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { pushChanges } from '../sync';
import { getSyncSnapshot, refreshSyncState, setLastError } from '../syncStatus';
import {
  describeRefusal,
  refusedRowActions,
  type RefusedRow,
} from '../syncRefusals';
import { applyRefusedRowMove } from '../refusedRowActions';
import { CREATE_RULE_SQL, CREATE_TRANSACTION_SQL } from '../accountWriteGuard';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalTxn,
  remoteAccount,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When an older build wrote the rows below, offline or unpushed. */
const WRITTEN_AT = '2026-10-15T08:00:00.000Z';
const MOVED_AT = '2026-10-23T09:00:00.000Z';
const KEY = 'push_refusals:u';
/** 010's answer, as PostgREST renders reject_cross_user_account()'s RAISE. */
const REFUSED_B1 = {
  code: '23503',
  message: "account b1 is not this user's",
  details: null,
  hint: null,
};

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
  // u's own a2; b1 is b's, left on this device by b's earlier sign-in.
  ctx.store.accounts = [
    remoteAccount({
      id: 'a2',
      name: 'Savings',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
    remoteAccount({
      id: 'b1',
      user_id: 'b',
      name: 'Theirs',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  await insertLocalAccount(ctx.adapter, {
    id: 'a2',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(ctx.adapter, {
    id: 'b1',
    user_id: 'b',
    name: 'Theirs',
    updated_at: SYNCED_AT,
  });
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  ctx.adapter._sqlite.close();
});

/** u's transaction under `account`, pending, as an older build wrote it. */
function txn(id: string, account: string) {
  return insertLocalTxn(ctx.adapter, {
    id,
    account_id: account,
    payee: `Payee ${id}`,
    amount: -12.34,
    txn_date: '2026-10-15',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
}

function rule(id: string, account: string) {
  return insertLocalRule(ctx.adapter, {
    id,
    account_id: account,
    template: { payee: 'Rent', amount: -1500 },
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
}

const local = (table: string) =>
  (
    ctx.adapter._sqlite
      .prepare(
        `SELECT id, user_id, account_id, _sync_status FROM ${table} ORDER BY id`
      )
      .all() as any[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.account_id}`);

const server = (table: string) =>
  (ctx.store[table] as any[]).map((r) => `${r.id}@${r.account_id}`);

/** The key's entries, reduced to what the tests read. */
function remembered(): string[] {
  const raw = ctx.meta.get(KEY);
  if (raw === undefined) return ['<no key>'];
  return (JSON.parse(raw) as any[]).map(
    (e) =>
      `${e.table}:${e.id}:${e.kind}:${e.code}@${e.accountId}` +
      (e.accountName ? `(${e.accountName})` : '')
  );
}

/** What Settings lists for u, and what each row offers. */
async function listed() {
  await refreshSyncState('u');
  const s: any = getSyncSnapshot();
  return {
    // Whose list it is (#193's snapshotUserId).
    user: s.snapshotUserId,
    refused: s.refusedCount,
    rows: (s.refusedRows as RefusedRow[]).map((r) => {
      const offers = refusedRowActions(r);
      return `${r.table}:${r.id}:${r.kind}@${r.accountName ?? '?'} move=${offers.move} edit=${offers.edit}`;
    }),
    words: (s.refusedRows as RefusedRow[]).map(describeRefusal),
  };
}

describe("a row filed under another user's account (#189)", () => {
  it("O1: a transaction and a rule an older build filed under another user's account are refused, stay pending, and are listed for u to move", async () => {
    await txn('t-x', 'b1');
    await rule('r-x', 'b1');
    await txn('t-ok', 'a2');

    await pushChanges('u');

    expect({
      local: [local('transactions'), local('recurring_rules')],
      server: [server('transactions'), server('recurring_rules')],
      remembered: remembered(),
      listed: await listed(),
      warned: warnings.filter((w) => /rejected/.test(w)),
    }).toEqual({
      local: [['t-ok:synced@a2', 't-x:pending@b1'], ['r-x:pending@b1']],
      server: [['t-ok@a2'], []],
      // No name: the push reads only u's own accounts (#177's rule).
      remembered: [
        'recurring_rules:r-x:account:23503@b1',
        'transactions:t-x:account:23503@b1',
      ],
      listed: {
        user: 'u',
        refused: 2,
        rows: [
          'transactions:t-x:account@? move=true edit=false',
          'recurring_rules:r-x:account@? move=true edit=false',
        ],
        // The 'account' kind's words, unchanged by #189 (its residue: the
        // account was not deleted, it is not u's).
        words: [
          "Its account was deleted, so this transaction can't be uploaded.",
          "Its account was deleted, so this rule can't be uploaded.",
        ],
      },
      warned: [
        `[sync] push recurring_rules r-x rejected: 23503 account b1 is not this user's`,
        `[sync] push transactions t-x rejected: 23503 account b1 is not this user's`,
      ],
    });
  });

  it("O2: moved to one of u's own accounts (#115's Move), the row uploads there and leaves the list", async () => {
    await txn('t-x', 'b1');
    await rule('r-x', 'b1');
    await pushChanges('u');
    const refusedFirst = remembered();

    for (const table of ['transactions', 'recurring_rules'] as const) {
      await applyRefusedRowMove(
        ctx.adapter as any,
        {
          table,
          id: table === 'transactions' ? 't-x' : 'r-x',
          updatedAt: WRITTEN_AT,
          userId: 'u',
        },
        'a2',
        { now: MOVED_AT }
      );
    }
    await pushChanges('u');

    expect({
      refusedFirst,
      local: [local('transactions'), local('recurring_rules')],
      server: [server('transactions'), server('recurring_rules')],
      remembered: remembered(),
      refused: (await listed()).refused,
    }).toEqual({
      refusedFirst: [
        'recurring_rules:r-x:account:23503@b1',
        'transactions:t-x:account:23503@b1',
      ],
      local: [['t-x:synced@a2'], ['r-x:synced@a2']],
      server: [['t-x@a2'], ['r-x@a2']],
      remembered: [],
      refused: 0,
    });
  });

  // Why 010 raises 23503 with no hint: the push's answer to each shape, with
  // the server's refusal injected as the error. All of it is #115's and #98's,
  // green before #189 -- it pins the contract the migration relies on.
  it.each([
    [
      "010's refusal (23503, no hint)",
      REFUSED_B1,
      {
        local: ['t-y:pending@a2'],
        remembered: ['transactions:t-y:account:23503@a2(Savings)'],
        rows: ['transactions:t-y:account@Savings move=true edit=false'],
      },
    ],
    [
      'any other class-23 code (23514)',
      { ...REFUSED_B1, code: '23514' },
      {
        local: ['t-y:pending@a2'],
        remembered: ['transactions:t-y:rejected:23514@a2'],
        rows: ['transactions:t-y:rejected@Savings move=false edit=false'],
      },
    ],
    [
      "008's purged hint",
      { ...REFUSED_B1, hint: 'purged' },
      { local: [], remembered: ['<no key>'], rows: [] },
    ],
  ])(
    'O3 (pin): the push answers %s as the migration expects',
    async (_label, error, expected) => {
      ctx.installSupabase({
        failWritesOn: new Set(['transactions']),
        writeError: error,
      });
      await txn('t-y', 'a2');

      await pushChanges('u');

      expect({
        local: local('transactions'),
        remembered: remembered(),
        rows: (await listed()).rows,
      }).toEqual(expected);
    }
  );

  it("O4 (pin): no current creator files such a row -- #177's guard refuses another user's account on this device, so only a row an older build wrote reaches 010", async () => {
    const created = await ctx.adapter.runAsync(CREATE_TRANSACTION_SQL, [
      't-new',
      'u',
      'b1',
      '2026-10-23',
      'Payee',
      -1,
      null,
      null,
      'pending',
      WRITTEN_AT,
      WRITTEN_AT,
      'b1',
      'u',
    ]);
    const ruled = await ctx.adapter.runAsync(CREATE_RULE_SQL, [
      'r-new',
      'u',
      'b1',
      'monthly',
      '2026-11-01',
      null,
      '{}',
      WRITTEN_AT,
      WRITTEN_AT,
      'b1',
      'u',
    ]);

    expect({
      changes: [created.changes, ruled.changes],
      local: [local('transactions'), local('recurring_rules')],
    }).toEqual({ changes: [0, 0], local: [[], []] });
  });
});

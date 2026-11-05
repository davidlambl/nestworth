// The push sends its rows in runs, one upsert per run (#29), through the real
// push.
//
// Before #29 every pending row was its own upsert, and a parent whose split set
// this device changed two more requests (the splits' DELETE, then their
// INSERT): a 300-row import was 300 round trips one after another. A run is
// ONE statement on the server, all or nothing: the first row any check
// refuses answers for all of it and nothing is stored (the fake models that,
// as measured on the local stack). So a run that fails is sent again row by
// row, and every row must end exactly as it ended before: the same local
// state, the same server rows, the same refusals remembered under
// push_refusals:<user> (#115), the same purged-id drop (#98), the same split
// guard (#97, #20).
//
// Each scenario below asserts the outcome FIRST and the requests LAST. The
// file imports only the engine, the status store and the fixture, so it loads
// on the code before #29: there every outcome assertion holds (the per-row
// push is the reference) and the request assertion is the one that fails.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { supabase } from '../supabase';
import { PUSH_BATCH_SIZE, pushChanges, requestPush } from '../sync';
import { getSyncSnapshot, refreshSyncState, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  toPgTimestamp,
  wireSyncMocks,
  type SupabaseOpts,
} from '../testing/syncFixture';

/** The push's clock, frozen: a refusal's `since` is the push's own time. */
const NOW = '2026-11-04T12:00:00.000Z';
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When the rows below were written offline. */
const WRITTEN_AT = '2026-10-15T08:00:00.000Z';
/** What the server stamps an UPDATE with (the fake's BEFORE UPDATE trigger). */
const SERVER_NOW = '2026-11-04T11:59:59.5+00:00';
const KEY = 'push_refusals:u';

/** 010's answer to a row filed under another user's account. */
const NOT_USERS_B1 = {
  code: '23503',
  message: "account b1 is not this user's",
  details: null,
  hint: null,
};
/** A day-first date the CSV import wrote before #36, as the server refuses it. */
const DAY_FIRST = {
  code: '22008',
  message: 'date/time field value out of range: "31/12/2026"',
  details: null,
  hint: 'Perhaps you need a different "datestyle" setting.',
};
/** A split's amount past numeric(12,2). */
const OVERFLOW = {
  code: '22003',
  message: 'numeric field overflow',
  details:
    'A field with precision 12, scale 2 must round to an absolute value less than 10^10.',
  hint: null,
};

let ctx: ReturnType<typeof wireSyncMocks>;
let warnings: string[];
let spies: jest.SpyInstance[];

beforeEach(async () => {
  // Only Date is frozen: the push and the fake use no timers.
  jest.useFakeTimers({
    now: new Date(NOW),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
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
  // u's a1 and a2, synced; b1 is b's, left on this device by b's sign-in.
  ctx.store.accounts = [
    remoteAccount({ id: 'a1', updated_at: toPgTimestamp(SYNCED_AT) }),
    remoteAccount({
      id: 'a2',
      name: 'Savings',
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
    remoteAccount({
      id: 'b1',
      user_id: 'b',
      name: "b's",
      updated_at: toPgTimestamp(SYNCED_AT),
    }),
  ];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(ctx.adapter, {
    id: 'a2',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  ctx.adapter._sqlite.close();
  jest.useRealTimers();
});

/** A transaction written offline, pending. */
function txn(id: string, extra: Record<string, unknown> = {}) {
  return insertLocalTxn(ctx.adapter, {
    id,
    account_id: 'a1',
    payee: `Payee ${id}`,
    amount: -12.34,
    txn_date: '2026-10-15',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
    ...extra,
  });
}

/** n pending transactions t000, t001, … in rowid order. */
async function txns(n: number, extra: Record<string, unknown> = {}) {
  const ids = Array.from(
    { length: n },
    (_, i) => `t${String(i).padStart(3, '0')}`
  );
  for (const id of ids) {
    await txn(id, extra);
  }
  return ids;
}

/**
 * Every write the push sends from here on, in order: the table, the verb and
 * its size — an upsert of one row (`one`, the request every row was before
 * #29) or of an array (`[n]`), an INSERT of n rows, a DELETE or an UPDATE by
 * one id (`=`) or by a list (`in n`). Install it AFTER installSupabase,
 * whose `from` it wraps.
 */
function recordWrites(): string[] {
  const seen: string[] = [];
  const realFrom = (supabase as any).from;
  (supabase as any).from = (table: string) => {
    const b = realFrom(table);
    const upsert = b.upsert;
    b.upsert = (rows: any, o: any) => {
      seen.push(
        `upsert ${table} ${Array.isArray(rows) ? `[${rows.length}]` : 'one'}`
      );
      return upsert(rows, o);
    };
    const insert = b.insert;
    b.insert = (rows: any, o?: any) => {
      seen.push(`insert ${table} ${Array.isArray(rows) ? rows.length : 1}`);
      return insert(rows, o);
    };
    for (const verb of ['delete', 'update'] as const) {
      const real = b[verb];
      b[verb] = (...args: any[]) => {
        const w = real(...args);
        const eq = w.eq;
        const inn = w.in;
        w.eq = (c: string, v: any) => {
          seen.push(`${verb} ${table} ${c} =`);
          return eq(c, v);
        };
        w.in = (c: string, vs: any[]) => {
          seen.push(`${verb} ${table} ${c} in ${vs.length}`);
          return inn(c, vs);
        };
        return w;
      };
    }
    return b;
  };
  return seen;
}

/** Runs of identical requests collapsed: `upsert transactions one ×300`. */
function collapse(seen: string[]): string[] {
  const out: string[] = [];
  let last: string | null = null;
  let n = 0;
  for (const s of [...seen, '\u0000']) {
    if (s === last) {
      n++;
      continue;
    }
    if (last !== null) out.push(n > 1 ? `${last} ×${n}` : last);
    last = s;
    n = 1;
  }
  return out;
}

/** `id:status@updated_at` for every local row of `table`, by id. */
function local(table: string): string[] {
  return (
    ctx.adapter._sqlite
      .prepare(`SELECT id, _sync_status, updated_at FROM ${table} ORDER BY id`)
      .all() as any[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}`);
}

/** `id:live|dead@updated_at` for every server row of `table`, by id. */
function server(table: string): string[] {
  return [...(ctx.store[table] ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(
      (r) =>
        `${r.id}:${r.deleted_at == null ? 'live' : 'dead'}@${r.updated_at ?? ''}`
    );
}

/** The key's entries as the push wrote them, parsed. */
function remembered(): unknown {
  const raw = ctx.meta.get(KEY);
  return raw === undefined ? '<no key>' : JSON.parse(raw);
}

/** The warnings about a row, as the per-row push printed them. */
function rowWarnings(): string[] {
  return warnings.filter((w) =>
    / rejected: |dropping the local copy| not sent: /.test(w)
  );
}

/** One remembered refusal, as createRefusalLog writes it at NOW. */
function entry(
  id: string,
  kind: 'account' | 'rejected' | 'unprepared',
  code: string,
  accountId: string,
  table: 'transactions' | 'recurring_rules' = 'transactions',
  accountName: string | null = null
) {
  return {
    table,
    id,
    updatedAt: WRITTEN_AT,
    accountId,
    kind,
    code,
    accountName,
    since: NOW,
  };
}

describe('a run that the server takes whole', () => {
  it('B1: each row is marked synced with ITS server stamp, whatever order the answer comes back in', async () => {
    // t1 and t3 the server already holds (an UPDATE: its trigger stamps
    // SERVER_NOW), t2 and t4 are new (an INSERT keeps this device's stamp,
    // re-rendered). The answer comes back reversed: matched by position, t1
    // would take t4's stamp.
    for (const id of ['t1', 't2', 't3', 't4']) {
      await txn(id);
    }
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: toPgTimestamp(SYNCED_AT) }),
      remoteTxn({ id: 't3', updated_at: toPgTimestamp(SYNCED_AT) }),
    ];
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      answerRows: (rows) => [...rows].reverse(),
    });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      server: server('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [
        `t1:synced@${SERVER_NOW}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${SERVER_NOW}`,
        `t4:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      server: [
        `t1:live@${SERVER_NOW}`,
        `t2:live@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:live@${SERVER_NOW}`,
        `t4:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: '<no key>',
      warned: [],
    });
    expect(collapse(writes)).toStrictEqual(['upsert transactions [4]']);
  });

  it('B2: a row the answer leaves out is sent alone, never taken for uploaded', async () => {
    // A server that cuts a write's answer short (PostgREST's max-rows did
    // before v10) stored t2 like the others; with no answer for it the push
    // cannot know its stamp or whether it landed on a tombstone, so t2 gets
    // its own request, which answers.
    for (const id of ['t1', 't2', 't3']) {
      await txn(id);
    }
    ctx.store.transactions = [
      remoteTxn({
        id: 't2',
        updated_at: toPgTimestamp(SYNCED_AT),
        deleted_at: '2026-11-01T00:00:00+00:00',
      }),
    ];
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      answerRows: (rows) => rows.filter((r) => r.id !== 't2'),
    });
    const writes = recordWrites();

    await pushChanges('u');

    // t2 landed on another device's tombstone: delete wins, it goes here too.
    expect({
      local: local('transactions'),
      server: server('transactions'),
    }).toStrictEqual({
      local: [
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      server: [
        `t1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `t2:dead@${SERVER_NOW}`,
        `t3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one',
    ]);
  });
});

describe('a run that the server refuses, sent again row by row', () => {
  it('B3: one purged id: the others are synced, the purged one is dropped here, nothing is remembered', async () => {
    await txn('t1');
    await txn('t2');
    await insertLocalSplit(ctx.adapter, {
      id: 's2',
      transaction_id: 't2',
      updated_at: WRITTEN_AT,
      _sync_status: 'synced',
    });
    await txn('t3');
    ctx.installSupabase({ purgedIds: new Set(['t2']) });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      server: server('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
      lastError: getSyncSnapshot().lastError,
    }).toStrictEqual({
      local: [
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      splits: [],
      server: [
        `t1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: '<no key>',
      warned: [
        '[sync] push transactions t2: deleted elsewhere and purged; dropping the local copy',
      ],
      lastError: null,
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one ×3',
    ]);
  });

  it("B4: one row under another user's account: the 'account' kind, remembered as the per-row push remembered it", async () => {
    await txn('t1');
    await txn('t-x', { account_id: 'b1' });
    await txn('t3');
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      server: server('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [
        `t-x:pending@${WRITTEN_AT}`,
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      server: [
        `t1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: [entry('t-x', 'account', '23503', 'b1')],
      warned: [
        `[sync] push transactions t-x rejected: 23503 ${NOT_USERS_B1.message}`,
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one ×3',
    ]);
  });

  it("B5: one row refused for its own data (22008): the 'rejected' kind", async () => {
    await txn('t1');
    await txn('t-date');
    await txn('t3');
    ctx.installSupabase({ rowErrors: new Map([['t-date', DAY_FIRST]]) });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [
        `t-date:pending@${WRITTEN_AT}`,
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: [entry('t-date', 'rejected', '22008', 'a1')],
      warned: [
        `[sync] push transactions t-date rejected: 22008 ${DAY_FIRST.message}`,
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one ×3',
    ]);
  });

  it('B6: two bad rows of three kinds of answer in one run, each recorded in row order', async () => {
    // The run's own answer is t5's 22008: Postgres looks for a value it
    // cannot cast in the whole body before it takes any row through 010's or
    // 008's guard. Every row still gets its own answer.
    await txn('t1', { account_id: 'b1' });
    await txn('t2');
    await txn('t3');
    await txn('t4', { account_id: 'b1' });
    await txn('t5');
    ctx.installSupabase({
      purgedIds: new Set(['t3']),
      rowErrors: new Map([['t5', DAY_FIRST]]),
    });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      server: server('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [
        `t1:pending@${WRITTEN_AT}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t4:pending@${WRITTEN_AT}`,
        `t5:pending@${WRITTEN_AT}`,
      ],
      server: [`t2:live@${toPgTimestamp(WRITTEN_AT)}`],
      remembered: [
        entry('t1', 'account', '23503', 'b1'),
        entry('t4', 'account', '23503', 'b1'),
        entry('t5', 'rejected', '22008', 'a1'),
      ],
      warned: [
        `[sync] push transactions t1 rejected: 23503 ${NOT_USERS_B1.message}`,
        '[sync] push transactions t3: deleted elsewhere and purged; dropping the local copy',
        `[sync] push transactions t4 rejected: 23503 ${NOT_USERS_B1.message}`,
        `[sync] push transactions t5 rejected: 22008 ${DAY_FIRST.message}`,
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [5]',
      'upsert transactions one ×5',
    ]);
  });

  it('B7: the network down: every row stays pending and an earlier refusal stays remembered', async () => {
    // t-date was refused for its date by the last push and is unchanged
    // since: it goes alone. The run of the other two fails on the network,
    // and so does each of its rows on its own: nothing is marked synced, and
    // a push that learned nothing forgets nothing (#115's retry).
    await txn('t1');
    await txn('t3');
    await txn('t-date');
    const before = [entry('t-date', 'rejected', '22008', 'a1')];
    ctx.meta.set(KEY, JSON.stringify(before));
    ctx.installSupabase({ offline: true });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      server: server('transactions'),
      remembered: remembered(),
      warned: rowWarnings(),
      lastError: getSyncSnapshot().lastError,
    }).toStrictEqual({
      local: [
        `t-date:pending@${WRITTEN_AT}`,
        `t1:pending@${WRITTEN_AT}`,
        `t3:pending@${WRITTEN_AT}`,
      ],
      server: [],
      remembered: before,
      warned: [
        '[sync] push transactions t1 rejected: undefined network unreachable',
        '[sync] push transactions t3 rejected: undefined network unreachable',
        '[sync] push transactions t-date rejected: undefined network unreachable',
      ],
      lastError: null,
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [2]',
      'upsert transactions one ×3',
    ]);
  });

  it('B8: the network gone after the first run: the run that failed has nothing marked synced', async () => {
    const ids = await txns(150);
    const remote: SupabaseOpts = {
      onAfterUpsert: async () => {
        remote.offline = true;
      },
    };
    ctx.installSupabase(remote);
    const writes = recordWrites();

    await pushChanges('u');

    const synced = local('transactions').filter((r) => /:synced@/.test(r));
    const pending = local('transactions').filter((r) => /:pending@/.test(r));
    expect({
      synced: synced.length,
      pending: pending.length,
      firstPending: pending[0],
      lastSynced: synced[synced.length - 1],
      server: ctx.store.transactions.length,
    }).toStrictEqual({
      synced: 100,
      pending: 50,
      firstPending: `${ids[100]}:pending@${WRITTEN_AT}`,
      lastSynced: `${ids[99]}:synced@${toPgTimestamp(WRITTEN_AT)}`,
      server: 100,
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [100]',
      'upsert transactions [50]',
      'upsert transactions one ×50',
    ]);
  });

  it('B9: a row refused by the last push, at the version it still has, goes alone and its neighbours stay one run', async () => {
    await txn('t1');
    await txn('t2');
    await txn('t-x', { account_id: 'b1' });
    await txn('t4');
    await txn('t5');
    const before = [entry('t-x', 'account', '23503', 'b1')];
    ctx.meta.set(KEY, JSON.stringify(before));
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      remembered: remembered(),
    }).toStrictEqual({
      local: [
        `t-x:pending@${WRITTEN_AT}`,
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t4:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t5:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: before,
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [2]',
      'upsert transactions one',
      'upsert transactions [2]',
    ]);
  });
});

describe('split sets ride their run', () => {
  it("B10: one DELETE and one INSERT for a run's changed split sets; a parent whose own splits are refused stays pending", async () => {
    // t1 and t3 re-split here; t2's new split carries an amount the server
    // cannot store. The INSERT of all three sets fails whole, so each set is
    // sent alone: t2's is refused and t2 waits, its server splits already
    // deleted (as one parent's were before #29), and t1 and t3 are synced.
    for (const id of ['t1', 't2', 't3']) {
      await txn(id);
      await insertLocalSplit(ctx.adapter, {
        id: `old-${id}`,
        transaction_id: id,
        updated_at: SYNCED_AT,
        _sync_status: 'deleted',
      });
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        amount: -12.34,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.store.transactions = ['t1', 't2', 't3'].map((id) =>
      remoteTxn({ id, updated_at: toPgTimestamp(SYNCED_AT) })
    );
    ctx.store.transaction_splits = ['t1', 't2', 't3'].map((id) => ({
      id: `old-${id}`,
      transaction_id: id,
      amount: -12.34,
      memo: null,
      updated_at: toPgTimestamp(SYNCED_AT),
    }));
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      rowErrors: new Map([['new-t2', OVERFLOW]]),
    });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      serverSplits: server('transaction_splits'),
      remembered: remembered(),
    }).toStrictEqual({
      local: [
        `t1:synced@${SERVER_NOW}`,
        `t2:pending@${WRITTEN_AT}`,
        `t3:synced@${SERVER_NOW}`,
      ],
      splits: [
        `new-t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `new-t2:pending@${WRITTEN_AT}`,
        `new-t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `old-t2:deleted@${SYNCED_AT}`,
      ],
      serverSplits: [
        `new-t1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `new-t3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: '<no key>',
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'delete transaction_splits transaction_id in 3',
      'insert transaction_splits 3',
      'insert transaction_splits 1 ×3',
    ]);
  });

  it('B11: a session gone before the split DELETE leaves every parent of the run pending, its server splits untouched', async () => {
    for (const id of ['t1', 't2']) {
      await txn(id);
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.store.transactions = ['t1', 't2'].map((id) =>
      remoteTxn({ id, updated_at: toPgTimestamp(SYNCED_AT) })
    );
    ctx.store.transaction_splits = [
      { id: 'srv-t1', transaction_id: 't1', amount: 0, memo: null },
    ];
    // b signs in as the run's upsert, signed as u, is answered (#111).
    const remote: SupabaseOpts = {
      onAfterUpsert: async (table) => {
        if (table === 'transactions') remote.sessionUserId = 'b';
      },
    };
    ctx.installSupabase(remote);
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      serverSplits: server('transaction_splits'),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [`t1:pending@${WRITTEN_AT}`, `t2:pending@${WRITTEN_AT}`],
      serverSplits: ['srv-t1:live@'],
      warned: [
        '[sync] splits of transaction t1 not sent: the session belongs to b, not u',
        '[sync] splits of transaction t2 not sent: the session belongs to b, not u',
      ],
    });
    expect(collapse(writes)).toStrictEqual(['upsert transactions [2]']);
  });
});

describe('what a run costs', () => {
  it('B12: 300 pending transactions are three upserts', async () => {
    await txns(300);
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect(
      local('transactions').filter((r) => !/:synced@/.test(r))
    ).toStrictEqual([]);
    expect(ctx.store.transactions.length).toBe(300);
    expect(collapse(writes)).toStrictEqual(['upsert transactions [100] ×3']);
  });

  it('B13: 300 parents whose split sets changed are nine requests, not 900', async () => {
    const ids = await txns(300);
    for (const id of ids) {
      await insertLocalSplit(ctx.adapter, {
        id: `s-${id}`,
        transaction_id: id,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      unsynced: local('transactions')
        .concat(local('transaction_splits'))
        .filter((r) => !/:synced@/.test(r)),
      serverSplits: ctx.store.transaction_splits.length,
    }).toStrictEqual({ unsynced: [], serverSplits: 300 });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [100]',
      'delete transaction_splits transaction_id in 100',
      'insert transaction_splits 100',
      'upsert transactions [100]',
      'delete transaction_splits transaction_id in 100',
      'insert transaction_splits 100',
      'upsert transactions [100]',
      'delete transaction_splits transaction_id in 100',
      'insert transaction_splits 100',
    ]);
  });

  it('B14: a run is a hundred rows', () => {
    expect(PUSH_BATCH_SIZE).toBe(100);
  });
});

describe('accounts and rules go up in runs too', () => {
  it('B15: a rule the server refuses and one this device cannot prepare are recorded in row order; accounts and rules go in runs', async () => {
    // r1 is filed under b's account (010). r2's template is not JSON (#129):
    // it is never sent, and is recorded at its own turn, after r1. r3 and r4
    // upload. Before them, a1's rename and a new account a3 go as one run.
    await insertLocalAccount(ctx.adapter, {
      id: 'a3',
      name: 'New',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    ctx.adapter._sqlite
      .prepare(
        `UPDATE accounts SET name = 'Renamed', updated_at = ?, _sync_status = 'pending' WHERE id = 'a1'`
      )
      .run(WRITTEN_AT);
    for (const [id, account, template] of [
      ['r1', 'b1', '{}'],
      ['r2', 'a1', '{not json'],
      ['r3', 'a2', '{}'],
      ['r4', 'a1', '{}'],
    ]) {
      await insertLocalRule(ctx.adapter, {
        id,
        account_id: account,
        template,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.installSupabase({ serverNow: SERVER_NOW });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      accounts: local('accounts'),
      rules: local('recurring_rules'),
      remembered: remembered(),
      // The console reads in row order too, as before #29 (u29ref REF5).
      warned: warnings
        .filter((w) => /^\[sync\] push recurring_rules r[12] /.test(w))
        .map((w) => w.replace(/(rejected|prepared):[\s\S]*$/, '$1:')),
    }).toStrictEqual({
      accounts: [
        `a1:synced@${SERVER_NOW}`,
        `a2:synced@${SYNCED_AT}`,
        `a3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      rules: [
        `r1:pending@${WRITTEN_AT}`,
        `r2:pending@${WRITTEN_AT}`,
        `r3:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r4:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: [
        entry('r1', 'account', '23503', 'b1', 'recurring_rules'),
        entry('r2', 'unprepared', '', 'a1', 'recurring_rules'),
      ],
      warned: [
        '[sync] push recurring_rules r1 rejected:',
        '[sync] push recurring_rules r2 skipped: its row could not be prepared:',
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert accounts [2]',
      'upsert recurring_rules [3]',
      'upsert recurring_rules one ×3',
    ]);
  });
});

describe('the lock, the queue and the status store are as they were', () => {
  it('B16: a push requested during a run is queued and runs once, and the count is published after', async () => {
    await txns(3);
    await refreshSyncState('u');
    const during: number[] = [];
    let queued: Promise<void> | null = null;
    ctx.installSupabase({
      onAfterUpsert: async () => {
        // Mid-run: the store still shows what it showed before the push.
        during.push(getSyncSnapshot().pendingCount);
        if (!queued) {
          await txn('t-late');
          queued = requestPush('u');
        }
      },
    });
    const writes = recordWrites();

    await requestPush('u');
    await queued;

    expect({
      during: [...new Set(during)],
      after: getSyncSnapshot().pendingCount,
      syncing: getSyncSnapshot().isSyncing,
      local: local('transactions'),
    }).toStrictEqual({
      during: [3],
      after: 0,
      syncing: false,
      local: [
        `t-late:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t000:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t001:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t002:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one',
    ]);
  });
});

describe('what the attack added (u29ref)', () => {
  it('B17: a rule refused by the last push, at the version it still has, goes alone with the request it always was', async () => {
    for (const [id, account] of [
      ['r1', 'a1'],
      ['r2', 'a1'],
      ['r-x', 'b1'],
      ['r4', 'a1'],
      ['r5', 'a1'],
    ]) {
      await insertLocalRule(ctx.adapter, {
        id,
        account_id: account,
        template: '{}',
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    const before = [entry('r-x', 'account', '23503', 'b1', 'recurring_rules')];
    ctx.meta.set(KEY, JSON.stringify(before));
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      rules: local('recurring_rules'),
      remembered: remembered(),
    }).toStrictEqual({
      rules: [
        `r-x:pending@${WRITTEN_AT}`,
        `r1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r4:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r5:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: before,
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert recurring_rules [2]',
      'upsert recurring_rules one',
      'upsert recurring_rules [2]',
    ]);
  });

  it('B18: a refused row the user has since moved to an account of theirs goes back into its run, and its entry goes', async () => {
    const EDITED_AT = '2026-11-01T09:00:00.000Z';
    await txn('t1');
    await txn('t2');
    await txn('t-x', { updated_at: EDITED_AT });
    await txn('t4');
    await txn('t5');
    ctx.meta.set(KEY, JSON.stringify([entry('t-x', 'account', '23503', 'b1')]));
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      remembered: remembered(),
    }).toStrictEqual({
      local: [
        `t-x:synced@${toPgTimestamp(EDITED_AT)}`,
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t4:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t5:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: [],
    });
    expect(collapse(writes)).toStrictEqual(['upsert transactions [5]']);
  });

  it('B19: a parent pushed alone whose new split is refused costs one DELETE by its id and one INSERT, as before #29', async () => {
    await txn('t1');
    await insertLocalSplit(ctx.adapter, {
      id: 'new-t1',
      transaction_id: 't1',
      amount: -12.34,
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: toPgTimestamp(SYNCED_AT) }),
    ];
    ctx.store.transaction_splits = [
      { id: 'old-t1', transaction_id: 't1', amount: -12.34, memo: null },
    ];
    ctx.installSupabase({
      serverNow: SERVER_NOW,
      rowErrors: new Map([['new-t1', OVERFLOW]]),
    });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      serverSplits: server('transaction_splits'),
    }).toStrictEqual({
      local: [`t1:pending@${WRITTEN_AT}`],
      splits: [`new-t1:pending@${WRITTEN_AT}`],
      serverSplits: [],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions one',
      'delete transaction_splits transaction_id =',
      'insert transaction_splits 1',
    ]);
  });

  it("B20: a run's accepted split INSERT marks every split synced with the server's stamp; one unstamped split restamps the run's whole upload", async () => {
    // t1's split predates local migration 2 (no stamp), t2's carries one.
    // The run's ONE insert leaves updated_at off every split (CONTRIBUTING
    // :19), so the server stamps both, and both adopt it. Before #29 t2's
    // own insert kept its stamp (re-rendered): the documented change.
    for (const [id, stamp] of [
      ['t1', null],
      ['t2', WRITTEN_AT],
    ] as const) {
      await txn(id);
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        amount: -12.34,
        updated_at: stamp,
        _sync_status: 'pending',
      });
    }
    ctx.installSupabase({ serverNow: SERVER_NOW });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      serverSplits: server('transaction_splits'),
    }).toStrictEqual({
      local: [
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      splits: [`new-t1:synced@${SERVER_NOW}`, `new-t2:synced@${SERVER_NOW}`],
      serverSplits: [`new-t1:live@${SERVER_NOW}`, `new-t2:live@${SERVER_NOW}`],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [2]',
      'delete transaction_splits transaction_id in 2',
      'insert transaction_splits 2',
    ]);
  });

  it('B21: the parents of a run that failed write their split sets one by one, each right after its own upsert, as before #29', async () => {
    await txn('t-x', { account_id: 'b1' });
    for (const id of ['t2', 't3']) {
      await txn(id);
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        amount: -12.34,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.installSupabase();
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      remembered: remembered(),
    }).toStrictEqual({
      local: [
        `t-x:pending@${WRITTEN_AT}`,
        `t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      splits: [
        `new-t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `new-t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: [entry('t-x', 'account', '23503', 'b1')],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'upsert transactions one ×2',
      'delete transaction_splits transaction_id =',
      'insert transaction_splits 1',
      'upsert transactions one',
      'delete transaction_splits transaction_id =',
      'insert transaction_splits 1',
    ]);
  });

  it('B22: a local edit that lands while its run is in flight keeps that row pending, and the next push sends it', async () => {
    const EDITED_AT = '2026-11-04T11:00:00.000Z';
    for (const id of ['t1', 't2', 't3']) {
      await txn(id);
    }
    let edited = false;
    ctx.installSupabase({
      onAfterUpsert: async () => {
        // After the request that stored t2: its run, or (before #29) its own.
        if (!edited && ctx.store.transactions?.some((r) => r.id === 't2')) {
          edited = true;
          ctx.adapter._sqlite
            .prepare(
              `UPDATE transactions SET payee = 'Edited', updated_at = ?, _sync_status = 'pending' WHERE id = 't2'`
            )
            .run(EDITED_AT);
        }
      },
    });

    await pushChanges('u');
    const first = {
      local: local('transactions'),
      serverPayee: ctx.store.transactions.find((r) => r.id === 't2')?.payee,
    };
    await pushChanges('u');

    expect({
      first,
      second: {
        local: local('transactions'),
        serverPayee: ctx.store.transactions.find((r) => r.id === 't2')?.payee,
      },
    }).toStrictEqual({
      first: {
        local: [
          `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
          `t2:pending@${EDITED_AT}`,
          `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
        ],
        serverPayee: 'Payee t2',
      },
      second: {
        local: [
          `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
          // A row the server holds keeps this device's stamp as sent: the
          // fake stamps an UPDATE only under serverNow (R7).
          `t2:synced@${EDITED_AT}`,
          `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
        ],
        serverPayee: 'Edited',
      },
    });
  });

  it("B23: the run sizes at the boundaries: 0, 1, 100, 101 and 201 rows, and a refused row at a run's last and first place", async () => {
    const sizes: Record<string, string[]> = {};
    for (const n of [0, 1, 100, 101, 201]) {
      ctx.adapter._sqlite.prepare('DELETE FROM transactions').run();
      ctx.store.transactions = [];
      await txns(n);
      ctx.installSupabase();
      const writes = recordWrites();
      await pushChanges('u');
      expect(
        local('transactions').filter((r) => !/:synced@/.test(r))
      ).toStrictEqual([]);
      sizes[String(n)] = collapse(writes);
    }
    for (const at of [99, 100]) {
      ctx.adapter._sqlite.prepare('DELETE FROM transactions').run();
      ctx.store.transactions = [];
      ctx.meta.delete(KEY);
      const ids = await txns(150);
      ctx.adapter._sqlite
        .prepare(`UPDATE transactions SET account_id = 'b1' WHERE id = ?`)
        .run(ids[at]);
      ctx.installSupabase();
      const writes = recordWrites();
      await pushChanges('u');
      expect(
        local('transactions').filter((r) => !/:synced@/.test(r))
      ).toStrictEqual([`${ids[at]}:pending@${WRITTEN_AT}`]);
      sizes[`refused at ${at}`] = collapse(writes);
    }
    expect(sizes).toStrictEqual({
      '0': [],
      '1': ['upsert transactions one'],
      '100': ['upsert transactions [100]'],
      '101': ['upsert transactions [100]', 'upsert transactions one'],
      '201': ['upsert transactions [100] ×2', 'upsert transactions one'],
      'refused at 99': [
        'upsert transactions [100]',
        'upsert transactions one ×100',
        'upsert transactions [50]',
      ],
      'refused at 100': [
        'upsert transactions [100]',
        'upsert transactions [50]',
        'upsert transactions one ×50',
      ],
    });
  });
});

describe('a run row edited during the round trip keeps its edit (#20)', () => {
  // The guard every mark carries (the stamp the push read, still pending)
  // for a row of a run that is not its first: the edit lands after the
  // server stored the run and before the row's own mark. Each row's own
  // request on c3f7ad3, the same outcome there: the edit stays pending.
  const EDITED = '2026-11-04T11:00:00.000Z';
  const editOnce = (table: string, sql: string) => {
    let done = false;
    return async (t: string) => {
      if (t !== table || done) return;
      done = true;
      ctx.adapter._sqlite.prepare(sql).run(EDITED);
    };
  };

  it('B24: a transaction of a run, edited before its mark, stays pending with its edit', async () => {
    await txns(3);
    ctx.installSupabase({
      onAfterUpsert: editOnce(
        'transactions',
        "UPDATE transactions SET payee = 'Edited', updated_at = ?, _sync_status = 'pending' WHERE id = 't001'"
      ),
    });

    await pushChanges('u');

    expect(local('transactions')).toStrictEqual([
      `t000:synced@${toPgTimestamp(WRITTEN_AT)}`,
      `t001:pending@${EDITED}`,
      `t002:synced@${toPgTimestamp(WRITTEN_AT)}`,
    ]);
  });

  it('B25: an account and a rule of a run, edited before their marks, stay pending with their edits', async () => {
    for (const id of ['a7', 'a8', 'a9']) {
      await insertLocalAccount(ctx.adapter, {
        id,
        name: `Account ${id}`,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    for (const id of ['r1', 'r2', 'r3']) {
      await insertLocalRule(ctx.adapter, {
        id,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    const accounts = editOnce(
      'accounts',
      "UPDATE accounts SET name = 'Renamed', updated_at = ?, _sync_status = 'pending' WHERE id = 'a8'"
    );
    const rules = editOnce(
      'recurring_rules',
      "UPDATE recurring_rules SET updated_at = ?, _sync_status = 'pending' WHERE id = 'r2'"
    );
    ctx.installSupabase({
      onAfterUpsert: async (t) => {
        await accounts(t);
        await rules(t);
      },
    });

    await pushChanges('u');

    expect({
      accounts: local('accounts').filter((r) => /^a[789]:/.test(r)),
      rules: local('recurring_rules'),
    }).toStrictEqual({
      accounts: [
        `a7:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `a8:pending@${EDITED}`,
        `a9:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      rules: [
        `r1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r2:pending@${EDITED}`,
        `r3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
    });
  });
});

describe('delete wins inside a run too (#18)', () => {
  // An edit that lands on another device's tombstone is stored around it:
  // PostgREST's upsert writes only the keys it is sent, and an edit never
  // sends `deleted_at`, so the row's read-back carries the tombstone and the
  // push drops the local copy (serverDeletedAt). Before #29 that read-back
  // was each row's own answer; in a run it is the row's entry in the run's
  // answer, which must carry `deleted_at` too, or the row is marked synced
  // here and lives on this device while the server and every other device
  // hold it deleted. B2's tombstoned row is left out of its run's answer and
  // goes alone; the rows below are answered by their run.
  it("B26: a transaction of an accepted run that landed on another device's tombstone is dropped here, and its split set is never sent", async () => {
    // t2 was deleted on another device while this one re-split it offline,
    // as it re-split t1. The run's split write is t1's alone: t2's would put
    // splits back under a parent that is dead on the server.
    for (const id of ['t1', 't2', 't3']) {
      await txn(id);
    }
    for (const id of ['t1', 't2']) {
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        amount: -12.34,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.store.transactions = [
      remoteTxn({
        id: 't2',
        updated_at: toPgTimestamp(SYNCED_AT),
        deleted_at: '2026-11-01T00:00:00+00:00',
      }),
    ];
    ctx.installSupabase({ serverNow: SERVER_NOW });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      local: local('transactions'),
      splits: local('transaction_splits'),
      server: server('transactions'),
      serverSplits: server('transaction_splits'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      local: [
        `t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `t3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      splits: [`new-t1:synced@${toPgTimestamp(WRITTEN_AT)}`],
      server: [
        `t1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `t2:dead@${SERVER_NOW}`,
        `t3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      serverSplits: [`new-t1:live@${toPgTimestamp(WRITTEN_AT)}`],
      remembered: '<no key>',
      warned: [],
    });
    expect(collapse(writes)).toStrictEqual([
      'upsert transactions [3]',
      'delete transaction_splits transaction_id =',
      'insert transaction_splits 1',
    ]);
  });

  it("B27: a rule of an accepted run that landed on another device's tombstone is dropped here", async () => {
    // pushTable's run; an account's is settled by the same code.
    for (const id of ['r1', 'r2', 'r3']) {
      await insertLocalRule(ctx.adapter, {
        id,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.store.recurring_rules = [
      remoteRule({
        id: 'r2',
        updated_at: toPgTimestamp(SYNCED_AT),
        deleted_at: '2026-11-01T00:00:00+00:00',
      }),
    ];
    ctx.installSupabase({ serverNow: SERVER_NOW });
    const writes = recordWrites();

    await pushChanges('u');

    expect({
      rules: local('recurring_rules'),
      server: server('recurring_rules'),
      remembered: remembered(),
      warned: rowWarnings(),
    }).toStrictEqual({
      rules: [
        `r1:synced@${toPgTimestamp(WRITTEN_AT)}`,
        `r3:synced@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      server: [
        `r1:live@${toPgTimestamp(WRITTEN_AT)}`,
        `r2:dead@${SERVER_NOW}`,
        `r3:live@${toPgTimestamp(WRITTEN_AT)}`,
      ],
      remembered: '<no key>',
      warned: [],
    });
    expect(collapse(writes)).toStrictEqual(['upsert recurring_rules [3]']);
  });
});

describe("a run's split DELETE that fails", () => {
  // A run's changed split sets are replaced by one DELETE, then one INSERT
  // (pushSplitSets). When the DELETE fails the server still holds the old
  // sets, and an INSERT would put the new splits beside them, doubling each
  // set on every device, with the parents marked synced here. So nothing
  // more is sent: every parent of the run stays pending, and the next push
  // writes the sets again, as one parent's were written again before #29.

  /** PostgREST's answer to a statement that ran past statement_timeout. */
  const STATEMENT_TIMEOUT = {
    code: '57014',
    message: 'canceling statement due to statement timeout',
    details: null,
    hint: null,
  };

  /**
   * Every split DELETE answered with `error` while `refusing.on`, any other
   * request by the fake. Install it AFTER installSupabase and BEFORE
   * recordWrites, which then records the refused DELETE too.
   */
  function refuseSplitDeletes(error: unknown) {
    const refusing = { on: true };
    const realFrom = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const b = realFrom(table);
      if (table === 'transaction_splits') {
        const realDelete = b.delete;
        b.delete = () => {
          if (!refusing.on) return realDelete();
          const refused: any = {
            eq: () => refused,
            in: () => refused,
            then: (resolve: any, reject: any) =>
              Promise.resolve({ data: null, error }).then(resolve, reject),
          };
          return refused;
        };
      }
      return b;
    };
    return refusing;
  }

  it('B28: no INSERT follows it: every parent of the run stays pending, the server keeps its split sets, and the next push writes them', async () => {
    for (const id of ['t1', 't2']) {
      await txn(id);
      await insertLocalSplit(ctx.adapter, {
        id: `new-${id}`,
        transaction_id: id,
        amount: -12.34,
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      });
    }
    ctx.store.transactions = ['t1', 't2'].map((id) =>
      remoteTxn({ id, updated_at: toPgTimestamp(SYNCED_AT) })
    );
    ctx.store.transaction_splits = ['t1', 't2'].map((id) => ({
      id: `old-${id}`,
      transaction_id: id,
      amount: -12.34,
      memo: null,
      updated_at: toPgTimestamp(SYNCED_AT),
    }));
    ctx.installSupabase({ serverNow: SERVER_NOW });
    const refusing = refuseSplitDeletes(STATEMENT_TIMEOUT);
    const writes = recordWrites();

    await pushChanges('u');
    const first = {
      local: local('transactions'),
      splits: local('transaction_splits'),
      serverSplits: server('transaction_splits'),
    };
    const firstWrites = collapse(writes.splice(0));
    refusing.on = false;
    await pushChanges('u');

    expect({
      first,
      second: {
        local: local('transactions'),
        splits: local('transaction_splits'),
        serverSplits: server('transaction_splits'),
      },
    }).toStrictEqual({
      first: {
        local: [`t1:pending@${WRITTEN_AT}`, `t2:pending@${WRITTEN_AT}`],
        splits: [
          `new-t1:pending@${WRITTEN_AT}`,
          `new-t2:pending@${WRITTEN_AT}`,
        ],
        serverSplits: [
          `old-t1:live@${toPgTimestamp(SYNCED_AT)}`,
          `old-t2:live@${toPgTimestamp(SYNCED_AT)}`,
        ],
      },
      second: {
        local: [`t1:synced@${SERVER_NOW}`, `t2:synced@${SERVER_NOW}`],
        splits: [
          `new-t1:synced@${toPgTimestamp(WRITTEN_AT)}`,
          `new-t2:synced@${toPgTimestamp(WRITTEN_AT)}`,
        ],
        serverSplits: [
          `new-t1:live@${toPgTimestamp(WRITTEN_AT)}`,
          `new-t2:live@${toPgTimestamp(WRITTEN_AT)}`,
        ],
      },
    });
    expect({ first: firstWrites, second: collapse(writes) }).toStrictEqual({
      first: [
        'upsert transactions [2]',
        'delete transaction_splits transaction_id in 2',
      ],
      second: [
        'upsert transactions [2]',
        'delete transaction_splits transaction_id in 2',
        'insert transaction_splits 2',
      ],
    });
  });
});

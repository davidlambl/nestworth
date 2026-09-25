// #64: PostgREST truncates EVERY response at `max_rows`, and says nothing about
// it. A read that is unpaged — or that stops as soon as a page comes back
// shorter than it asked for — therefore cannot tell that truncation from the end
// of the table, and the result is not a slow sync but data loss:
// `pullTableFull` feeds its read straight into an absence-delete loop, and the
// reconcile enumeration is what gives `planTransactionReconcile` its deletion
// authority. The #19 empty-read guard does not help, because a truncated read is
// not empty.
//
// Every test below drives the fixture's `maxRows` cap (2, well below the page
// size the client asks for) and fails against the unpaged reads.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { initialPull, pullChanges, pushChanges, readAllPages } from '../sync';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

let ctx: ReturnType<typeof wireSyncMocks>;

beforeEach(() => {
  ctx = wireSyncMocks();
});

afterEach(() => {
  ctx.adapter._sqlite.close();
});

const ids = async (table: string) =>
  (
    await ctx.adapter.getAllAsync(`SELECT id FROM ${table} ORDER BY id`, [])
  ).map((r: any) => r.id);

const FIVE = ['1', '2', '3', '4', '5'];
const minuteAgo = () => new Date(Date.now() - 60 * 1000).toISOString();

describe('pullTableFull pages its read (#64)', () => {
  it('keeps the accounts a truncated read never returned', async () => {
    // Five local, five remote, all agreeing — nothing should change. With the
    // read unpaged, `max_rows` hands the reconciliation 2 of the 5, and the
    // absence loop deletes the other 3: deletion authority over rows the server
    // never got the chance to mention.
    for (const n of FIVE) {
      await insertLocalAccount(ctx.adapter, { id: `a${n}` });
    }
    ctx.store.accounts = FIVE.map((n) => remoteAccount({ id: `a${n}` }));
    // A fresh reconcile key keeps the transaction pass out of this test.
    ctx.meta.set('last_txn_reconcile_at:u', minuteAgo());
    ctx.installSupabase({ maxRows: 2 });

    await pullChanges('u');

    expect(await ids('accounts')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
});

describe('pullTransactions pages every read (#64)', () => {
  it('keeps the transactions a truncated reconcile enumeration never returned', async () => {
    // The cursor sits after every remote timestamp, so step 1 reads nothing and
    // the enumeration is the only thing acting; no reconcile key means it is
    // due. Truncated, it enumerates 2 of 5 and the planner deletes the rest.
    for (const n of FIVE) {
      await insertLocalTxn(ctx.adapter, { id: `t${n}` });
    }
    ctx.store.transactions = FIVE.map((n) => remoteTxn({ id: `t${n}` }));
    ctx.meta.set('last_txn_pull_at:u', '2026-03-01T00:00:00Z');
    ctx.installSupabase({ maxRows: 2 });

    await pullChanges('u');

    expect(await ids('transactions')).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // A pass that enumerated everything and found no drift did complete.
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeTruthy();
  });

  it('pulls every incremental page, and every split of every parent it pulled', async () => {
    // No cursor, so step 1 reads the lot. Truncated it took 2 of 3 parents and
    // then banked the cursor over all three — the third row's window is read
    // and dismissed in the same pull, and only the 24h reconcile could ever
    // bring it back.
    ctx.store.transactions = ['1', '2', '3'].map((n) =>
      remoteTxn({ id: `t${n}` })
    );
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: 1, memo: null },
      { id: 's2', transaction_id: 't1', amount: 2, memo: null },
      { id: 's3', transaction_id: 't2', amount: 3, memo: null },
      { id: 's4', transaction_id: 't2', amount: 4, memo: null },
      { id: 's5', transaction_id: 't3', amount: 5, memo: null },
      { id: 's6', transaction_id: 't3', amount: 6, memo: null },
    ];
    ctx.installSupabase({ maxRows: 2 });

    await pullChanges('u');

    expect(await ids('transactions')).toEqual(['t1', 't2', 't3']);
    expect(await ids('transaction_splits')).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
    ]);
    // Everything was read, so the cursor has earned its advance.
    expect(ctx.meta.get('last_txn_pull_at:u')).toBeTruthy();
  });

  it("pages the reconcile's own split read for a healed parent (#62 + #64)", async () => {
    // Local says January, the server says February, so the reconcile plans a
    // refresh and — since #62 — reads that parent's splits and writes both
    // together. Truncated, that read stored 2 of 4 splits, and because the
    // parent then MATCHES the server no enumeration re-plans it and no
    // incremental read returns it: the two missing splits are permanent.
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      payee: 'Old',
      updated_at: '2026-01-01T00:00:00Z',
    });
    ctx.store.transactions = [
      remoteTxn({ id: 't1', payee: 'New', updated_at: '2026-02-01T00:00:00Z' }),
    ];
    ctx.store.transaction_splits = ['1', '2', '3', '4'].map((n) => ({
      id: `s${n}`,
      transaction_id: 't1',
      amount: Number(n),
      memo: null,
    }));
    ctx.meta.set('last_txn_pull_at:u', '2026-03-01T00:00:00Z');
    ctx.installSupabase({ maxRows: 2 });

    await pullChanges('u');

    expect(await ids('transaction_splits')).toEqual(['s1', 's2', 's3', 's4']);
    const healed: any = ctx.adapter._sqlite
      .prepare('SELECT payee FROM transactions WHERE id = ?')
      .get('t1');
    expect(healed.payee).toBe('New');
  });
});

describe('pushChanges pages its split refresh (#64 + #112)', () => {
  it('stores every split of a parent pushed alone whose stamp fell below the cursor', async () => {
    // The device clock runs ahead of the server's: t1, edited here without
    // touching its splits, is pushed alone and adopts a stamp below the pull
    // cursor, so the push reads its splits itself (#112). Truncated, that read
    // stored 2 of 4 splits beside a parent that now MATCHES the server, and
    // nothing looks at the pair again: the next pull does not list it, and
    // the reconcile finds the stamps equal.
    ctx.meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');
    ctx.meta.set('last_txn_reconcile_at:u', minuteAgo());
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      updated_at: '2026-06-15T00:00:10Z',
      _sync_status: 'pending',
    });
    for (const id of ['s1', 's2']) {
      await insertLocalSplit(ctx.adapter, {
        id,
        transaction_id: 't1',
        updated_at: '2026-06-01T00:00:00Z',
      });
    }
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-06-14T23:59:45+00:00' }),
    ];
    ctx.store.transaction_splits = ['3', '4', '5', '6'].map((n) => ({
      id: `s${n}`,
      transaction_id: 't1',
      amount: Number(n),
      memo: null,
    }));
    ctx.installSupabase({
      serverNow: '2026-06-14T23:59:55+00:00',
      maxRows: 2,
    });

    await pushChanges('u');

    expect(await ids('transaction_splits')).toEqual(['s3', 's4', 's5', 's6']);
    const t1: any = ctx.adapter._sqlite
      .prepare('SELECT _sync_status, updated_at FROM transactions WHERE id = ?')
      .get('t1');
    expect(t1).toEqual({
      _sync_status: 'synced',
      updated_at: '2026-06-14T23:59:55+00:00',
    });
  });
});

describe('initialPull pages every read (#64)', () => {
  it('bootstraps every account, rule, transaction and split', async () => {
    // A bootstrap is the worst place to truncate: nothing back-fills it. The
    // cursors are stamped at the end regardless, so the rows past the cap are
    // never fetched again — the incremental read only asks for `updated_at >
    // cursor`, and the reconcile records itself as done in the same breath.
    ctx.store.accounts = FIVE.map((n) => remoteAccount({ id: `a${n}` }));
    ctx.store.recurring_rules = FIVE.map((n) => remoteRule({ id: `r${n}` }));
    ctx.store.transactions = FIVE.map((n) => remoteTxn({ id: `t${n}` }));
    ctx.store.transaction_splits = FIVE.map((n) => ({
      id: `s${n}`,
      transaction_id: 't1',
      amount: Number(n),
      memo: null,
    }));
    ctx.installSupabase({ maxRows: 2 });

    await initialPull('u');

    expect(await ids('accounts')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(await ids('recurring_rules')).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);
    expect(await ids('transactions')).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(await ids('transaction_splits')).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
    ]);
  });
});

describe('readAllPages', () => {
  it('advances by rows returned and stops only on an empty page', async () => {
    // The server's cap (2) is below the page size the caller asks for (1000),
    // which is the case that breaks both shortcuts: advancing by the page size
    // would skip rows 3-5, and stopping on the first short page would skip
    // rows 3-5 as well.
    const rows = [1, 2, 3, 4, 5];
    const MAX_ROWS = 2;
    const calls: [number, number][] = [];
    const delivered: number[][] = [];

    const result = await readAllPages<number>(
      async (from, to) => {
        calls.push([from, to]);
        return {
          data: rows.slice(from, to + 1).slice(0, MAX_ROWS),
          error: null,
        };
      },
      async (page) => {
        delivered.push(page);
      },
      // The trailing empty page asks whether the session is this user's
      // (#95, #111): wireSyncMocks signs the fake in as 'u'.
      { userId: 'u' }
    );

    // The last call is the trailing empty read that proves the end: it is the
    // whole cost of the rule, and the real PostgREST answers it `200 []`.
    expect(calls).toEqual([
      [0, 999],
      [2, 1001],
      [4, 1003],
      [5, 1004],
    ]);
    expect(delivered).toEqual([[1, 2], [3, 4], [5]]);
    expect(result.rows).toBe(5);
    expect(result.error).toBeNull();
  });

  it('returns a mid-way error, with the pages before it already delivered', async () => {
    // Every caller turns that error into "do not bank the cursor". The pages
    // that did arrive stay written: upserts are guarded and idempotent, so
    // re-reading the window next sync costs nothing.
    const boom = { code: 'PGRST000', message: 'boom' };
    const delivered: number[][] = [];

    const result = await readAllPages<number>(
      async (from) =>
        from === 0
          ? { data: [1, 2], error: null }
          : { data: null, error: boom },
      async (page) => {
        delivered.push(page);
      },
      { userId: 'u' }
    );

    expect(result.error).toBe(boom);
    expect(result.rows).toBe(2);
    expect(delivered).toEqual([[1, 2]]);
  });
});

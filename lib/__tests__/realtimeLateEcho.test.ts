// A late realtime echo of a row this device has deleted (#224). The push
// removes a deleted row here once the server has its tombstone, and the echo
// of the row's own earlier upload, or of a change to it, can arrive after
// that: its row is live and nothing is held here to spare, so the guarded
// upsert inserted it `synced`, back on its list (and, for a transaction, in
// the balance) until the tombstone's own echo or a pull removed it again. A
// row the push has tombstoned is now remembered where the push consumes the
// tombstone (lib/tombstones.ts, rememberDeletedHere), whichever delete marked
// it: the Recurring list's (useDeleteRecurringRule.test.ts), a post's last
// occurrence, an account delete with its children, the register's.
//
// The REAL pushChanges against the fixture's fake PostgREST, then the REAL
// handlers, over the fixture's SQLite. Own file, importing only the
// handlers, the engine, the fixture and the client it fakes, so it loads on
// 1.6.0, where each test below but the pins is red.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { pullChanges, pushChanges } from '../sync';
import { supabase } from '../supabase';
import {
  applyAccountEvent,
  applyRuleEvent,
  applyTransactionEvent,
} from '../realtimeHandlers';
import { applyAccountDelete } from '../accountDelete';
import { applyTransactionDelete } from '../transactionDelete';
import { RULE_DELETE_SQL } from '../recurringRuleDelete';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  toPgTimestamp,
  wireSyncMocks,
  type SupabaseOpts,
} from '../testing/syncFixture';

/** When the seeded rows were uploaded: a moment before their delete. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
const NOW = '2026-05-10T00:00:01.000Z';

let ctx: ReturnType<typeof wireSyncMocks>;
let warn: jest.SpyInstance;

const account = (id: string) =>
  remoteAccount({ id, updated_at: toPgTimestamp(SYNCED_AT) });
const rule = (id: string, over: Record<string, unknown> = {}) =>
  remoteRule({ id, updated_at: toPgTimestamp(SYNCED_AT), ...over });
const txn = (id: string, over: Record<string, unknown> = {}) =>
  remoteTxn({
    id,
    amount: -4200,
    updated_at: toPgTimestamp(SYNCED_AT),
    ...over,
  });
const insert = (row: any) => ({ eventType: 'INSERT', new: row, old: {} });

beforeEach(async () => {
  ctx = wireSyncMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  ctx.store.accounts = [account('a1'), account('a2')];
  ctx.store.recurring_rules = [rule('r1')];
  ctx.store.transactions = [txn('t1')];
  await insertLocalAccount(ctx.adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(ctx.adapter, { id: 'a2', updated_at: SYNCED_AT });
  await insertLocalRule(ctx.adapter, { id: 'r1', updated_at: SYNCED_AT });
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    amount: -4200,
    updated_at: SYNCED_AT,
  });
});

afterEach(() => {
  warn.mockRestore();
  ctx.adapter._sqlite.close();
});

const ids = (table: string): string[] =>
  (
    ctx.adapter._sqlite
      .prepare(`SELECT id FROM ${table} ORDER BY id`)
      .all() as {
      id: string;
    }[]
  ).map((r) => r.id);
const tombstoned = (table: string): string[] =>
  (ctx.store as any)[table]
    .filter((r: any) => r.deleted_at != null)
    .map((r: any) => r.id);

describe('a late realtime echo of a row this device deleted (#224)', () => {
  it('LE1: a rule its last occurrence expired stays gone', async () => {
    await ctx.adapter.runAsync(RULE_DELETE_SQL, [NOW, 'r1']);
    await pushChanges('u');
    expect(tombstoned('recurring_rules')).toEqual(['r1']);
    expect(ids('recurring_rules')).toEqual([]);

    await applyRuleEvent(ctx.adapter, insert(rule('r1')));

    // Before: ['r1'], back 'synced'.
    expect(ids('recurring_rules')).toEqual([]);
  });

  it('LE2: an account deleted with its rule and transaction stays gone, and so do they', async () => {
    await applyAccountDelete(ctx.adapter, 'a1', { now: NOW });
    await pushChanges('u');
    expect(tombstoned('accounts')).toEqual(['a1']);
    expect(ids('accounts')).toEqual(['a2']);

    await applyAccountEvent(ctx.adapter, insert(account('a1')));
    await applyRuleEvent(ctx.adapter, insert(rule('r1')));
    await applyTransactionEvent(ctx.adapter, insert(txn('t1')));

    // Before: a1, r1 and t1 all back 'synced': the account on the list with
    // the transaction in its balance, and a post of the rule then left a new
    // transaction the server refuses (23503) pending for good.
    expect(ids('accounts')).toEqual(['a2']);
    expect(ids('recurring_rules')).toEqual([]);
    expect(ids('transactions')).toEqual([]);
  });

  it('LE3: a transaction deleted in the register stays gone', async () => {
    await applyTransactionDelete(ctx.adapter, 't1', { now: NOW });
    await pushChanges('u');
    expect(tombstoned('transactions')).toEqual(['t1']);
    expect(ids('transactions')).toEqual([]);

    await applyTransactionEvent(ctx.adapter, insert(txn('t1')));
    await applyTransactionEvent(ctx.adapter, {
      eventType: 'UPDATE',
      new: txn('t1', {
        payee: 'Edited',
        updated_at: '2026-05-10T00:00:00.500+00:00',
      }),
      old: { id: 't1' },
    });

    // Before: ['t1'], back 'synced', in the balance; with the pull cursor
    // past the tombstone, until the reconcile.
    expect(ids('transactions')).toEqual([]);
  });

  it('LE4: an account deleted alone stays gone', async () => {
    await applyAccountDelete(ctx.adapter, 'a2', { now: NOW });
    await pushChanges('u');
    expect(tombstoned('accounts')).toEqual(['a2']);

    await applyAccountEvent(ctx.adapter, insert(account('a2')));

    // Before: ['a1', 'a2'].
    expect(ids('accounts')).toEqual(['a1']);
  });

  it('LE5: a tombstone the server refused is remembered once it is taken', async () => {
    ctx.installSupabase({ failWritesOn: new Set(['transactions']) });
    await applyTransactionDelete(ctx.adapter, 't1', { now: NOW });
    await pushChanges('u');
    expect(tombstoned('transactions')).toEqual([]);

    // The row is still 'deleted' here: the upsert spares it, as before.
    await applyTransactionEvent(ctx.adapter, insert(txn('t1')));
    expect(
      ctx.adapter._sqlite
        .prepare("SELECT _sync_status AS s FROM transactions WHERE id = 't1'")
        .get()
    ).toEqual({ s: 'deleted' });

    ctx.installSupabase();
    await pushChanges('u');
    expect(tombstoned('transactions')).toEqual(['t1']);
    await applyTransactionEvent(ctx.adapter, insert(txn('t1')));
    expect(ids('transactions')).toEqual([]);
  });

  /**
   * On a device the push's local DELETE is a round trip to SQLite, and an
   * echo the realtime handler takes meanwhile is checked then and written
   * after the DELETE: one connection, statements in order. So the push
   * remembers a row before its DELETE, never after (LE6, LE7). Delivered
   * here from inside the first statement matching `statement`, once it ran.
   */
  function echoDuringDelete(
    statement: RegExp,
    deliver: () => Promise<void>
  ): () => number {
    const runAsync = ctx.adapter.runAsync;
    let delivered = 0;
    ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const result = await runAsync(sql, params);
      if (delivered === 0 && statement.test(sql)) {
        delivered++;
        await deliver();
      }
      return result;
    };
    return () => delivered;
  }

  it('LE6: an echo handled while the push removes a rule here is not written', async () => {
    await ctx.adapter.runAsync(RULE_DELETE_SQL, [NOW, 'r1']);
    const delivered = echoDuringDelete(
      /^DELETE FROM recurring_rules WHERE id = \? AND _sync_status = 'deleted'$/,
      () => applyRuleEvent(ctx.adapter, insert(rule('r1')))
    );
    await pushChanges('u');

    expect(delivered()).toBe(1);
    expect(tombstoned('recurring_rules')).toEqual(['r1']);
    // Before, or remembered after the DELETE: ['r1'], back 'synced'.
    expect(ids('recurring_rules')).toEqual([]);
  });

  it('LE7: an echo handled while the push removes a transaction here is not written', async () => {
    await applyTransactionDelete(ctx.adapter, 't1', { now: NOW });
    const delivered = echoDuringDelete(
      /^DELETE FROM transactions WHERE id IN \(/,
      () => applyTransactionEvent(ctx.adapter, insert(txn('t1')))
    );
    await pushChanges('u');

    expect(delivered()).toBe(1);
    expect(tombstoned('transactions')).toEqual(['t1']);
    // Before, or remembered after the DELETE: ['t1'], back 'synced'.
    expect(ids('transactions')).toEqual([]);
  });

  it('LE8: two transactions deleted together stay gone, both', async () => {
    ctx.store.transactions = [txn('t1'), txn('t2')];
    await insertLocalTxn(ctx.adapter, {
      id: 't2',
      amount: -4200,
      updated_at: SYNCED_AT,
    });
    await applyTransactionDelete(ctx.adapter, 't1', { now: NOW });
    await applyTransactionDelete(ctx.adapter, 't2', { now: NOW });
    await pushChanges('u');
    expect(tombstoned('transactions')).toEqual(['t1', 't2']);

    await applyTransactionEvent(ctx.adapter, insert(txn('t1')));
    await applyTransactionEvent(ctx.adapter, insert(txn('t2')));

    // Before: ['t1', 't2'], both back 'synced'. Both went in one tombstone
    // batch, which is remembered whole: its first id alone leaves ['t2'].
    expect(ids('transactions')).toEqual([]);
  });

  it('pin: rows made on another device still arrive, whatever was deleted here', async () => {
    await applyAccountDelete(ctx.adapter, 'a2', { now: NOW });
    await applyTransactionDelete(ctx.adapter, 't1', { now: NOW });
    await pushChanges('u');

    await applyAccountEvent(ctx.adapter, insert(account('a3')));
    await applyRuleEvent(ctx.adapter, insert(rule('r3')));
    await applyTransactionEvent(ctx.adapter, insert(txn('t3')));

    expect(ids('accounts')).toEqual(['a1', 'a3']);
    expect(ids('recurring_rules')).toEqual(['r1', 'r3']);
    expect(ids('transactions')).toEqual(['t3']);
  });

  it("pin: another device's delete still removes a row the pull restored after #111's window", async () => {
    // #111's window: the session changes hands past the push's check, so the
    // rule's tombstone is signed as another user, matches nothing, and is
    // answered as success. r1 is remembered and removed here while the
    // server keeps it live, and the next pull brings it back.
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    const from = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      const builder = from(table);
      const update = builder.update;
      builder.update = (patch: any) => {
        if (table === 'recurring_rules') remote.sessionUserId = 'v';
        return update(patch);
      };
      return builder;
    };
    await ctx.adapter.runAsync(RULE_DELETE_SQL, [NOW, 'r1']);
    await pushChanges('u');
    ctx.installSupabase();
    expect(tombstoned('recurring_rules')).toEqual([]);
    expect(ids('recurring_rules')).toEqual([]);
    await pullChanges('u');
    expect(ids('recurring_rules')).toEqual(['r1']);

    // Its live events now wait for each pull (a residue), its delete does not.
    const later = '2026-05-11T00:00:00+00:00';
    await applyRuleEvent(ctx.adapter, {
      eventType: 'UPDATE',
      new: rule('r1', { updated_at: later, deleted_at: later }),
      old: { id: 'r1' },
    });
    expect(ids('recurring_rules')).toEqual([]);
  });
});

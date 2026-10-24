// Realtime event routing (backlog #18).
//
// These exercise `lib/realtimeHandlers.ts` against the real in-memory SQLite
// adapter, so the actual scoped-DELETE and UPSERT SQL runs rather than a stub
// of it. The handlers take `db` as a parameter, so nothing here needs the
// Supabase fake or `getDb` — but the mocks below are still mandatory: this file
// imports the fixture and (through `../realtimeHandlers`) `../sync`, both of
// which import '../supabase' and '../db' at module scope, and the real modules
// pull in native expo-sqlite and a live client. `jest.mock` calls are hoisted,
// so they must precede the imports they apply to.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  applyAccountEvent,
  applyRuleEvent,
  applyTransactionEvent,
  splitEventParent,
} from '../realtimeHandlers';
import {
  makeAdapter,
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
} from '../testing/syncFixture';

const TOMBSTONED_AT = '2026-03-01T00:00:00+00:00';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

const txnIds = async (): Promise<string[]> =>
  (
    (await adapter.getAllAsync(
      'SELECT id FROM transactions ORDER BY id'
    )) as any[]
  ).map((r) => r.id);

const splitIds = async (): Promise<string[]> =>
  (
    (await adapter.getAllAsync(
      'SELECT id FROM transaction_splits ORDER BY id'
    )) as any[]
  ).map((r) => r.id);

const accountIds = async (): Promise<string[]> =>
  (
    (await adapter.getAllAsync('SELECT id FROM accounts ORDER BY id')) as any[]
  ).map((r) => r.id);

describe('applyTransactionEvent', () => {
  it('consumes an UPDATE carrying deleted_at, dropping the row and its splits', async () => {
    // The headline case: with tombstones a delete never arrives as a DELETE
    // event, so this UPDATE is the only notice another device's delete gets.
    await insertLocalTxn(adapter, { id: 't1', _sync_status: 'synced' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 't1' });

    await applyTransactionEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteTxn({ id: 't1', deleted_at: TOMBSTONED_AT }),
    });

    expect(await txnIds()).toEqual([]);
    expect(await splitIds()).toEqual([]);
  });

  it('leaves a PENDING transaction and its splits untouched on a tombstone', async () => {
    // A pending row holds an offline edit that has never reached the server.
    // Destroying it here would discard the user's work silently; push resolves
    // the conflict instead, where the edit lands on the tombstone and loses.
    await insertLocalTxn(adapter, { id: 't1', _sync_status: 'pending' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 't1' });

    await applyTransactionEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteTxn({ id: 't1', deleted_at: TOMBSTONED_AT }),
    });

    expect(await txnIds()).toEqual(['t1']);
    expect(await splitIds()).toEqual(['s1']);
  });

  it('inserts nothing for a tombstone whose id was never stored locally', async () => {
    // The resurrection regression. Before the tombstone branch existed this
    // UPDATE fell through to `upsertRemoteTransaction`, whose ON CONFLICT
    // statement has an unguarded INSERT branch — so the deleting device
    // received its own tombstone back over realtime and re-created the row it
    // had just deleted. The table must still be empty.
    await applyTransactionEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteTxn({ id: 'gone', deleted_at: TOMBSTONED_AT }),
    });

    expect(await txnIds()).toEqual([]);
  });

  it('treats an INSERT carrying deleted_at as a tombstone', async () => {
    // The server's `inherit_account_tombstone` trigger stamps a row inserted
    // into an already-deleted account, so an INSERT event can be born dead.
    await applyTransactionEvent(adapter, {
      eventType: 'INSERT',
      new: remoteTxn({ id: 'born-dead', deleted_at: TOMBSTONED_AT }),
    });

    expect(await txnIds()).toEqual([]);
  });

  it('scopes a hard DELETE to synced rows', async () => {
    // A purge job and any client predating tombstones still hard-delete, so
    // this branch survives — but scoped (issue #21): the old unconditional
    // `DELETE FROM transactions WHERE id = ?` threw away pending offline edits.
    await insertLocalTxn(adapter, { id: 't1', _sync_status: 'synced' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 't1' });
    await insertLocalTxn(adapter, { id: 't2', _sync_status: 'pending' });
    await insertLocalSplit(adapter, { id: 's2', transaction_id: 't2' });

    await applyTransactionEvent(adapter, {
      eventType: 'DELETE',
      old: { id: 't1' },
    });
    await applyTransactionEvent(adapter, {
      eventType: 'DELETE',
      old: { id: 't2' },
    });

    expect(await txnIds()).toEqual(['t2']);
    expect(await splitIds()).toEqual(['s2']);
  });

  it('still upserts an UPDATE that carries no deleted_at', async () => {
    await insertLocalTxn(adapter, {
      id: 't1',
      payee: 'Old',
      updated_at: '2026-01-01T00:00:00Z',
    });

    await applyTransactionEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteTxn({
        id: 't1',
        payee: 'New',
        updated_at: '2026-02-01T00:00:00Z',
      }),
    });

    expect(
      await adapter.getFirstAsync(
        'SELECT payee FROM transactions WHERE id = ?',
        ['t1']
      )
    ).toEqual({ payee: 'New' });
  });
});

describe('applyAccountEvent', () => {
  it('consumes an UPDATE carrying deleted_at', async () => {
    await insertLocalAccount(adapter, { id: 'a1', _sync_status: 'synced' });

    await applyAccountEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteAccount({ id: 'a1', deleted_at: TOMBSTONED_AT }),
    });

    expect(await accountIds()).toEqual([]);
  });

  it('leaves a PENDING account untouched on a tombstone', async () => {
    await insertLocalAccount(adapter, { id: 'a1', _sync_status: 'pending' });

    await applyAccountEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteAccount({ id: 'a1', deleted_at: TOMBSTONED_AT }),
    });

    expect(await accountIds()).toEqual(['a1']);
  });

  it('inserts nothing for a tombstone whose id was never stored locally', async () => {
    // Same resurrection regression as transactions: `upsertRemoteAccount`'s
    // INSERT branch would otherwise re-create the deleted account.
    await applyAccountEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteAccount({ id: 'gone', deleted_at: TOMBSTONED_AT }),
    });

    expect(await accountIds()).toEqual([]);
  });

  it('scopes a hard DELETE to synced rows', async () => {
    await insertLocalAccount(adapter, { id: 'a1', _sync_status: 'synced' });
    await insertLocalAccount(adapter, { id: 'a2', _sync_status: 'pending' });

    await applyAccountEvent(adapter, {
      eventType: 'DELETE',
      old: { id: 'a1' },
    });
    await applyAccountEvent(adapter, {
      eventType: 'DELETE',
      old: { id: 'a2' },
    });

    expect(await accountIds()).toEqual(['a2']);
  });

  it('still upserts an UPDATE that carries no deleted_at', async () => {
    await insertLocalAccount(adapter, {
      id: 'a1',
      name: 'Old',
      updated_at: '2026-01-01T00:00:00Z',
    });

    await applyAccountEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteAccount({
        id: 'a1',
        name: 'New',
        updated_at: '2026-02-01T00:00:00Z',
      }),
    });

    expect(
      await adapter.getFirstAsync('SELECT name FROM accounts WHERE id = ?', [
        'a1',
      ])
    ).toEqual({ name: 'New' });
  });
});

// #21: the recurring_rules channel. A new export, so these cannot load on
// 112b060: their red proofs are mutants of the production code (routing the
// live upsert through forceUpsertRemoteRule, or the tombstone through an
// unscoped DELETE).
const ruleRows = () =>
  (
    adapter._sqlite
      .prepare(
        'SELECT id, next_date, _sync_status FROM recurring_rules ORDER BY id'
      )
      .all() as any[]
  ).map((r) => `${r.id}:${r.next_date}:${r._sync_status}`);

describe('applyRuleEvent (#21)', () => {
  it('RL1: applies a newer live rule over a synced one', async () => {
    await insertLocalRule(adapter, {
      id: 'r1',
      next_date: '2026-11-01',
      updated_at: '2026-10-01T00:00:00+00:00',
    });

    await applyRuleEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteRule({
        id: 'r1',
        next_date: '2026-12-01',
        updated_at: '2026-10-20T00:00:00+00:00',
      }),
    });

    expect(ruleRows()).toEqual(['r1:2026-12-01:synced']);
  });

  it('RL2: leaves a PENDING rule (a post or an edit not pushed yet) untouched', async () => {
    await insertLocalRule(adapter, {
      id: 'r1',
      next_date: '2026-12-01',
      updated_at: '2026-10-21T00:00:00+00:00',
      _sync_status: 'pending',
    });

    await applyRuleEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteRule({
        id: 'r1',
        next_date: '2026-11-01',
        updated_at: '2026-10-22T00:00:00+00:00',
      }),
    });

    expect(ruleRows()).toEqual(['r1:2026-12-01:pending']);
  });

  // The killer of the NULL arm dropped from the shared guard (found by the
  // sync attack on the design): a synced rule with no stamp takes any live
  // version, as the pull's guard has it ("updated_at IS NULL OR ...").
  it('RL2b: applies a live rule over a synced one that has no stamp', async () => {
    await insertLocalRule(adapter, { id: 'r1', next_date: '2026-11-01' });
    adapter._sqlite
      .prepare("UPDATE recurring_rules SET updated_at = NULL WHERE id = 'r1'")
      .run();

    await applyRuleEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteRule({
        id: 'r1',
        next_date: '2026-12-01',
        updated_at: '2026-10-22T00:00:00+00:00',
      }),
    });

    expect(ruleRows()).toEqual(['r1:2026-12-01:synced']);
  });

  it('RL3: refuses an older live rule (the last-write-wins guard of the pull)', async () => {
    await insertLocalRule(adapter, {
      id: 'r1',
      next_date: '2026-12-01',
      updated_at: '2026-10-20T00:00:00+00:00',
    });

    await applyRuleEvent(adapter, {
      eventType: 'UPDATE',
      new: remoteRule({
        id: 'r1',
        next_date: '2026-11-01',
        updated_at: '2026-10-01T00:00:00+00:00',
      }),
    });

    expect(ruleRows()).toEqual(['r1:2026-12-01:synced']);
  });

  it('RL4: consumes a tombstone of a synced rule, spares a pending one, and inserts nothing for one never held', async () => {
    await insertLocalRule(adapter, { id: 'r1' });
    await insertLocalRule(adapter, { id: 'r2', _sync_status: 'pending' });
    const dead = (id: string) => ({
      eventType: 'UPDATE',
      new: remoteRule({ id, deleted_at: TOMBSTONED_AT }),
    });

    await applyRuleEvent(adapter, dead('r1'));
    await applyRuleEvent(adapter, dead('r2'));
    await applyRuleEvent(adapter, dead('gone'));

    expect(ruleRows()).toEqual(['r2:2026-02-01:pending']);
  });

  it('RL5: scopes a hard DELETE to synced rules', async () => {
    await insertLocalRule(adapter, { id: 'r1' });
    await insertLocalRule(adapter, { id: 'r2', _sync_status: 'deleted' });

    await applyRuleEvent(adapter, { eventType: 'DELETE', old: { id: 'r1' } });
    await applyRuleEvent(adapter, { eventType: 'DELETE', old: { id: 'r2' } });

    expect(ruleRows()).toEqual(['r2:2026-02-01:deleted']);
  });

  it('RL6: inserts a rule created on another device', async () => {
    await applyRuleEvent(adapter, {
      eventType: 'INSERT',
      new: remoteRule({ id: 'r9', template: { payee: 'Rent', splits: [] } }),
    });

    expect({
      rows: ruleRows(),
      template: (
        adapter._sqlite
          .prepare('SELECT template FROM recurring_rules WHERE id = ?')
          .get('r9') as any
      ).template,
    }).toEqual({
      rows: ['r9:2026-02-01:synced'],
      template: '{"payee":"Rent","splits":[]}',
    });
  });
});

// #21: which parent a split event names, and which events are dropped.
describe('splitEventParent (#21)', () => {
  beforeEach(async () => {
    await insertLocalTxn(adapter, { id: 't1' });
    await insertLocalSplit(adapter, { id: 's1', transaction_id: 't1' });
    await insertLocalTxn(adapter, { id: 'tx', user_id: 'other' });
    await insertLocalSplit(adapter, { id: 'sx', transaction_id: 'tx' });
  });

  it("SP1: ties a DELETE to the parent of a split of the user's held here", async () => {
    expect(
      await splitEventParent(adapter, 'u', {
        eventType: 'DELETE',
        new: {},
        old: { id: 's1' },
      })
    ).toBe('t1');
  });

  it("SP2: drops a DELETE of another account's split, of one never held, and one with no id", async () => {
    const results = [];
    for (const old of [{ id: 'sx' }, { id: 'never-here' }, {}]) {
      results.push(
        await splitEventParent(adapter, 'u', {
          eventType: 'DELETE',
          new: {},
          old,
        })
      );
    }
    expect(results).toEqual([null, null, null]);
  });

  it('SP3: names the parent an INSERT or UPDATE carries, and nothing without one', async () => {
    const results = [];
    for (const event of [
      { eventType: 'INSERT', new: { id: 's2', transaction_id: 't1' } },
      { eventType: 'UPDATE', new: { id: 's1', transaction_id: 't1' } },
      { eventType: 'INSERT', new: { id: 's3' } },
    ]) {
      results.push(await splitEventParent(adapter, 'u', event));
    }
    expect(results).toEqual(['t1', 't1', null]);
  });

  it('SP4: writes nothing', async () => {
    await splitEventParent(adapter, 'u', {
      eventType: 'DELETE',
      new: {},
      old: { id: 's1' },
    });
    expect(await splitIds()).toEqual(['s1', 'sx']);
  });
});

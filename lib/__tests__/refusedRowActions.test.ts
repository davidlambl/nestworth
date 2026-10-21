// The move and the discard of a row the push can never upload (#115), as
// pure writers over the fixture's SQLite. The move is the first writer of
// account_id in the app. Both take only the version of the row the push was
// refused, still pending and still this user's, and fail readably otherwise.
// A new module: its regression proofs are the named mutants (the unit file),
// since this file cannot load on the code before it.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  applyRefusedRowDiscard,
  applyRefusedRowMove,
  type RefusedRowRef,
} from '../refusedRowActions';
import { fullSync, pushChanges } from '../sync';
import { refusedRowActions } from '../syncRefusals';
import { getSyncSnapshot, refreshSyncState } from '../syncStatus';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
  remoteAccount,
  toPgTimestamp,
  wireSyncMocks,
} from '../testing/syncFixture';
import { applyTransactionUpdate } from '../transactionUpdate';

const WRITTEN_AT = '2026-10-15T08:00:00.000Z';
const NOW = '2026-10-16T10:00:00.000Z';

let db: ReturnType<typeof makeAdapter>;

beforeEach(async () => {
  db = makeAdapter();
  // a1 is gone here (its tombstone pulled); a2 and a3 are live; a5 was
  // deleted on this device; b1 is another user's.
  await insertLocalAccount(db, { id: 'a2', name: 'Savings' });
  await insertLocalAccount(db, { id: 'a3', name: 'Brokerage' });
  await insertLocalAccount(db, {
    id: 'a5',
    name: 'Closed',
    _sync_status: 'deleted',
  });
  await insertLocalAccount(db, { id: 'b1', user_id: 'b', name: 'Theirs' });
  await insertLocalTxn(db, {
    id: 't1',
    account_id: 'a1',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  await insertLocalSplit(db, {
    id: 's1',
    transaction_id: 't1',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
});

afterEach(() => {
  db._sqlite.close();
});

const ref = (over: Partial<RefusedRowRef> = {}): RefusedRowRef => ({
  table: 'transactions',
  id: 't1',
  updatedAt: WRITTEN_AT,
  userId: 'u',
  ...over,
});

/** A refused rule of the user's (r1, under the gone a1) and one of another user's (rb). */
async function rules() {
  await insertLocalRule(db, {
    id: 'r1',
    account_id: 'a1',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
  await insertLocalRule(db, {
    id: 'rb',
    user_id: 'b',
    account_id: 'b0',
    updated_at: WRITTEN_AT,
    _sync_status: 'pending',
  });
}

const ruleRef = (over: Partial<RefusedRowRef> = {}): RefusedRowRef =>
  ref({ table: 'recurring_rules', id: 'r1', ...over });

const row = (table: string, id: string) =>
  db._sqlite
    .prepare(
      `SELECT account_id, updated_at, _sync_status FROM ${table} WHERE id = ?`
    )
    .get(id) as any;

const split = (id: string) =>
  db._sqlite
    .prepare(
      'SELECT updated_at, _sync_status FROM transaction_splits WHERE id = ?'
    )
    .get(id);

const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => (v === undefined ? 'resolved' : `resolved ${String(v)}`),
    (e) => String(e)
  );

describe('applyRefusedRowMove (#115)', () => {
  it('M1: moves the row to a live account, pending under a fresh stamp; its split lines stay as they are', async () => {
    expect(
      await outcome(applyRefusedRowMove(db, ref(), 'a3', { now: NOW }))
    ).toBe('resolved');

    expect(row('transactions', 't1')).toEqual({
      account_id: 'a3',
      updated_at: NOW,
      _sync_status: 'pending',
    });
    expect(split('s1')).toEqual({
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
  });

  it('M2: a row edited since the list was read is not moved', async () => {
    db._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = '2026-10-15T09:00:00.000Z' WHERE id = 't1'"
      )
      .run();

    expect(
      await outcome(applyRefusedRowMove(db, ref(), 'a3', { now: NOW }))
    ).toBe(
      'Error: This transaction changed on this device since the list was shown, so it was not moved.'
    );
    expect(row('transactions', 't1').account_id).toBe('a1');
  });

  it('M3: a row uploaded, deleted or gone since is not moved, each in its own words', async () => {
    db._sqlite
      .prepare(
        "UPDATE transactions SET _sync_status = 'synced' WHERE id = 't1'"
      )
      .run();
    const synced = await outcome(
      applyRefusedRowMove(db, ref(), 'a3', { now: NOW })
    );
    db._sqlite
      .prepare(
        "UPDATE transactions SET _sync_status = 'deleted' WHERE id = 't1'"
      )
      .run();
    const deleted = await outcome(
      applyRefusedRowMove(db, ref(), 'a3', { now: NOW })
    );
    const missing = await outcome(
      applyRefusedRowMove(db, ref({ id: 't-none' }), 'a3', { now: NOW })
    );

    expect({
      synced,
      deleted,
      missing,
      account: row('transactions', 't1').account_id,
    }).toEqual({
      synced:
        'Error: This transaction changed on this device since the list was shown, so it was not moved.',
      deleted:
        'Error: This transaction was deleted on this device, so it was not moved.',
      missing:
        'Error: This transaction no longer exists on this device, so it was not moved.',
      account: 'a1',
    });
  });

  it("M4: an account deleted here, gone, or another user's is refused, and the row stays", async () => {
    const deleted = await outcome(
      applyRefusedRowMove(db, ref(), 'a5', { now: NOW })
    );
    const gone = await outcome(
      applyRefusedRowMove(db, ref(), 'a9', { now: NOW })
    );
    const theirs = await outcome(
      applyRefusedRowMove(db, ref(), 'b1', { now: NOW })
    );

    expect({ deleted, gone, theirs, row: row('transactions', 't1') }).toEqual({
      deleted:
        'Error: The account you chose was deleted on this device, so the transaction was not moved.',
      gone: 'Error: The account you chose no longer exists on this device, so the transaction was not moved.',
      theirs:
        'Error: The account you chose no longer exists on this device, so the transaction was not moved.',
      row: {
        account_id: 'a1',
        updated_at: WRITTEN_AT,
        _sync_status: 'pending',
      },
    });
  });

  it('M5: one side of a transfer moves, its link kept, but never into the account of its other side', async () => {
    db._sqlite
      .prepare("UPDATE transactions SET transfer_link_id = 'K' WHERE id = 't1'")
      .run();
    await insertLocalTxn(db, {
      id: 't2',
      account_id: 'a2',
      transfer_link_id: 'K',
      amount: 50,
    });

    const intoOther = await outcome(
      applyRefusedRowMove(db, ref(), 'a2', { now: NOW })
    );
    const elsewhere = await outcome(
      applyRefusedRowMove(db, ref(), 'a3', { now: NOW })
    );

    expect({
      intoOther,
      elsewhere,
      legs: db._sqlite
        .prepare(
          'SELECT id, account_id, transfer_link_id, _sync_status FROM transactions ORDER BY id'
        )
        .all(),
    }).toEqual({
      intoOther:
        'Error: The other side of this transfer is in the account you chose, so the transaction was not moved.',
      elsewhere: 'resolved',
      legs: [
        {
          id: 't1',
          account_id: 'a3',
          transfer_link_id: 'K',
          _sync_status: 'pending',
        },
        {
          id: 't2',
          account_id: 'a2',
          transfer_link_id: 'K',
          _sync_status: 'synced',
        },
      ],
    });
  });

  it('M6: a rule moves the same way', async () => {
    await insertLocalRule(db, {
      id: 'r1',
      account_id: 'a1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    const moved = await outcome(
      applyRefusedRowMove(
        db,
        ref({ table: 'recurring_rules', id: 'r1' }),
        'a2',
        { now: NOW }
      )
    );
    const again = await outcome(
      applyRefusedRowMove(
        db,
        ref({ table: 'recurring_rules', id: 'r1' }),
        'a3',
        { now: NOW }
      )
    );

    expect({ moved, again, rule: row('recurring_rules', 'r1') }).toEqual({
      moved: 'resolved',
      again:
        'Error: This rule changed on this device since the list was shown, so it was not moved.',
      rule: { account_id: 'a2', updated_at: NOW, _sync_status: 'pending' },
    });
  });

  it('M7: a row with no stamp (NULL) is matched NULL-safely', async () => {
    await insertLocalTxn(db, {
      id: 't0',
      account_id: 'a1',
      _sync_status: 'pending',
    });
    db._sqlite
      .prepare("UPDATE transactions SET updated_at = NULL WHERE id = 't0'")
      .run();

    expect(
      await outcome(
        applyRefusedRowMove(db, ref({ id: 't0', updatedAt: null }), 'a2', {
          now: NOW,
        })
      )
    ).toBe('resolved');
    expect(row('transactions', 't0').account_id).toBe('a2');
  });

  it("M8: another user's row is not this user's to move", async () => {
    await insertLocalTxn(db, {
      id: 'tb',
      user_id: 'b',
      account_id: 'a1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    expect(
      await outcome(
        applyRefusedRowMove(db, ref({ id: 'tb' }), 'a2', { now: NOW })
      )
    ).toBe(
      'Error: This transaction no longer exists on this device, so it was not moved.'
    );
    expect(row('transactions', 'tb').account_id).toBe('a1');
  });

  // M9-M12 (and D6 below) came from the sync attack on the design (SYNC2):
  // the rule's statements are separate text, and every guard the
  // transaction's carries, the rule's must carry too.

  it('M9: a rule uploaded or discarded since is not moved (one synced would be re-uploaded under another account; one deleted, revived)', async () => {
    await rules();
    db._sqlite
      .prepare(
        "UPDATE recurring_rules SET _sync_status = 'synced' WHERE id = 'r1'"
      )
      .run();
    const synced = await outcome(
      applyRefusedRowMove(db, ruleRef(), 'a2', { now: NOW })
    );
    const afterSynced = row('recurring_rules', 'r1');
    db._sqlite
      .prepare(
        "UPDATE recurring_rules SET _sync_status = 'deleted' WHERE id = 'r1'"
      )
      .run();

    expect({
      synced,
      afterSynced,
      deleted: await outcome(
        applyRefusedRowMove(db, ruleRef(), 'a2', { now: NOW })
      ),
      r1: row('recurring_rules', 'r1'),
    }).toEqual({
      synced:
        'Error: This rule changed on this device since the list was shown, so it was not moved.',
      afterSynced: {
        account_id: 'a1',
        updated_at: WRITTEN_AT,
        _sync_status: 'synced',
      },
      deleted:
        'Error: This rule was deleted on this device, so it was not moved.',
      r1: { account_id: 'a1', updated_at: WRITTEN_AT, _sync_status: 'deleted' },
    });
  });

  it("M10: a rule is never moved into an account deleted here, gone, or another user's", async () => {
    await rules();
    const out = [];
    for (const target of ['a5', 'a9', 'b1']) {
      out.push(
        await outcome(applyRefusedRowMove(db, ruleRef(), target, { now: NOW }))
      );
    }

    expect({ out, r1: row('recurring_rules', 'r1') }).toEqual({
      out: [
        'Error: The account you chose was deleted on this device, so the rule was not moved.',
        'Error: The account you chose no longer exists on this device, so the rule was not moved.',
        'Error: The account you chose no longer exists on this device, so the rule was not moved.',
      ],
      r1: { account_id: 'a1', updated_at: WRITTEN_AT, _sync_status: 'pending' },
    });
  });

  it("M11: another user's rule is neither moved nor discarded", async () => {
    await rules();

    expect({
      move: await outcome(
        applyRefusedRowMove(db, ruleRef({ id: 'rb' }), 'a2', { now: NOW })
      ),
      discard: await outcome(
        applyRefusedRowDiscard(db, ruleRef({ id: 'rb' }), { now: NOW })
      ),
      rb: row('recurring_rules', 'rb'),
    }).toEqual({
      move: 'Error: This rule no longer exists on this device, so it was not moved.',
      discard: 'resolved false',
      rb: { account_id: 'b0', updated_at: WRITTEN_AT, _sync_status: 'pending' },
    });
  });

  it('M12: one side of a transfer moves into the account of an other side that was discarded', async () => {
    await insertLocalTxn(db, {
      id: 'L1',
      account_id: 'a1',
      transfer_link_id: 'K',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await insertLocalTxn(db, {
      id: 'L2',
      account_id: 'a2',
      transfer_link_id: 'K',
      updated_at: WRITTEN_AT,
      _sync_status: 'deleted',
    });

    expect(
      await outcome(
        applyRefusedRowMove(db, ref({ id: 'L1' }), 'a2', { now: NOW })
      )
    ).toBe('resolved');
    expect(row('transactions', 'L1').account_id).toBe('a2');
  });

  it('M13: one side of a transfer never moves into the account of an other side whose status is NULL (no writer makes one; IS NOT, as the account guard)', async () => {
    db._sqlite
      .prepare("UPDATE transactions SET transfer_link_id = 'K' WHERE id = 't1'")
      .run();
    await insertLocalTxn(db, {
      id: 't2',
      account_id: 'a2',
      transfer_link_id: 'K',
      amount: 50,
    });
    db._sqlite
      .prepare("UPDATE transactions SET _sync_status = NULL WHERE id = 't2'")
      .run();

    const intoOther = await outcome(
      applyRefusedRowMove(db, ref(), 'a2', { now: NOW })
    );

    expect({ intoOther, t1: row('transactions', 't1') }).toEqual({
      intoOther:
        'Error: The other side of this transfer is in the account you chose, so the transaction was not moved.',
      t1: { account_id: 'a1', updated_at: WRITTEN_AT, _sync_status: 'pending' },
    });
  });
});

describe('applyRefusedRowDiscard (#115)', () => {
  it('D1: marks the row alone deleted; its split lines are left for the push, which takes them with it', async () => {
    expect(await outcome(applyRefusedRowDiscard(db, ref(), { now: NOW }))).toBe(
      'resolved true'
    );

    expect(row('transactions', 't1')).toEqual({
      account_id: 'a1',
      updated_at: NOW,
      _sync_status: 'deleted',
    });
    expect(split('s1')).toEqual({
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
  });

  it('D2: a second tap, or one after the push removed it, has nothing left to do', async () => {
    await applyRefusedRowDiscard(db, ref(), { now: NOW });
    const second = await outcome(
      applyRefusedRowDiscard(db, ref(), { now: NOW })
    );
    const gone = await outcome(
      applyRefusedRowDiscard(db, ref({ id: 't-none' }), { now: NOW })
    );

    expect({
      second,
      gone,
      stamp: row('transactions', 't1').updated_at,
    }).toEqual({
      second: 'resolved false',
      gone: 'resolved false',
      stamp: NOW,
    });
  });

  it('D3: a row edited or uploaded since the list was read is not discarded', async () => {
    db._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = '2026-10-15T09:00:00.000Z' WHERE id = 't1'"
      )
      .run();
    const edited = await outcome(
      applyRefusedRowDiscard(db, ref(), { now: NOW })
    );
    db._sqlite
      .prepare(
        "UPDATE transactions SET updated_at = ?, _sync_status = 'synced' WHERE id = 't1'"
      )
      .run(WRITTEN_AT);
    const uploaded = await outcome(
      applyRefusedRowDiscard(db, ref(), { now: NOW })
    );

    expect({
      edited,
      uploaded,
      status: row('transactions', 't1')._sync_status,
    }).toEqual({
      edited:
        'Error: This transaction changed on this device since the list was shown, so it was not discarded.',
      uploaded:
        'Error: This transaction changed on this device since the list was shown, so it was not discarded.',
      status: 'synced',
    });
  });

  it('D4: a rule is discarded the same way, and one side of a transfer leaves the other side as it is', async () => {
    await insertLocalRule(db, {
      id: 'r1',
      account_id: 'a1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    db._sqlite
      .prepare("UPDATE transactions SET transfer_link_id = 'K' WHERE id = 't1'")
      .run();
    await insertLocalTxn(db, {
      id: 't2',
      account_id: 'a2',
      transfer_link_id: 'K',
      amount: 50,
    });

    const rule = await outcome(
      applyRefusedRowDiscard(db, ref({ table: 'recurring_rules', id: 'r1' }), {
        now: NOW,
      })
    );
    const leg = await outcome(applyRefusedRowDiscard(db, ref(), { now: NOW }));

    expect({
      rule,
      leg,
      ruleRow: row('recurring_rules', 'r1')._sync_status,
      other: row('transactions', 't2'),
    }).toEqual({
      rule: 'resolved true',
      leg: 'resolved true',
      ruleRow: 'deleted',
      other: {
        account_id: 'a2',
        updated_at: '2026-01-01T00:00:00Z',
        _sync_status: 'synced',
      },
    });
  });

  it("D5: another user's row is not this user's to discard", async () => {
    await insertLocalTxn(db, {
      id: 'tb',
      user_id: 'b',
      account_id: 'a1',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });

    expect(
      await outcome(applyRefusedRowDiscard(db, ref({ id: 'tb' }), { now: NOW }))
    ).toBe('resolved false');
    expect(row('transactions', 'tb')._sync_status).toBe('pending');
  });

  it('D6: a rule uploaded since is not discarded (its tombstone would delete it everywhere)', async () => {
    await rules();
    db._sqlite
      .prepare(
        "UPDATE recurring_rules SET _sync_status = 'synced' WHERE id = 'r1'"
      )
      .run();

    expect({
      discard: await outcome(
        applyRefusedRowDiscard(db, ruleRef(), { now: NOW })
      ),
      r1: row('recurring_rules', 'r1'),
    }).toEqual({
      discard:
        'Error: This rule changed on this device since the list was shown, so it was not discarded.',
      r1: { account_id: 'a1', updated_at: WRITTEN_AT, _sync_status: 'synced' },
    });
  });
});

describe('through the real push (#115)', () => {
  let ctx: ReturnType<typeof wireSyncMocks>;
  let quiet: jest.SpyInstance[];

  beforeEach(async () => {
    ctx = wireSyncMocks();
    quiet = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {})
    );
    ctx.store.accounts = [
      remoteAccount({
        id: 'a1',
        name: 'Old',
        deleted_at: '2026-10-14T09:00:00+00:00',
      }),
      remoteAccount({ id: 'a2', name: 'Savings' }),
      remoteAccount({ id: 'a3', name: 'Brokerage' }),
    ];
    for (const id of ['a1', 'a2', 'a3']) {
      await insertLocalAccount(ctx.adapter, { id });
    }
    await insertLocalTxn(ctx.adapter, {
      id: 'L1',
      account_id: 'a1',
      amount: -50,
      transfer_link_id: 'K',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await insertLocalTxn(ctx.adapter, {
      id: 'L2',
      account_id: 'a2',
      amount: 50,
      transfer_link_id: 'K',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 'L1',
      amount: -50,
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    // The born-dead transfer: L2 goes up alone, L1 is refused.
    await pushChanges('u');
  });

  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    ctx.adapter._sqlite.close();
  });

  const server = () =>
    (ctx.store.transactions as any[]).map(
      (r) => `${r.id}@${r.account_id}#${r.transfer_link_id}`
    );

  it('P1: the moved side of a transfer goes up under its new account with its split line, the link intact', async () => {
    await applyRefusedRowMove(
      ctx.adapter,
      { table: 'transactions', id: 'L1', updatedAt: WRITTEN_AT, userId: 'u' },
      'a3',
      { now: NOW }
    );
    await pushChanges('u');

    expect({
      server: server(),
      splits: (ctx.store.transaction_splits as any[]).map(
        (x) => `${x.id}<${x.transaction_id}`
      ),
      local: ctx.adapter._sqlite
        .prepare('SELECT id, _sync_status FROM transactions ORDER BY id')
        .all(),
    }).toEqual({
      server: ['L2@a2#K', 'L1@a3#K'],
      splits: ['s1<L1'],
      local: [
        { id: 'L1', _sync_status: 'synced' },
        { id: 'L2', _sync_status: 'synced' },
      ],
    });
  });

  it('P2: the discarded side goes from this device with its split line, and the other side stays live', async () => {
    await applyRefusedRowDiscard(
      ctx.adapter,
      { table: 'transactions', id: 'L1', updatedAt: WRITTEN_AT, userId: 'u' },
      { now: NOW }
    );
    await pushChanges('u');

    expect({
      server: server(),
      local: ctx.adapter._sqlite
        .prepare('SELECT id, _sync_status FROM transactions ORDER BY id')
        .all(),
      splits: ctx.adapter._sqlite
        .prepare('SELECT COUNT(*) AS n FROM transaction_splits')
        .get(),
    }).toEqual({
      server: ['L2@a2#K'],
      local: [{ id: 'L2', _sync_status: 'synced' }],
      splits: { n: 0 },
    });
  });

  it("P4: the refused side is listed with its other side's account, whatever that side's status but deleted (a NULL, which no writer makes, is not a delete)", async () => {
    const listed = async () => {
      await refreshSyncState('u');
      return getSyncSnapshot().refusedRows.map((r) =>
        r.table === 'transactions'
          ? `${r.id}->${r.partnerAccountId}(${r.partnerAccountName})`
          : r.id
      );
    };
    const status = (s: string | null) =>
      ctx.adapter._sqlite
        .prepare("UPDATE transactions SET _sync_status = ? WHERE id = 'L2'")
        .run(s);

    const synced = await listed();
    status(null);
    const nullStatus = await listed();
    status('deleted');
    const deleted = await listed();

    expect({ synced, nullStatus, deleted }).toEqual({
      synced: ['L1->a2(Checking)'],
      nullStatus: ['L1->a2(Checking)'],
      deleted: ['L1->null(null)'],
    });
  });
});

describe('a transaction refused for its date, its account then deleted on another device (#115)', () => {
  const DELETED_AT = '2026-10-14T09:00:00+00:00';
  const SYNCED_AT = '2026-05-10T00:00:00Z';
  const LATER = '2026-10-16T11:00:00.000Z';
  let ctx: ReturnType<typeof wireSyncMocks>;
  let quiet: jest.SpyInstance[];
  /** The server's refusals of a row's own data, by id (the fixture's rowErrors). */
  let refusals: Map<string, unknown>;

  beforeEach(async () => {
    ctx = wireSyncMocks();
    quiet = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {})
    );
    // a1 deleted on another device, its tombstone not pulled here yet; a2 live.
    ctx.store.accounts = [
      remoteAccount({
        id: 'a1',
        name: 'Old',
        deleted_at: DELETED_AT,
        updated_at: DELETED_AT,
      }),
      remoteAccount({
        id: 'a2',
        name: 'Savings',
        updated_at: toPgTimestamp(SYNCED_AT),
      }),
    ];
    for (const [id, name] of [
      ['a1', 'Old'],
      ['a2', 'Savings'],
    ]) {
      await insertLocalAccount(ctx.adapter, {
        id,
        name,
        updated_at: SYNCED_AT,
      });
    }
    // A day-first date the old CSV import wrote (#36), under a1.
    await insertLocalTxn(ctx.adapter, {
      id: 't-date',
      account_id: 'a1',
      payee: 'Lunch',
      amount: -12.34,
      txn_date: '2026-15-01',
      updated_at: WRITTEN_AT,
      _sync_status: 'pending',
    });
    refusals = new Map([
      [
        't-date',
        {
          code: '22008',
          message: 'date/time field value out of range: "2026-15-01"',
          details: null,
          hint: 'Perhaps you need a different "datestyle" setting.',
        },
      ],
    ]);
    ctx.installSupabase({ rowErrors: refusals, foreignKeys: true });
  });

  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    ctx.adapter._sqlite.close();
  });

  /** The list as Settings shows it, and what it offers for each row. */
  const listed = async () => {
    await refreshSyncState('u');
    return getSyncSnapshot().refusedRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      code: r.code,
      accountLive: r.accountLive,
      ...refusedRowActions(r),
    }));
  };

  it('P3: is offered Move, not Discard alone, once its account is pulled away; moved, then edited in its new account, it uploads', async () => {
    // Refused for the date (Postgres casts the row before 005's trigger or the
    // foreign key looks at a1); the pull then removes a1 here.
    await fullSync('u');
    const pulledAway = await listed();

    await applyRefusedRowMove(
      ctx.adapter,
      {
        table: 'transactions',
        id: 't-date',
        updatedAt: WRITTEN_AT,
        userId: 'u',
      },
      'a2',
      { now: NOW }
    );
    await pushChanges('u');
    const moved = await listed();

    // The register's edit screen writes a date the server can read.
    await applyTransactionUpdate(
      ctx.adapter as any,
      { id: 't-date', accountId: 'a2', txnDate: '2026-01-15' },
      { now: LATER, newSplitId: () => 'unused' }
    );
    refusals.delete('t-date');
    await pushChanges('u');

    expect({
      accounts: ctx.adapter._sqlite
        .prepare('SELECT id FROM accounts ORDER BY id')
        .all(),
      pulledAway,
      moved,
      after: await listed(),
      server: (ctx.store.transactions as any[]).map(
        (r) =>
          `${r.id}@${r.account_id} ${r.txn_date} ${r.deleted_at == null ? 'live' : 'tombstoned'}`
      ),
    }).toEqual({
      accounts: [{ id: 'a2' }],
      pulledAway: [
        {
          id: 't-date',
          kind: 'rejected',
          code: '22008',
          accountLive: false,
          move: true,
          edit: false,
        },
      ],
      moved: [
        {
          id: 't-date',
          kind: 'rejected',
          code: '22008',
          accountLive: true,
          move: false,
          edit: true,
        },
      ],
      after: [],
      server: ['t-date@a2 2026-01-15 live'],
    });
  });
});

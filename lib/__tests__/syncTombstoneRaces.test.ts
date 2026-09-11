// Failure-path and race regressions found by review AFTER the four tombstone
// workstreams (#18) were merged. Each test here fails against the merged code
// and passes against the fix, so they are the reason those fixes exist.
//
// All three share a shape the sync engine has been burned by before: local data
// is destroyed on the strength of a read that was already stale, or of a read
// that never happened at all.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { initialPull, pullChanges, pushChanges } from '../sync';
import { supabase } from '../supabase';
import {
  insertLocalAccount,
  insertLocalSplit,
  insertLocalTxn,
  remoteAccount,
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

/**
 * Runs `flip` the moment a read whose SQL matches `match` resolves, i.e. in the
 * exact window between the pull snapshotting which rows are safe to delete and
 * the pull acting on that snapshot. The mutation hooks write straight to SQLite
 * and are not gated by `_syncInProgress`, so this is a window a real user hits
 * by typing during a background sync — not a theoretical one.
 */
function flipAfterRead(adapter: any, match: RegExp, flip: () => void) {
  const real = adapter.getAllAsync.bind(adapter);
  let fired = false;
  adapter.getAllAsync = async (sql: string, params: any[] = []) => {
    const rows = await real(sql, params);
    if (!fired && match.test(sql)) {
      fired = true;
      flip();
    }
    return rows;
  };
}

describe('pull deletes are scoped to synced rows, not to a stale snapshot', () => {
  it('keeps an account edited mid-pull instead of deleting it as remotely gone', async () => {
    await insertLocalAccount(ctx.adapter, { id: 'a1', name: 'Checking' });
    // a1 is tombstoned remotely, so it lands in the absence-based delete loop.
    ctx.store.accounts = [
      remoteAccount({ id: 'a1', deleted_at: '2026-06-16T00:00:00Z' }),
      remoteAccount({ id: 'a9', name: 'Savings' }),
    ];

    flipAfterRead(
      ctx.adapter,
      /FROM accounts[\s\S]*_sync_status = 'synced'/,
      () => {
        ctx.adapter._sqlite
          .prepare(
            `UPDATE accounts SET name = 'Renamed', _sync_status = 'pending' WHERE id = 'a1'`
          )
          .run();
      }
    );

    await pullChanges('u');

    const a1: any = ctx.adapter._sqlite
      .prepare('SELECT name, _sync_status FROM accounts WHERE id = ?')
      .get('a1');
    expect(a1).toEqual({ name: 'Renamed', _sync_status: 'pending' });
  });

  it('keeps a transaction edited mid-pull instead of deleting it in the reconcile', async () => {
    await insertLocalTxn(ctx.adapter, { id: 't1', payee: 'Rent' });
    await insertLocalSplit(ctx.adapter, { id: 's1', transaction_id: 't1' });
    // t1 is absent from the server, so the reconcile plans to delete it. No
    // last_txn_reconcile_at key means the reconcile is due.
    ctx.store.transactions = [remoteTxn({ id: 't9' })];

    flipAfterRead(ctx.adapter, /reconcilable/, () => {
      ctx.adapter._sqlite
        .prepare(
          `UPDATE transactions SET payee = 'Rent (fixed)', _sync_status = 'pending' WHERE id = 't1'`
        )
        .run();
    });

    await pullChanges('u');

    const t1: any = ctx.adapter._sqlite
      .prepare('SELECT payee, _sync_status FROM transactions WHERE id = ?')
      .get('t1');
    expect(t1).toEqual({ payee: 'Rent (fixed)', _sync_status: 'pending' });
    // The splits must survive with it, or the edit is saved but gutted.
    const splits = ctx.adapter._sqlite
      .prepare('SELECT id FROM transaction_splits WHERE transaction_id = ?')
      .all('t1');
    expect(splits).toEqual([{ id: 's1' }]);
  });
});

describe('the transaction cursor is only banked on a pull that actually read', () => {
  it('leaves last_txn_pull_at alone when the incremental page errors', async () => {
    ctx.meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');
    ctx.meta.set('last_pull_at:u', '2026-06-15T00:00:00Z');
    ctx.installSupabase({ errorReadsOn: new Set(['transactions']) });

    await pullChanges('u');

    // Advancing here would put the unread window permanently behind the cursor:
    // `gt('updated_at', cursor)` can never return it again, and the periodic
    // reconcile that used to back-fill it is now up to a day away.
    expect(ctx.meta.get('last_txn_pull_at:u')).toBe('2026-06-15T00:00:00Z');
  });

  it('still advances the cursor on a clean pull', async () => {
    ctx.meta.set('last_txn_pull_at:u', '2026-06-15T00:00:00Z');
    ctx.store.transactions = [remoteTxn({ id: 't1' })];

    await pullChanges('u');

    expect(ctx.meta.get('last_txn_pull_at:u')).not.toBe('2026-06-15T00:00:00Z');
  });
});

describe('a push the server refuses never destroys the local row', () => {
  // The server-side counterpart is the 23503 that inherit_account_tombstone
  // raises for a child written into a tombstoned account. That rejection is the
  // whole reason a never-synced row survives: were it stamped deleted_at
  // instead, push would read the tombstone back and hard-delete data the server
  // has never held.
  it('leaves an offline-created transaction pending when the insert is rejected', async () => {
    await insertLocalTxn(ctx.adapter, {
      id: 't-new',
      payee: 'Groceries',
      _sync_status: 'pending',
    });
    await insertLocalSplit(ctx.adapter, {
      id: 's-new',
      transaction_id: 't-new',
      _sync_status: 'pending',
    });
    ctx.installSupabase({ failWritesOn: new Set(['transactions']) });

    await pushChanges('u');

    const t: any = ctx.adapter._sqlite
      .prepare('SELECT payee, _sync_status FROM transactions WHERE id = ?')
      .get('t-new');
    expect(t).toEqual({ payee: 'Groceries', _sync_status: 'pending' });
    expect(
      ctx.adapter._sqlite
        .prepare('SELECT id FROM transaction_splits WHERE transaction_id = ?')
        .all('t-new')
    ).toEqual([{ id: 's-new' }]);
    expect(ctx.store.transactions).toEqual([]);
  });
});

describe('the reconcile interval is only banked by a pass that completed', () => {
  it('does not bank the key when a refresh batch fails', async () => {
    // Drifted row: local says January, the server says February, so the pass
    // plans a refresh. Cursor is later than both, so step 1 pulls nothing and
    // the reconcile is the only thing acting.
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      updated_at: '2026-01-01T00:00:00Z',
    });
    ctx.store.transactions = [
      remoteTxn({ id: 't1', updated_at: '2026-02-01T00:00:00Z' }),
    ];
    ctx.meta.set('last_txn_pull_at:u', '2026-03-01T00:00:00Z');

    const fake = ctx.installSupabase({});
    const realFrom = fake.from;
    (supabase as any).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== 'transactions') return builder;
      // Only the refresh read uses .in(); the enumeration uses .eq/.order/.range,
      // so this fails the refresh alone and leaves the enumeration healthy.
      return {
        ...builder,
        select: () => ({
          ...builder,
          in: () => {
            const failed = { data: null, error: { message: 'boom' } };
            const thenable: any = {
              is: () => Promise.resolve(failed),
              then: (res: any, rej: any) =>
                Promise.resolve(failed).then(res, rej),
            };
            return thenable;
          },
        }),
      };
    };

    await pullChanges('u');

    // Banking here would record a reconcile that demonstrably did not finish,
    // and hide the un-refreshed row for a full day.
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeFalsy();
  });
});

describe('an all-deleted answer is honoured, not mistaken for an empty read', () => {
  it('deletes a local row when the enumeration returns only tombstones', async () => {
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    // The tombstone predates the cursor, so the incremental path cannot see it
    // and only the enumeration can resolve this.
    ctx.store.transactions = [
      remoteTxn({
        id: 't1',
        updated_at: '2026-02-01T00:00:00Z',
        deleted_at: '2026-02-01T00:00:00Z',
      }),
    ];
    ctx.meta.set('last_txn_pull_at:u', '2026-03-01T00:00:00Z');

    await pullChanges('u');

    // Filtering tombstones out server-side would make this read look identical
    // to a mis-scoped RLS policy, and the #19 guard would refuse it forever.
    expect(
      ctx.adapter._sqlite.prepare('SELECT id FROM transactions').all()
    ).toEqual([]);
    expect(ctx.meta.get('last_txn_reconcile_at:u')).toBeTruthy();
  });
});

describe('initialPull stamps its cursors from before the bootstrap reads', () => {
  it('does not declare changes made during the bootstrap already pulled', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];

    let midpoint = '';
    const realRun = ctx.adapter.runAsync.bind(ctx.adapter);
    ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const out = await realRun(sql, params);
      if (!midpoint && /INSERT INTO transactions/.test(sql)) {
        await new Promise((r) => setTimeout(r, 10));
        midpoint = new Date().toISOString();
      }
      return out;
    };

    await initialPull('u');

    // A bootstrap of a real history takes many round trips. Stamping the cursor
    // with an end-of-pull "now" declares that whole window pulled, so anything
    // another device committed during it is skipped by `gt(updated_at, cursor)`
    // forever.
    expect(midpoint).toBeTruthy();
    expect(
      Date.parse(ctx.meta.get('last_txn_pull_at:u') as string)
    ).toBeLessThan(Date.parse(midpoint));
    expect(Date.parse(ctx.meta.get('last_pull_at:u') as string)).toBeLessThan(
      Date.parse(midpoint)
    );
  });
});

describe('a tombstone the server never accepted stays queued', () => {
  // Without these, reverting the push loop to its old splits-before-parent order,
  // or dropping the `if (error)` bail entirely, leaves the suite green while the
  // local row is hard-deleted despite the server never hearing about it — the
  // delete would then be lost on every other device.
  it('keeps a deleted transaction locally when the tombstone UPDATE fails', async () => {
    await insertLocalTxn(ctx.adapter, { id: 't1', _sync_status: 'deleted' });
    await insertLocalSplit(ctx.adapter, { id: 's1', transaction_id: 't1' });
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.installSupabase({ failWritesOn: new Set(['transactions']) });

    await pushChanges('u');

    expect(
      ctx.adapter._sqlite
        .prepare('SELECT _sync_status FROM transactions WHERE id = ?')
        .get('t1')
    ).toEqual({ _sync_status: 'deleted' });
    // The remote row must still be live, so another device is not told to drop it.
    expect(ctx.store.transactions[0].deleted_at).toBeUndefined();
  });

  it('keeps a deleted account locally when its tombstone UPDATE fails', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      _sync_status: 'deleted',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.installSupabase({ failWritesOn: new Set(['accounts']) });

    await pushChanges('u');

    expect(
      ctx.adapter._sqlite
        .prepare('SELECT _sync_status FROM accounts WHERE id = ?')
        .get('a1')
    ).toEqual({ _sync_status: 'deleted' });
    expect(ctx.store.accounts[0].deleted_at).toBeUndefined();
  });
});

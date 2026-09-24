// applyTransactionDelete (#97): a delete marks the transaction and its splits,
// and the other leg of a transfer with its splits, in ONE SQLite transaction.
// useDeleteTransaction used to run those as separate statements, so an
// interruption between the split mark and the parent mark left 'deleted'
// splits under a live, synced parent: a row the reset guard counted and no push
// could clear, which refused "Reset & re-download" forever.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyTransactionDelete } from '../transactionDelete';
import {
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** The delete's timestamp. */
const NOW = '2026-09-24T12:00:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

/** `id:status@updated_at` for every row of a table, by id. */
function rows(table: 'transactions' | 'transaction_splits'): string[] {
  return (
    adapter._sqlite
      .prepare(`SELECT id, _sync_status, updated_at FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string; updated_at: string }[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}`);
}

async function seedTxn(
  id: string,
  splitIds: string[],
  extra: {
    account_id?: string;
    transfer_link_id?: string;
    _sync_status?: string;
  } = {}
) {
  await insertLocalTxn(adapter, { id, updated_at: SYNCED_AT, ...extra });
  for (const s of splitIds) {
    await insertLocalSplit(adapter, {
      id: s,
      transaction_id: id,
      updated_at: SYNCED_AT,
      _sync_status: extra._sync_status ?? 'synced',
    });
  }
}

/** Both legs of a synced transfer, each with one split. */
async function seedTransfer() {
  await seedTxn('from', ['from-s'], {
    account_id: 'acc-checking',
    transfer_link_id: 'link',
  });
  await seedTxn('to', ['to-s'], {
    account_id: 'acc-savings',
    transfer_link_id: 'link',
  });
}

/**
 * The adapter, except that the `nth` runAsync whose SQL starts with `prefix`
 * throws. Pattern: applyTransactionUpdate.test.ts's linked-update failure.
 */
function failingOn(prefix: string, nth: number) {
  let calls = 0;
  return {
    ...adapter,
    runAsync: async (sql: string, params: any[] = []) => {
      if (sql.startsWith(prefix) && ++calls === nth) {
        throw new Error(`simulated failure on ${prefix} #${nth}`);
      }
      return adapter.runAsync(sql, params);
    },
  };
}

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  return 'resolved';
}

describe('applyTransactionDelete', () => {
  it('marks the transaction and its splits deleted with one timestamp', async () => {
    await seedTxn('t1', ['s1', 's2']);
    await seedTxn('t2', ['s3']);

    const result = await applyTransactionDelete(adapter, 't1', { now: NOW });

    expect(result).toEqual({
      linkedTransactionId: null,
      linkedAccountId: null,
    });
    expect(rows('transactions')).toEqual([
      `t1:deleted@${NOW}`,
      `t2:synced@${SYNCED_AT}`,
    ]);
    expect(rows('transaction_splits')).toEqual([
      `s1:deleted@${NOW}`,
      `s2:deleted@${NOW}`,
      `s3:synced@${SYNCED_AT}`,
    ]);
  });

  it('marks both transfer legs and returns the linked leg, and skips a leg already deleted', async () => {
    await seedTransfer();

    const result = await applyTransactionDelete(adapter, 'from', { now: NOW });

    expect(result).toEqual({
      linkedTransactionId: 'to',
      linkedAccountId: 'acc-savings',
    });
    expect(rows('transactions')).toEqual([
      `from:deleted@${NOW}`,
      `to:deleted@${NOW}`,
    ]);
    expect(rows('transaction_splits')).toEqual([
      `from-s:deleted@${NOW}`,
      `to-s:deleted@${NOW}`,
    ]);

    // A pair whose other leg is already deleted: that leg is not the linked
    // one, and its rows keep the stamp of their own delete.
    await seedTxn('x-from', ['x-from-s'], {
      account_id: 'acc-checking',
      transfer_link_id: 'link-x',
    });
    await seedTxn('x-to', ['x-to-s'], {
      account_id: 'acc-savings',
      transfer_link_id: 'link-x',
      _sync_status: 'deleted',
    });
    const later = '2026-09-24T13:00:00.000Z';

    const second = await applyTransactionDelete(adapter, 'x-from', {
      now: later,
    });

    expect(second).toEqual({
      linkedTransactionId: null,
      linkedAccountId: null,
    });
    expect(rows('transactions')).toEqual([
      `from:deleted@${NOW}`,
      `to:deleted@${NOW}`,
      `x-from:deleted@${later}`,
      `x-to:deleted@${SYNCED_AT}`,
    ]);
    expect(rows('transaction_splits')).toEqual([
      `from-s:deleted@${NOW}`,
      `to-s:deleted@${NOW}`,
      `x-from-s:deleted@${later}`,
      `x-to-s:deleted@${SYNCED_AT}`,
    ]);
  });

  it('rolls back the split marks when the parent update fails', async () => {
    await seedTxn('t1', ['s1', 's2']);
    const before = {
      transactions: rows('transactions'),
      splits: rows('transaction_splits'),
    };

    const err = await rejectionOf(
      applyTransactionDelete(failingOn('UPDATE transactions SET', 1), 't1', {
        now: NOW,
      })
    );

    expect(err).toContain('simulated failure on UPDATE transactions SET #1');
    // Without the transaction the splits would stay 'deleted' under a synced
    // parent: the state no push could clear (#97).
    expect(rows('transaction_splits')).toEqual(before.splits);
    expect(rows('transactions')).toEqual(before.transactions);
  });

  it('rolls back the primary leg when the linked leg fails', async () => {
    await seedTransfer();
    const before = {
      transactions: rows('transactions'),
      splits: rows('transaction_splits'),
    };

    // The second parent update is the linked leg's.
    const err = await rejectionOf(
      applyTransactionDelete(failingOn('UPDATE transactions SET', 2), 'from', {
        now: NOW,
      })
    );

    expect(err).toContain('simulated failure on UPDATE transactions SET #2');
    // Neither leg, nor any split, is half-deleted.
    expect(rows('transactions')).toEqual(before.transactions);
    expect(rows('transaction_splits')).toEqual(before.splits);
  });
});

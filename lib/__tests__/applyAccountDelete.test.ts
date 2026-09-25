// applyAccountDelete (#114): deleting an account marks its transactions, its
// recurring rules and the account itself deleted in ONE SQLite transaction.
// useDeleteAccount used to run those as three separate statements, so an
// interruption between them left a half-deleted account: its children deleted
// under a live account, shown as an emptied account until the user deleted it
// again. The last describe drives the hook itself, so a hook whose marks stop
// being atomic, or that requests the push early or not at all, fails here too.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
// The hook's own imports are stubbed as in useReorderAccounts.test.ts, whose
// recipe the hook tests follow: react-test-renderer and createElement, a real
// QueryClient, and getDb answering with the fixture's better-sqlite3 adapter.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { applyAccountDelete } from '../accountDelete';
import { useDeleteAccount } from '../hooks/useAccounts';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalSplit,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When the rows written offline since the last push were written. */
const EDITED_AT = '2026-09-20T09:00:00.000Z';
/** The delete's timestamp. */
const NOW = '2026-09-25T12:00:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

/** `id:status@updated_at` for every row of a table, by id. */
function rows(
  table: 'accounts' | 'transactions' | 'transaction_splits' | 'recurring_rules'
): string[] {
  return (
    adapter._sqlite
      .prepare(`SELECT id, _sync_status, updated_at FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string; updated_at: string }[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}`);
}

/** `id:status` for every row of a table: for the hook, whose clock is real. */
function statuses(table: Parameters<typeof rows>[0]): string[] {
  return rows(table).map((r) => r.slice(0, r.indexOf('@')));
}

/** Every table at once, for the rollback tests to compare against. */
function allRows() {
  return {
    accounts: rows('accounts'),
    transactions: rows('transactions'),
    rules: rows('recurring_rules'),
    splits: rows('transaction_splits'),
  };
}

/**
 * Two synced accounts. a1 is the one deleted: t1 with two splits, t2 the leg
 * of a transfer into a2, and rule r1. a2 holds t3 (the transfer's other leg),
 * t4 with a split, and rule r2.
 */
async function seedTwoAccounts() {
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(adapter, {
    id: 'a2',
    name: 'Savings',
    type: 'savings',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 't1',
    account_id: 'a1',
    updated_at: SYNCED_AT,
  });
  for (const s of ['s1', 's2']) {
    await insertLocalSplit(adapter, {
      id: s,
      transaction_id: 't1',
      updated_at: SYNCED_AT,
    });
  }
  await insertLocalTxn(adapter, {
    id: 't2',
    account_id: 'a1',
    transfer_link_id: 'link',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 't3',
    account_id: 'a2',
    transfer_link_id: 'link',
    updated_at: SYNCED_AT,
  });
  await insertLocalTxn(adapter, {
    id: 't4',
    account_id: 'a2',
    updated_at: SYNCED_AT,
  });
  await insertLocalSplit(adapter, {
    id: 's3',
    transaction_id: 't4',
    updated_at: SYNCED_AT,
  });
  await insertLocalRule(adapter, {
    id: 'r1',
    account_id: 'a1',
    updated_at: SYNCED_AT,
  });
  await insertLocalRule(adapter, {
    id: 'r2',
    account_id: 'a2',
    updated_at: SYNCED_AT,
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

describe('applyAccountDelete', () => {
  it('marks the account, its transactions and its rules deleted with one timestamp, and nothing else', async () => {
    await seedTwoAccounts();

    await applyAccountDelete(adapter, 'a1', { now: NOW });

    expect(rows('accounts')).toEqual([
      `a1:deleted@${NOW}`,
      `a2:synced@${SYNCED_AT}`,
    ]);
    expect(rows('transactions')).toEqual([
      `t1:deleted@${NOW}`,
      `t2:deleted@${NOW}`,
      // The transfer's other leg lives in a2 and stays live, its link
      // dangling: the linked-leg lookups skip a deleted leg. Today's
      // behaviour, kept (#114).
      `t3:synced@${SYNCED_AT}`,
      `t4:synced@${SYNCED_AT}`,
    ]);
    expect(rows('recurring_rules')).toEqual([
      `r1:deleted@${NOW}`,
      `r2:synced@${SYNCED_AT}`,
    ]);
    // Splits are not marked: the push's deleted-transactions path removes a
    // dead parent's splits, on the server and here, whatever their status.
    expect(rows('transaction_splits')).toEqual([
      `s1:synced@${SYNCED_AT}`,
      `s2:synced@${SYNCED_AT}`,
      `s3:synced@${SYNCED_AT}`,
    ]);
  });

  it('marks a pending child that never reached the server deleted too', async () => {
    await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
    await insertLocalTxn(adapter, {
      id: 't-old',
      account_id: 'a1',
      updated_at: SYNCED_AT,
    });
    // Written offline since the last push: the server has neither row.
    await insertLocalTxn(adapter, {
      id: 't-new',
      account_id: 'a1',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });
    await insertLocalSplit(adapter, {
      id: 's-new',
      transaction_id: 't-new',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });
    await insertLocalRule(adapter, {
      id: 'r-new',
      account_id: 'a1',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });

    await applyAccountDelete(adapter, 'a1', { now: NOW });

    // No _sync_status filter, as before #114. The push's tombstone UPDATE
    // then matches no server row, which is its success case, and the local
    // row (a transaction with its splits) is hard-deleted.
    expect(rows('accounts')).toEqual([`a1:deleted@${NOW}`]);
    expect(rows('transactions')).toEqual([
      `t-new:deleted@${NOW}`,
      `t-old:deleted@${NOW}`,
    ]);
    expect(rows('recurring_rules')).toEqual([`r-new:deleted@${NOW}`]);
    expect(rows('transaction_splits')).toEqual([`s-new:pending@${EDITED_AT}`]);
  });

  it("rolls back the children's marks when the account update fails", async () => {
    await seedTwoAccounts();
    const before = allRows();

    const err = await rejectionOf(
      applyAccountDelete(failingOn('UPDATE accounts SET', 1), 'a1', {
        now: NOW,
      })
    );

    expect(err).toContain('simulated failure on UPDATE accounts SET #1');
    // Without the transaction a1's transactions and rule would stay deleted
    // under a live account.
    expect(rows('transactions')).toEqual(before.transactions);
    expect(rows('recurring_rules')).toEqual(before.rules);
    expect(rows('accounts')).toEqual(before.accounts);
    expect(rows('transaction_splits')).toEqual(before.splits);
  });

  it("rolls back the transactions' marks when the rules update fails", async () => {
    await seedTwoAccounts();
    const before = allRows();

    const err = await rejectionOf(
      applyAccountDelete(failingOn('UPDATE recurring_rules SET', 1), 'a1', {
        now: NOW,
      })
    );

    expect(err).toContain('simulated failure on UPDATE recurring_rules SET #1');
    // Without the transaction a1's transactions would stay deleted under a
    // live account and live rules.
    expect(rows('transactions')).toEqual(before.transactions);
    expect(rows('recurring_rules')).toEqual(before.rules);
    expect(rows('accounts')).toEqual(before.accounts);
    expect(rows('transaction_splits')).toEqual(before.splits);
  });
});

describe('useDeleteAccount', () => {
  let qc: QueryClient;
  let renderer: ReactTestRenderer;
  let deleteAccount: ReturnType<typeof useDeleteAccount>;

  function Harness() {
    const mutation = useDeleteAccount();
    useEffect(() => {
      deleteAccount = mutation;
    });
    return null;
  }

  beforeEach(async () => {
    (requestPush as unknown as jest.Mock).mockClear();
    qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Harness)
        )
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      renderer.unmount();
    });
    qc.getMutationCache().clear();
    qc.clear();
  });

  /** Deletes `id` through the hook, with getDb answering `db`. */
  async function deleteThrough(db: unknown, id: string): Promise<string> {
    (getDb as unknown as jest.Mock).mockResolvedValue(db);
    let outcome = '';
    await act(async () => {
      outcome = await rejectionOf(deleteAccount.mutateAsync(id));
    });
    return outcome;
  }

  it('leaves the account whole when a mark fails, and requests no push', async () => {
    await seedTwoAccounts();
    const before = allRows();

    const err = await deleteThrough(failingOn('UPDATE accounts SET', 1), 'a1');

    expect(err).toContain('simulated failure on UPDATE accounts SET #1');
    // The hook's three separate statements left a1's transactions and rule
    // deleted here, under a live account.
    expect(rows('transactions')).toEqual(before.transactions);
    expect(rows('recurring_rules')).toEqual(before.rules);
    expect(rows('accounts')).toEqual(before.accounts);
    expect(requestPush).not.toHaveBeenCalled();
  });

  it('marks the account and its children deleted, then requests a push', async () => {
    await seedTwoAccounts();

    expect(await deleteThrough(adapter, 'a1')).toBe('resolved');

    expect(statuses('accounts')).toEqual(['a1:deleted', 'a2:synced']);
    expect(statuses('transactions')).toEqual([
      't1:deleted',
      't2:deleted',
      't3:synced',
      't4:synced',
    ]);
    expect(statuses('recurring_rules')).toEqual(['r1:deleted', 'r2:synced']);
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
  });
});

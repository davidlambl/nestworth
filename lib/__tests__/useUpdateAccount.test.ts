// useUpdateAccount refuses an edit of an account this device has deleted
// (#153). Its UPDATE matched the row whatever its status and set it back to
// 'pending': after an account delete (applyAccountDelete marks the account,
// its transactions and its rules 'deleted'), an Archive, Unarchive, exclude
// toggle, icon or rename on the same row, from an Accounts list that has not
// refetched yet, brought the ACCOUNT back live while its children stayed
// deleted, and the push uploaded the account and tombstoned the children: an
// account delete half-undone. Now the UPDATE skips a 'deleted' row, and the
// mutation rejects with its own words, which the mutation cache renders as
// "Save failed: …", and requests no push.
//
// Own file, importing only the hook, applyAccountDelete and the fixture, so
// it loads on the code before #153 as well: that is where the regressions
// were proven red. The harness is useDeleteRecurringRule.test.ts's:
// react-test-renderer and createElement, a real QueryClient, and getDb
// answering with the fixture's better-sqlite3 adapter.
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
import { useUpdateAccount } from '../hooks/useAccounts';
import {
  insertLocalAccount,
  insertLocalRule,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When the account delete marked its rows. */
const DELETED_AT = '2026-09-28T11:00:00.000Z';

const DELETED_HERE =
  'This account was deleted on this device, so this change was not saved.';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let updateAccount: ReturnType<typeof useUpdateAccount>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useUpdateAccount();
  useEffect(() => {
    updateAccount = mutation;
  });
  return null;
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  // a1 with a transaction and a rule, all synced.
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalTxn(adapter, {
    id: 't1',
    account_id: 'a1',
    updated_at: SYNCED_AT,
  });
  await insertLocalRule(adapter, {
    id: 'r1',
    account_id: 'a1',
    updated_at: SYNCED_AT,
  });

  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  invalidate = jest.spyOn(qc, 'invalidateQueries');
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

/** The account's row as the assertions compare it. */
function account(id: string) {
  return (
    adapter._sqlite
      .prepare(
        'SELECT name, type, icon, exclude_from_total, is_archived, updated_at, _sync_status FROM accounts WHERE id = ?'
      )
      .get(id) ?? null
  );
}

/** `id:status@updated_at` for every row of a table, by id. */
function rows(table: 'transactions' | 'recurring_rules'): string[] {
  return (
    adapter._sqlite
      .prepare(`SELECT id, _sync_status, updated_at FROM ${table} ORDER BY id`)
      .all() as { id: string; _sync_status: string; updated_at: string }[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}`);
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

type UpdateInput = Parameters<typeof updateAccount.mutateAsync>[0];

/** Edits an account through the hook. */
async function updateThrough(input: UpdateInput): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(updateAccount.mutateAsync(input));
  });
  return outcome;
}

// Every input the screens send: app/(tabs)/index.tsx (Archive, Unarchive,
// the exclude toggle, the icon picker, the Edit Account modal) and the
// register's Unarchive (app/account/[id].tsx). One statement serves them all.
const EDITS: [string, Omit<UpdateInput, 'id'>][] = [
  ['Archive', { isArchived: true }],
  ['Unarchive', { isArchived: false }],
  ['the exclude toggle', { excludeFromTotal: true }],
  ['an icon', { icon: '🏦' }],
  ['a rename', { name: 'Renamed', type: 'savings' }],
];

describe('useUpdateAccount over an account this device has deleted (#153)', () => {
  it.each(EDITS)(
    'H1: %s is refused, requests no push, and the account and its children stay deleted',
    async (_label, fields) => {
      await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      const before = account('a1');

      const outcome = await updateThrough({ id: 'a1', ...fields });

      // Before #153: 'resolved', a1 'pending' at a fresh stamp with the edit
      // applied, and a push requested that uploaded it live.
      expect({
        outcome,
        a1: account('a1'),
        txns: rows('transactions'),
        rules: rows('recurring_rules'),
        pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
        // Settled, not only succeeded: the list that still showed the deleted
        // account refetches, so its card goes. The register's key refetches
        // too, but that refetch fails ('Account not found') and a failed
        // refetch keeps the last data, so an open register keeps its banner.
        refetched: invalidate.mock.calls.map(([arg]) => arg),
      }).toEqual({
        outcome: `Error: ${DELETED_HERE}`,
        a1: before,
        txns: [`t1:deleted@${DELETED_AT}`],
        rules: [`r1:deleted@${DELETED_AT}`],
        pushes: 0,
        refetched: [
          { queryKey: ['accounts'] },
          { queryKey: ['account', 'a1'] },
        ],
      });
      expect(before).toMatchObject({ _sync_status: 'deleted' });
    }
  );
});

describe('useUpdateAccount pins', () => {
  it('H2 (pin): an edit of a live account applies, requests one push, and refetches the list and the register', async () => {
    const outcome = await updateThrough({ id: 'a1', isArchived: true });

    expect(outcome).toBe('resolved');
    expect(account('a1')).toMatchObject({
      is_archived: 1,
      _sync_status: 'pending',
    });
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'a1'] });
  });

  it("H3 (pin): an edit of an account this device does not have keeps today's words and requests no push", async () => {
    const outcome = await updateThrough({ id: 'a-gone', isArchived: true });

    expect(outcome).toBe('Error: updateAccount: no local row matched a-gone');
    expect(requestPush).not.toHaveBeenCalled();
  });

  it("H4 (pin): an edit of an account whose _sync_status is NULL still applies, since the filter is IS NOT 'deleted', not != 'deleted'", async () => {
    adapter._sqlite
      .prepare("UPDATE accounts SET _sync_status = NULL WHERE id = 'a1'")
      .run();

    const outcome = await updateThrough({ id: 'a1', name: 'Renamed' });

    expect(outcome).toBe('resolved');
    expect(account('a1')).toMatchObject({
      name: 'Renamed',
      _sync_status: 'pending',
    });
  });
});

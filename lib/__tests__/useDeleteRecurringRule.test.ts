// useDeleteRecurringRule refuses a delete of a rule this device no longer has
// (#138). Its UPDATE used to match nothing and the mutation still resolved,
// having requested a push with nothing in it: the rule had gone through a
// pulled tombstone (already deleted on the server) or the reset's wipe (whose
// re-download brings it back live), and the user was told neither. Now the
// mutation rejects with a readable message, which the mutation cache renders
// as "Save failed: …", and requests no push. The rules list refetches whether
// the delete went through or not, so a refused rule's card does not stay on
// screen: requestPush never refetches it.
//
// Own file, importing only the hook and the fixture, so it loads on the code
// before #138 as well: that is where the regression test was proven red. The
// hook's imports are stubbed as in applyAccountDelete.test.ts, whose harness
// this follows: react-test-renderer and createElement, a real QueryClient, and
// getDb answering with the fixture's better-sqlite3 adapter.
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
import { useDeleteRecurringRule } from '../hooks/useRecurringRules';
import { insertLocalRule, makeAdapter } from '../testing/syncFixture';

/** When the seeded rule last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';

const REFUSAL =
  'This recurring rule no longer exists on this device. It may have been deleted elsewhere or by a reset.';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let deleteRule: ReturnType<typeof useDeleteRecurringRule>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useDeleteRecurringRule();
  useEffect(() => {
    deleteRule = mutation;
  });
  return null;
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  await insertLocalRule(adapter, { id: 'r1', updated_at: SYNCED_AT });

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

/** `id:status@updated_at` for every rule, by id. */
function rules(): string[] {
  return (
    adapter._sqlite
      .prepare(
        'SELECT id, _sync_status, updated_at FROM recurring_rules ORDER BY id'
      )
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

/** Deletes `id` through the hook. */
async function deleteThrough(id: string): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(deleteRule.mutateAsync(id));
  });
  return outcome;
}

describe('useDeleteRecurringRule (#138)', () => {
  it('refuses a delete of a rule this device no longer has, requests no push, and refetches the list', async () => {
    const outcome = await deleteThrough('r-gone');

    // Before #138: 'resolved', with a push requested for nothing.
    expect(outcome).toContain(REFUSAL);
    expect(requestPush).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['recurring_rules'] });
    expect(rules()).toEqual([`r1:synced@${SYNCED_AT}`]);
  });

  it('pin: marks a rule that is still here deleted, requests one push, and refetches the list once', async () => {
    expect(await deleteThrough('r1')).toBe('resolved');

    const [row] = rules();
    expect(row.startsWith('r1:deleted@')).toBe(true);
    expect(row.slice('r1:deleted@'.length) > SYNCED_AT).toBe(true);
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
    // Once: a delete that refetched on success AND on settle would do it twice.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['recurring_rules'] });
  });
});

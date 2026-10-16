// useCreateRecurringRule refuses a rule for an account this device has
// deleted, or no longer has (#163). Its INSERT never looked at the account:
// the New Recurring Rule screen keeps the account it was given in its own
// state, so an account deleted while the screen was open (on another device,
// its tombstone pulled; or offline, a Delete and a Create resumed together)
// still received the rule, 'pending'. The server refuses a NEW rule under a
// tombstoned account with 23503 (005's inherit_account_tombstone), so it
// stayed pending on this device forever, counted by the reset guard. Now the
// INSERT carries the account's status inside the statement and writes nothing
// for a dead account, and the mutation rejects with its own words.
//
// Own file, importing only the hook, applyAccountDelete and the fixture, so
// it loads on the code before #163: that is where the regressions were proven
// red. The harness is useUpdateAccount.test.ts's.
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
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { applyAccountDelete } from '../accountDelete';
import { useCreateRecurringRule } from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalRule,
  makeAdapter,
} from '../testing/syncFixture';

const SYNCED_AT = '2026-05-10T00:00:00Z';
const DELETED_AT = '2026-10-15T11:00:00.000Z';

const DELETED_HERE =
  'Error: This account was deleted on this device, so the rule was not created.';
const GONE =
  'Error: This account no longer exists on this device, so the rule was not created.';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let createRule: ReturnType<typeof useCreateRecurringRule>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useCreateRecurringRule();
  useEffect(() => {
    createRule = mutation;
  });
  return null;
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  // a1 with one rule, synced; a2 live with none.
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(adapter, { id: 'a2', updated_at: SYNCED_AT });
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

/** `id:account:status@updated_at` for every rule, by id. */
function rules(): string[] {
  return (
    adapter._sqlite
      .prepare(
        'SELECT id, account_id, _sync_status, updated_at FROM recurring_rules ORDER BY id'
      )
      .all() as {
      id: string;
      account_id: string;
      _sync_status: string;
      updated_at: string;
    }[]
  ).map((r) => `${r.id}:${r.account_id}:${r._sync_status}@${r.updated_at}`);
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

type RuleInput = Parameters<typeof createRule.mutateAsync>[0];

function input(accountId: string): RuleInput {
  return {
    accountId,
    frequency: 'monthly',
    nextDate: '2026-11-01',
    template: {
      payee: 'Rent',
      amount: -1500,
      checkNumber: null,
      memo: null,
      splits: [],
    },
  };
}

async function createThrough(i: RuleInput): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(createRule.mutateAsync(i));
  });
  return outcome;
}

function invalidated(): unknown[] {
  return invalidate.mock.calls.map((c) => c[0]?.queryKey);
}

describe('useCreateRecurringRule into an account that is not live here (#163)', () => {
  // Before #163: resolved, id-1 'pending' under the deleted a1, one push.
  it('K1: refuses an account this device has deleted, writes nothing and requests no push', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });

    const outcome = await createThrough(input('a1'));

    expect({
      outcome,
      rules: rules(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
    }).toEqual({
      outcome: DELETED_HERE,
      rules: [`r1:a1:deleted@${DELETED_AT}`],
      pushes: 0,
    });
  });

  it('K2: refuses an account no longer on this device, writes nothing and requests no push', async () => {
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();

    const outcome = await createThrough(input('a1'));

    expect({
      outcome,
      rules: rules(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
    }).toEqual({
      outcome: GONE,
      rules: [`r1:a1:synced@${SYNCED_AT}`],
      pushes: 0,
    });
  });

  // The check is inside the INSERT: an account delete that runs to
  // completion right before it is still seen. A separate read before the
  // INSERT passes, and the rule goes in after the delete marked a1's rules.
  it('K3: an account delete that lands just before the INSERT still refuses it', async () => {
    const run = adapter.runAsync;
    let fired = false;
    adapter.runAsync = async (sql: string, params: any[] = []) => {
      if (!fired && /^\s*INSERT INTO recurring_rules/.test(sql)) {
        fired = true;
        await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      }
      return run(sql, params);
    };

    const outcome = await createThrough(input('a1'));
    adapter.runAsync = run;

    expect({ fired, outcome, rules: rules() }).toEqual({
      fired: true,
      outcome: DELETED_HERE,
      rules: [`r1:a1:deleted@${DELETED_AT}`],
    });
  });

  // As useCreateTransaction's C10: the rule create is a plain statement and
  // can land inside applyAccountDelete's transaction. The account is marked
  // first, so before that mark the rules mark takes the new rule, and after
  // it the guard refuses. Marked last, a rule landing after the rules mark
  // found the account live and stayed pending under it.
  it.each([
    ['before', 'UPDATE accounts SET'],
    ['before', 'UPDATE transactions SET'],
    ['before', 'UPDATE recurring_rules SET'],
    ['after', 'UPDATE recurring_rules SET'],
  ] as const)(
    'K7: a rule create landing %s the delete statement %s leaves nothing pending under the account',
    async (when, prefix) => {
      const run = adapter.runAsync;
      let fired = false;
      let outcome = 'not run';
      const createNow = async () => {
        fired = true;
        outcome = await rejectionOf(createRule.mutateAsync(input('a1')));
      };
      adapter.runAsync = async (sql: string, params: any[] = []) => {
        const hit = !fired && sql.startsWith(prefix);
        if (hit && when === 'before') await createNow();
        const res = await run(sql, params);
        if (hit && when === 'after') await createNow();
        return res;
      };
      await act(async () => {
        await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      });
      adapter.runAsync = run;

      expect({
        fired,
        outcome,
        pendingUnderA1: rules().filter((r) => /:a1:pending@/.test(r)),
      }).toEqual({
        fired: true,
        outcome: expect.stringMatching(
          /^(resolved|Error: This account was deleted on this device, so the rule was not created\.)$/
        ),
        pendingUnderA1: [],
      });
    }
  );

  // The screen's account chips come from ['accounts']: a refused create
  // refetches them, so the dead account's chip goes.
  it('K4: a refused create refetches the rules and the accounts list', async () => {
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();

    await createThrough(input('a1'));

    expect(invalidated()).toEqual(
      expect.arrayContaining([['recurring_rules'], ['accounts']])
    );
  });

  it('K5 (pin): a live account takes the rule, pending, with one push for the user', async () => {
    const outcome = await createThrough(input('a2'));
    const row = adapter._sqlite
      .prepare(
        'SELECT account_id, frequency, next_date, template, _sync_status FROM recurring_rules WHERE id = ?'
      )
      .get('id-1') as any;

    expect({
      outcome,
      row: { ...row, template: JSON.parse(row.template) },
      pushes: (requestPush as unknown as jest.Mock).mock.calls,
      refetched: invalidated(),
    }).toEqual({
      outcome: 'resolved',
      row: {
        account_id: 'a2',
        frequency: 'monthly',
        next_date: '2026-11-01',
        template: input('a2').template,
        _sync_status: 'pending',
      },
      pushes: [['u']],
      refetched: expect.arrayContaining([['recurring_rules']]),
    });
  });

  it.each([
    ['NULL', null],
    ['pending', 'pending'],
  ])(
    'K6 (pin): an account whose status is %s takes the rule',
    async (_label, status) => {
      adapter._sqlite
        .prepare('UPDATE accounts SET _sync_status = ? WHERE id = ?')
        .run(status, 'a2');

      const outcome = await createThrough(input('a2'));

      expect({
        outcome,
        rules: rules().filter((r) => r.startsWith('id-1')),
      }).toEqual({
        outcome: 'resolved',
        rules: [expect.stringMatching(/^id-1:a2:pending@/)],
      });
    }
  );
});

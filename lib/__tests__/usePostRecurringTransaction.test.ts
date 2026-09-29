// usePostRecurringTransaction refuses to post from a recurring rule this device
// has deleted, or no longer has (#154). The post read its rule from the
// Recurring list, not from disk, and its advance was
// `UPDATE recurring_rules SET next_date = ?, … , _sync_status = 'pending' WHERE id = ?`
// with no status filter: a Post from a list that had not refetched since a
// Delete of the same rule inserted a transaction from the deleted rule AND set
// the rule back to 'pending', advanced, so the push uploaded both: the delete
// lost, and a transaction the user never meant to post. After an account
// delete, which marks the account's rules 'deleted', the same post landed in
// the deleted account.
//
// Own file, importing only the hook and the fixture, so it loads on the code
// before #154 as well: that is where the regressions were proven red. The
// harness is useDeleteRecurringRule.test.ts's: react-test-renderer and
// createElement, a real QueryClient, and getDb answering with the fixture's
// better-sqlite3 adapter.
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
import { applyRecurringRuleDelete } from '../recurringRuleDelete';
import { deleteLocalRuleIfSynced } from '../tombstones';
import { mapRecurringRule } from '../mappers';
import { usePostRecurringTransaction } from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalRule,
  makeAdapter,
} from '../testing/syncFixture';
import type { DbRecurringRule, RecurringRule } from '../types';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When the delete marked its rows. */
const DELETED_AT = '2026-09-28T11:00:00.000Z';

const TEMPLATE = {
  payee: 'Rent',
  amount: -1200,
  checkNumber: null,
  memo: null,
  splits: [
    { amount: -1000, memo: 'rent' },
    { amount: -200, memo: 'fees' },
  ],
};

/** The rule's own words for a rule this device deleted (proposed copy). */
const DELETED_HERE = /was deleted on this device/;
/** #147's words for a rule this device no longer has. */
const GONE =
  'This recurring rule no longer exists on this device. It may have been deleted elsewhere or by a reset.';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let post: ReturnType<typeof usePostRecurringTransaction>;
let invalidate: jest.SpyInstance;
let quiet: jest.SpyInstance[];

function Harness() {
  const mutation = usePostRecurringTransaction();
  useEffect(() => {
    post = mutation;
  });
  return null;
}

/** Seeds r1, due on 2026-09-01 in a1, and returns it as the list holds it. */
async function seedRule(extra: Record<string, unknown> = {}) {
  await insertLocalRule(adapter, {
    id: 'r1',
    account_id: 'a1',
    frequency: 'monthly',
    next_date: '2026-09-01',
    template: TEMPLATE,
    updated_at: SYNCED_AT,
    ...extra,
  });
  return listRule('r1');
}

/** The rule as the Recurring list's query mapped it, before anything below. */
function listRule(id: string): RecurringRule {
  return mapRecurringRule(
    adapter._sqlite
      .prepare('SELECT * FROM recurring_rules WHERE id = ?')
      .get(id) as DbRecurringRule
  );
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });

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
  quiet.forEach((spy) => spy.mockRestore());
  adapter._sqlite.close();
});

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  return 'resolved';
}

/** Posts `rule` through the hook. */
async function postThrough(rule: RecurringRule): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(post.mutateAsync(rule));
  });
  return outcome;
}

/** `id:status@updated_at next=…` for the rule, or null. */
function ruleRow(id: string) {
  const r = adapter._sqlite
    .prepare(
      'SELECT id, next_date, _sync_status, updated_at FROM recurring_rules WHERE id = ?'
    )
    .get(id) as
    | {
        id: string;
        next_date: string;
        _sync_status: string;
        updated_at: string;
      }
    | undefined;
  return r
    ? `${r.id}:${r._sync_status}@${r.updated_at} next=${r.next_date}`
    : null;
}

/** Every transaction and split, as `id:account:status`. */
function written() {
  return {
    txns: (
      adapter._sqlite
        .prepare(
          'SELECT id, account_id, txn_date, _sync_status FROM transactions ORDER BY id'
        )
        .all() as any[]
    ).map((t) => `${t.id}:${t.account_id}:${t.txn_date}:${t._sync_status}`),
    splits: (
      adapter._sqlite
        .prepare('SELECT id FROM transaction_splits ORDER BY id')
        .all() as any[]
    ).map((s) => s.id),
  };
}

/**
 * Every statement `during` ran that changed a row, as `UPDATE recurring_rules
 * ×1`. It counts what SQLite changed, so a statement that re-stamps a row with
 * the same values still counts, and it never compares timestamps, which two
 * posts in one millisecond would share.
 */
async function writesDuring(during: () => Promise<void>): Promise<string[]> {
  const real = adapter.runAsync;
  const writes: string[] = [];
  adapter.runAsync = async (sql: string, params: any[] = []) => {
    const out = await real(sql, params);
    if (out.changes > 0) {
      // UPDATE <table> …, INSERT INTO <table> …, DELETE FROM <table> …
      const words = sql.trim().split(/\s+/);
      const table = words[0] === 'UPDATE' ? words[1] : words[2];
      writes.push(`${words[0]} ${table} ×${out.changes}`);
    }
    return out;
  };
  try {
    await during();
  } finally {
    adapter.runAsync = real;
  }
  return writes;
}

describe('usePostRecurringTransaction over a rule this device has deleted (#154)', () => {
  // Before #154: 'resolved'; r1 'pending' again with next_date 2026-10-01,
  // and t id-1 posted into a1 with its two splits, one push requested.
  it('P1: is refused, writes nothing, and requests no push', async () => {
    const rule = await seedRule();
    await applyRecurringRuleDelete(adapter, 'r1', { now: DELETED_AT });

    const outcome = await postThrough(rule);

    expect({
      outcome,
      r1: ruleRow('r1'),
      ...written(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
      // Settled, not only succeeded: the list that still showed the deleted
      // rule refetches, so its card goes.
      refetched: invalidate.mock.calls.map(([arg]) => arg),
    }).toEqual({
      outcome: expect.stringMatching(DELETED_HERE),
      r1: `r1:deleted@${DELETED_AT} next=2026-09-01`,
      txns: [],
      splits: [],
      pushes: 0,
      refetched: [
        { queryKey: ['recurring_rules'] },
        { queryKey: ['accounts'] },
      ],
    });
  });

  // Before #154: 'resolved'; the expiry delete re-marked r1 (already deleted)
  // and t id-1 was posted from it.
  it('P2: the last occurrence of a rule with an end date is refused the same way', async () => {
    const rule = await seedRule({ end_date: '2026-09-15' });
    await applyRecurringRuleDelete(adapter, 'r1', { now: DELETED_AT });

    const outcome = await postThrough(rule);

    expect({ outcome, r1: ruleRow('r1'), ...written() }).toEqual({
      outcome: expect.stringMatching(DELETED_HERE),
      r1: `r1:deleted@${DELETED_AT} next=2026-09-01`,
      txns: [],
      splits: [],
    });
  });

  // The account delete commits after the post has checked the account and
  // before its transaction starts. Before #154: 'resolved'; t id-1 posted into
  // the deleted a1, and r1, which the account delete had marked, back to
  // 'pending' and advanced.
  it('P3: an account delete landing between the account check and the transaction makes the post refuse', async () => {
    const rule = await seedRule();
    const real = adapter.getFirstAsync.bind(adapter);
    let fired = false;
    (adapter as any).getFirstAsync = async (
      sql: string,
      params: any[] = []
    ) => {
      const out = await real(sql, params);
      if (!fired && /FROM accounts/.test(sql)) {
        fired = true;
        await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      }
      return out;
    };

    const outcome = await postThrough(rule);

    expect({ fired, outcome, r1: ruleRow('r1'), ...written() }).toEqual({
      fired: true,
      outcome: expect.stringMatching(DELETED_HERE),
      r1: `r1:deleted@${DELETED_AT} next=2026-09-01`,
      txns: [],
      splits: [],
    });
  });

  // Before #154: 'resolved'; the post inserted t id-1 and its splits, and the
  // advance matched nothing, silently.
  it("P4: a post of a rule this device no longer has is refused with #147's words and writes nothing", async () => {
    const rule = await seedRule();
    adapter._sqlite
      .prepare("DELETE FROM recurring_rules WHERE id = 'r1'")
      .run();

    const outcome = await postThrough(rule);

    expect({ outcome, ...written() }).toEqual({
      outcome: `Error: ${GONE}`,
      txns: [],
      splits: [],
    });
  });
});

describe('usePostRecurringTransaction pins', () => {
  it('P5 (pin): a post of a live rule inserts the transaction and its splits, advances the rule, and requests one push', async () => {
    const rule = await seedRule();

    const outcome = await postThrough(rule);

    expect(outcome).toBe('resolved');
    expect(ruleRow('r1')).toMatch(/^r1:pending@.* next=2026-10-01$/);
    expect(written()).toEqual({
      txns: ['id-1:a1:2026-09-01:pending'],
      splits: ['id-2', 'id-3'],
    });
    expect(requestPush).toHaveBeenCalledTimes(1);
  });

  it('P6 (pin): the last occurrence posts and marks the rule deleted', async () => {
    const rule = await seedRule({ end_date: '2026-09-15' });

    const outcome = await postThrough(rule);

    expect(outcome).toBe('resolved');
    expect(ruleRow('r1')).toMatch(/^r1:deleted@/);
    expect(written().txns).toEqual(['id-1:a1:2026-09-01:pending']);
  });

  it('P7 (pin): a second post of the same occurrence, after the first committed, only advances, and requests a push for the advance', async () => {
    const rule = await seedRule();

    expect(await postThrough(rule)).toBe('resolved');
    expect(await postThrough(rule)).toBe('resolved');

    expect(written().txns).toEqual(['id-1:a1:2026-09-01:pending']);
    expect(ruleRow('r1')).toMatch(/ next=2026-10-01$/);
    // The advance is a write the push must carry, so both posts request one.
    expect(requestPush).toHaveBeenCalledTimes(2);
  });

  // Before #154: the post resolved. What this pins is the shape of the
  // refusal: a plain write that joined the refused post's transaction, here a
  // pull consuming the tombstone of another rule, stays committed. Thrown
  // inside the task instead, the refusal reads the same, but its ROLLBACK
  // brings r2 back, deleted elsewhere yet shown here, past the pull's cursor.
  it.each([
    ['deleted here', DELETED_HERE],
    ['no longer here', new RegExp(GONE.slice(0, 40))],
  ] as const)(
    "P8 (pin of the idiom, rule %s): a tombstone DELETE landing inside the refused post's transaction stays committed",
    async (state, words) => {
      const rule = await seedRule();
      await insertLocalRule(adapter, {
        id: 'r2',
        account_id: 'a1',
        updated_at: SYNCED_AT,
      });
      if (state === 'deleted here') {
        await applyRecurringRuleDelete(adapter, 'r1', { now: DELETED_AT });
      } else {
        adapter._sqlite
          .prepare("DELETE FROM recurring_rules WHERE id = 'r1'")
          .run();
      }
      const real = adapter.runAsync.bind(adapter);
      let joined: boolean | null = null;
      let consumed: boolean | null = null;
      (adapter as any).runAsync = async (sql: string, params: any[] = []) => {
        if (
          joined === null &&
          /^\s*(UPDATE recurring_rules|INSERT INTO transactions)/.test(sql)
        ) {
          joined = adapter._sqlite.inTransaction;
          consumed = await deleteLocalRuleIfSynced(adapter, 'r2');
        }
        return real(sql, params);
      };

      const outcome = await postThrough(rule);

      expect({
        joined,
        consumed,
        outcome,
        r2: ruleRow('r2'),
        open: adapter._sqlite.inTransaction,
      }).toEqual({
        joined: true,
        consumed: true,
        outcome: expect.stringMatching(words),
        r2: null,
        open: false,
      });
    }
  );

  // Before #154: the post resolved. What this pins is where the status is
  // read: inside the task. The push hard-deletes a 'deleted' rule once it has
  // uploaded the tombstone (run here by hand right after the COMMIT); read
  // after the transaction, the refusal would find no row and say the rule no
  // longer exists.
  it('P9 (pin of where the status is read): the push dropping the rule right after the refused post commits leaves the refusal its own words', async () => {
    const rule = await seedRule();
    await applyRecurringRuleDelete(adapter, 'r1', { now: DELETED_AT });
    const realTx = adapter.withTransactionAsync.bind(adapter);
    adapter.withTransactionAsync = async (task: () => Promise<void>) => {
      await realTx(task);
      adapter._sqlite
        .prepare(
          "DELETE FROM recurring_rules WHERE id = 'r1' AND _sync_status = 'deleted'"
        )
        .run();
    };

    const outcome = await postThrough(rule);

    expect({ outcome, r1: ruleRow('r1') }).toEqual({
      outcome: expect.stringMatching(DELETED_HERE),
      r1: null,
    });
  });

  it("P10 (pin): a post of a rule whose _sync_status is NULL still posts, since the filter is IS NOT 'deleted', not != 'deleted'", async () => {
    const rule = await seedRule();
    adapter._sqlite
      .prepare("UPDATE recurring_rules SET _sync_status = NULL WHERE id = 'r1'")
      .run();

    const outcome = await postThrough(rule);

    expect(outcome).toBe('resolved');
    expect(ruleRow('r1')).toMatch(/^r1:pending@.* next=2026-10-01$/);
    expect(written().txns).toEqual(['id-1:a1:2026-09-01:pending']);
  });
});

describe('usePostRecurringTransaction: the account check (pins)', () => {
  // Green before #154 too. What this pins is the check #154 leaves in front
  // of the transaction: a post into an archived account is refused before
  // anything is written (CONTRIBUTING's Archived accounts bullet).
  it('P12 (pin): a post into an archived account is refused and writes nothing', async () => {
    const rule = await seedRule();
    adapter._sqlite
      .prepare("UPDATE accounts SET is_archived = 1 WHERE id = 'a1'")
      .run();

    const outcome = await postThrough(rule);

    expect({ outcome, r1: ruleRow('r1'), ...written() }).toEqual({
      outcome: 'Error: Cannot post into an archived account',
      r1: `r1:synced@${SYNCED_AT} next=2026-09-01`,
      txns: [],
      splits: [],
    });
  });
});

// Found while designing #154, and folded in by the plan's decision (the owner
// may veto it at review): the duplicate guard read the transactions table before the post's transaction,
// so two posts of the same occurrence started together (a double tap before
// the list refetched, or two offline taps resumed together on reconnect) both
// found nothing and both inserted. Two guards now hold here, each enough
// alone: the read inside the transaction, and the mutation scope the post
// shares with the rule delete, which runs two posts one at a time. Only
// dropping both makes P11 and P13 fail again.
describe('two posts of the same occurrence', () => {
  // Before: two transactions dated 2026-09-01, the rule advanced once.
  it('P11: started together, it is posted once, and the second only advances', async () => {
    const rule = await seedRule();

    let outcomes: string[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        rejectionOf(post.mutateAsync(rule)),
        rejectionOf(post.mutateAsync(rule)),
      ]);
    });

    expect({
      outcomes,
      txns: written().txns,
      r1: ruleRow('r1')?.replace(/@\S+/, ''),
    }).toEqual({
      outcomes: ['resolved', 'resolved'],
      txns: ['id-1:a1:2026-09-01:pending'],
      r1: 'r1:pending next=2026-10-01',
    });
  });

  // The last occurrence: the first post's expiry marks the rule deleted, so
  // the second post's guarded advance matches nothing. Before: both inserted
  // (two transactions dated 2026-09-01). Refused, the second would tell the
  // user they deleted a rule they did not; it finds the first one's row
  // instead and resolves as a post of an occurrence already posted.
  it('P13: the last occurrence, started together: posted once, and both resolve', async () => {
    const rule = await seedRule({ end_date: '2026-09-15' });

    let outcomes: string[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        rejectionOf(post.mutateAsync(rule)),
        rejectionOf(post.mutateAsync(rule)),
      ]);
    });

    expect({
      outcomes,
      txns: written().txns,
      r1: ruleRow('r1')?.replace(/@.*/, ''),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
    }).toEqual({
      outcomes: ['resolved', 'resolved'],
      txns: ['id-1:a1:2026-09-01:pending'],
      r1: 'r1:deleted',
      // The second post found the first one's row and requests no push. That
      // it writes nothing is measured by P14, one post at a time.
      pushes: 1,
    });
  });

  // A post whose occurrence is already here resolves without writing or
  // pushing, whatever became of the rule: here a pulled tombstone removed it.
  // Before #154 it resolved and wrote nothing too (it found the occurrence's
  // row, and its advance matched no row), but it requested a push.
  it('P15: a post of a rule no longer here, whose occurrence is already posted, resolves, writes nothing and requests no push', async () => {
    const rule = await seedRule();
    expect(await postThrough(rule)).toBe('resolved');
    adapter._sqlite
      .prepare("DELETE FROM recurring_rules WHERE id = 'r1'")
      .run();
    (requestPush as unknown as jest.Mock).mockClear();

    let outcome = '';
    const writes = await writesDuring(async () => {
      outcome = await postThrough(rule);
    });

    expect({
      outcome,
      writes,
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
      ...written(),
      r1: ruleRow('r1'),
    }).toEqual({
      outcome: 'resolved',
      writes: [],
      pushes: 0,
      txns: ['id-1:a1:2026-09-01:pending'],
      splits: ['id-2', 'id-3'],
      r1: null,
    });
  });

  // A second tap on the last occurrence, whose rule the first post's expiry
  // has deleted here, resolves and writes nothing: its guarded advance matches
  // no row. Before #154 it resolved too, but it re-marked the deleted rule
  // (writes ['UPDATE recurring_rules ×1'], a new updated_at) and requested a
  // push.
  it('P14: the last occurrence posted a second time, after the first committed, resolves and writes nothing', async () => {
    const rule = await seedRule({ end_date: '2026-09-15' });

    const first = await postThrough(rule);
    const afterFirst = ruleRow('r1');
    (requestPush as unknown as jest.Mock).mockClear();
    let second = '';
    const writes = await writesDuring(async () => {
      second = await postThrough(rule);
    });

    expect({
      first,
      second,
      writes,
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
      txns: written().txns,
      r1: ruleRow('r1'),
    }).toEqual({
      first: 'resolved',
      second: 'resolved',
      writes: [],
      pushes: 0,
      txns: ['id-1:a1:2026-09-01:pending'],
      r1: afterFirst,
    });
    expect(afterFirst).toMatch(/^r1:deleted@/);
  });
});

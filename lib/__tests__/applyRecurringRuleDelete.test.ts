// applyRecurringRuleDelete (#138): a delete of a recurring rule this device no
// longer has fails readably instead of reporting success. The rule can be gone
// through a pulled tombstone or the reset's wipe; useDeleteRecurringRule's
// UPDATE matched nothing then and the mutation resolved. The hook itself is
// driven in useDeleteRecurringRule.test.ts, and a delete landing in the wipe in
// syncWipeSurvivors.test.ts's last test.
//
// This module is new with #138, so this suite cannot load on the code before
// it. The regression test was proven red with the `changes` check removed,
// which leaves exactly the statement the hook ran before.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyRecurringRuleDelete } from '../recurringRuleDelete';
import { insertLocalRule, makeAdapter } from '../testing/syncFixture';

/** When every seeded rule last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** The delete's timestamp. */
const NOW = '2026-09-26T12:00:00.000Z';
/** A second delete's, before the first one's push. */
const LATER = '2026-09-26T12:05:00.000Z';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(async () => {
  adapter = makeAdapter();
  await insertLocalRule(adapter, { id: 'r1', updated_at: SYNCED_AT });
  await insertLocalRule(adapter, { id: 'r2', updated_at: SYNCED_AT });
});

afterEach(() => {
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

describe('applyRecurringRuleDelete (#138)', () => {
  it('rejects a delete of a rule this device no longer has, and writes nothing', async () => {
    const outcome = await rejectionOf(
      applyRecurringRuleDelete(adapter, 'r-gone', { now: NOW })
    );

    // With the `changes` check removed (the hook's statement before #138):
    // 'resolved'.
    expect(outcome).toBe(
      'Error: This recurring rule no longer exists on this device. It may have been deleted elsewhere or by a reset.'
    );
    expect(rules()).toEqual([
      `r1:synced@${SYNCED_AT}`,
      `r2:synced@${SYNCED_AT}`,
    ]);
  });

  it('pin: marks the rule deleted with the stamp, and a second delete before its push still succeeds', async () => {
    await applyRecurringRuleDelete(adapter, 'r1', { now: NOW });
    expect(rules()).toEqual([`r1:deleted@${NOW}`, `r2:synced@${SYNCED_AT}`]);

    // No status filter: the rule is still here, so the second tap is not
    // refused (a filter on 'deleted' would match nothing and throw).
    expect(
      await rejectionOf(applyRecurringRuleDelete(adapter, 'r1', { now: LATER }))
    ).toBe('resolved');
    expect(rules()).toEqual([`r1:deleted@${LATER}`, `r2:synced@${SYNCED_AT}`]);
  });
});

// #129: a pending row the push cannot prepare is skipped, not thrown.
//
// pushTable turns each pending row into its upload with the table's own
// transform, and the recurring-rules transform parses the template the row
// stores as text (`JSON.parse`). Unguarded, a template that is not JSON threw
// out of the whole push at that row: the rows after it, the transactions, the
// tombstones and the missing-column report were all skipped, and fullSync,
// which pulls only once its push has returned, reported the raw SyntaxError
// and never pulled. Every later push did the same, since the row stays
// pending. Now the row is skipped with a warning and left pending, and the
// push and the pull go on. The reset still refuses over it, in its own words.
//
// Reachable in practice about never: the only writer stringifies an object
// (useRecurringRules), nothing edits a template in place, and the Recurring
// screen's mapRecurringRule throws on such a row first (its read side is out
// of scope here). The guard is defensive.
//
// Own file: `lastError` and the sync lock are module state, so each test
// starts from a cleared error and afterEach asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { fullSync, resetLocalData } from '../sync';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalRule,
  makeAdapter,
  wireSyncMocks,
  type Store,
} from '../testing/syncFixture';

let adapter: ReturnType<typeof makeAdapter>;
let store: Store;
let meta: Map<string, string>;
let warn: jest.SpyInstance;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ({ adapter, store, meta } = wireSyncMocks());
  setLastError(null);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  quiet = (['log', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  warn.mockRestore();
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  adapter._sqlite.close();
});

const localStatus = async (id: string): Promise<string | null> =>
  (
    (await adapter.getFirstAsync(
      'SELECT _sync_status FROM recurring_rules WHERE id = ?',
      [id]
    )) as { _sync_status: string } | null
  )?._sync_status ?? null;

const serverRuleIds = (): string[] =>
  (store.recurring_rules ?? []).map((r: any) => r.id);

/**
 * Two pending rules, the malformed one FIRST: the push reads pending rows in
 * rowid order, and inserted second, the good rule would reach the server
 * before the throw, so its upload would prove nothing.
 */
async function seedRules() {
  await insertLocalRule(adapter, {
    id: 'R1',
    template: '{oops',
    updated_at: '2026-06-01T00:00:00Z',
    _sync_status: 'pending',
  });
  await insertLocalRule(adapter, {
    id: 'R2',
    template: { payee: 'Rent', amount: -1200 },
    updated_at: '2026-06-01T00:00:00Z',
    _sync_status: 'pending',
  });
}

/** The warnings the skip logged; other paths may warn too. */
const skipWarnings = () =>
  warn.mock.calls.filter((args) =>
    /could not be prepared/.test(String(args[0]))
  );

describe('pushTable skips a row its transform cannot prepare (#129)', () => {
  it('uploads the rest, leaves that row pending, and fullSync still pulls', async () => {
    await seedRules();

    await fullSync('u');

    expect({
      server: serverRuleIds(),
      R1: await localStatus('R1'),
      R2: await localStatus('R2'),
      // Stamped only by a pull that ran to the end, after the push.
      pulled: meta.has('last_pull_at:u'),
      // Nothing the user can act on today, so no line in Settings.
      lastError: getSyncSnapshot().lastError,
    }).toEqual({
      server: ['R2'],
      R1: 'pending',
      R2: 'synced',
      pulled: true,
      lastError: null,
    });

    const skipped = skipWarnings();
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0][0])).toContain('recurring_rules R1');
    expect(String(skipped[0][1])).toMatch(/SyntaxError/);
  });

  it('lets a reset refuse over that row with its own count, once the rest is up', async () => {
    await seedRules();

    let err: unknown = null;
    await resetLocalData('u').catch((e) => {
      err = e;
    });

    expect({
      refusal: String(err),
      server: serverRuleIds(),
      R1: await localStatus('R1'),
      R2: await localStatus('R2'),
    }).toEqual({
      refusal: expect.stringContaining("Couldn't upload 1 unsynced change(s)"),
      server: ['R2'],
      R1: 'pending',
      R2: 'synced',
    });
    expect(skipWarnings()).toHaveLength(1);
  });
});

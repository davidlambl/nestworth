// Every request error that reaches a USER goes through describeRequestError, so
// a timed-out request reads as "the request timed out" instead of the raw
// "AbortError: Aborted" that postgrest-js hands back (#67 review finding 1).
//
// The first pass wired the mapper into the reset probe and pullTableFull — the
// two reads LEAST likely to time out. These three tests cover the ones most
// likely to: the reset's own post-wipe download (transactions, then splits) and
// the bootstrap's paged transactions read, whose message becomes the
// "Sync issue: …" line in Settings.
//
// Own file: `_syncInProgress` in lib/sync.ts and `lastError` in lib/syncStatus.ts
// are module state shared by every test in a file, so a suite that leaves either
// set makes the tests after it pass vacuously.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { initialPull, resetLocalData } from '../sync';
import { supabase } from '../supabase';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import {
  insertLocalAccount,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

/**
 * What postgrest-js actually returns for a request aborted by `db.timeout`,
 * verified against the live project: the message carries the underlying error's
 * NAME, there is no `name` on the object itself, and `code` is deliberately
 * cleared — so the mapper's `message` branch is the one that has to catch it.
 */
const ABORT_ERROR = {
  message: 'AbortError: Aborted',
  hint: 'Request was aborted (timeout or manual cancellation)',
  code: '',
};

/**
 * Fails every request for one table with ABORT_ERROR, leaving the other tables
 * on the real fake. Self-returning so it satisfies any builder chain the engine
 * uses (`.select().eq().order().range()`, `.select().in()`, `.select().eq().is()`),
 * and thenable so awaiting any point in the chain resolves to the failure.
 */
function poisonTable(fake: { from: (t: string) => any }, table: string) {
  const realFrom = fake.from;
  (supabase as any).from = (t: string) => {
    if (t !== table) {
      return realFrom(t);
    }
    const failed = { data: null, error: ABORT_ERROR };
    const builder: any = {
      then: (res: any, rej: any) => Promise.resolve(failed).then(res, rej),
    };
    for (const method of [
      'select',
      'eq',
      'neq',
      'in',
      'is',
      'gt',
      'order',
      'range',
      'limit',
      'single',
      'upsert',
      'update',
      'delete',
    ]) {
      builder[method] = () => builder;
    }
    return builder;
  };
}

let ctx: ReturnType<typeof wireSyncMocks>;

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
});

afterEach(() => {
  ctx.adapter._sqlite.close();
});

describe('a timed-out request is described as a timeout, not as an AbortError', () => {
  it('reports the reset download timing out on transactions', async () => {
    // Synced, so the pre-wipe pending check passes and the reset gets as far as
    // the download — which is the point: this message is shown after the local
    // copy has already been wiped.
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    poisonTable(ctx.installSupabase({}), 'transactions');

    let err: unknown;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    // String(err) rather than rejects.toThrow(): better-sqlite3 binds its error
    // class per realm, and these suites share a worker.
    expect(String(err)).toContain('Failed to download transactions');
    expect(String(err)).toContain('the request timed out');
    expect(String(err)).not.toContain('AbortError');
  });

  it('reports the reset download timing out on splits', async () => {
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    // One remote transaction, so the pull reaches the split read at all.
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    poisonTable(ctx.installSupabase({}), 'transaction_splits');

    let err: unknown;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    expect(String(err)).toContain('Failed to download splits');
    expect(String(err)).toContain('the request timed out');
    expect(String(err)).not.toContain('AbortError');
  });

  it('reports a timed-out bootstrap page through the sync status', async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    poisonTable(ctx.installSupabase({}), 'transactions');

    // initialPull catches its own throw and reports it through setLastError,
    // which Settings renders as "Sync issue: …".
    await initialPull('u');

    const { lastError } = getSyncSnapshot();
    expect(lastError).toContain('initialPull transactions page');
    expect(lastError).toContain('the request timed out');
    expect(lastError).not.toContain('AbortError');
  });
});

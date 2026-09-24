// #95: a client with no session signs every request with the anon key.
// supabase-js asks auth.getSession() for a token, discards the error, and falls
// back to the key it was created with, so nothing throws: RLS answers every
// read `200 []`, refuses every upsert with 42501, and lets every UPDATE and
// DELETE match nothing. Each of those answers looked like an honest one to the
// engine. A pull banked its transaction cursor over a window it never read, and
// stamped a new user's empty pull complete; a bootstrap stamped all three keys
// over nothing; a reset passed its reachability probe, wiped the device and
// downloaded nothing; and a push took each tombstone UPDATE's zero matched rows
// for "the server agrees it is gone" and hard-deleted the local row, undoing
// every queued delete.
//
// The fix asks auth.getSession() the question supabase-js asks, before a push,
// a pull and a bootstrap, on both sides of a reset's probe, and again on every
// empty page of every read, because the session can go between two pages. The
// fixture's `anonScoped` is the client with no session; it goes through
// installSupabase, which installs `auth` as well as `from`.
//
// Own file: `lastError` in lib/syncStatus.ts and `_syncInProgress` in
// lib/sync.ts are module state shared by every test in a file, so each test
// starts from a cleared error, awaits everything it starts, and afterEach
// asserts the lock is free.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  fullSync,
  initialPull,
  needsInitialPull,
  pullChanges,
  pushChanges,
  resetLocalData,
  startSyncSession,
} from '../sync';
import { supabase } from '../supabase';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import { statusLabel } from '../syncStatusHelpers';
import {
  FAKE_SESSION,
  insertLocalAccount,
  insertLocalTxn,
  remoteAccount,
  remoteRule,
  remoteTxn,
  type SupabaseOpts,
  wireSqliteSyncMeta,
  wireSyncMocks,
} from '../testing/syncFixture';

/** The last complete pull. Older than any stamp a test can make. */
const T0 = '2026-06-15T00:00:00Z';

/**
 * The refusal, for the fixture's ANON_REFRESH_ERROR: the refresh timed out, so
 * auth-js kept the stored session but had no valid token to hand out.
 */
const NO_SESSION = "Couldn't renew your sign-in: the request timed out";

/** The reset's refusal: the same words, and what it did not do. */
const RESET_REFUSED = `${NO_SESSION} — reset cancelled, your local data is unchanged.`;

/** A read whose session went away after its first page was answered. */
const lostMidRead = (table: string) =>
  `Couldn't download ${table}: your sign-in could not be renewed (the request timed out)`;

let ctx: ReturnType<typeof wireSyncMocks>;
let quiet: jest.SpyInstance[];

beforeEach(() => {
  ctx = wireSyncMocks();
  setLastError(null);
  // Every refusal here warns by design.
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  quiet.forEach((spy) => spy.mockRestore());
  expect(getSyncSnapshot().isSyncing).toBe(false);
  ctx.adapter._sqlite.close();
});

const lastError = () => getSyncSnapshot().lastError;

const localIds = (table: string) =>
  ctx.adapter._sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((r: any) => r.id);

const localStatus = (table: string, id: string) =>
  (
    ctx.adapter._sqlite
      .prepare(`SELECT _sync_status FROM ${table} WHERE id = ?`)
      .get(id) as { _sync_status: string } | undefined
  )?._sync_status ?? null;

/** Every local table at once, so a test can see what a pull did and did not land. */
const landed = () => ({
  accounts: localIds('accounts'),
  rules: localIds('recurring_rules'),
  transactions: localIds('transactions'),
  splits: localIds('transaction_splits'),
});

/** Every key in wireSyncMocks' in-memory sync_meta, sorted. */
const metaKeys = () => [...ctx.meta.keys()].sort();

/** The four per-user keys a reset's wipe clears. */
const PULL_KEYS = [
  'last_pull_at',
  'last_pull_attempt_at',
  'last_txn_pull_at',
  'last_txn_reconcile_at',
];

/**
 * Backs sync_meta with the adapter's own table, so a wipe that ran would show
 * (see wireSqliteSyncMeta), and sets all four of the user's keys to T0.
 * Returns a reader for the four, in PULL_KEYS order.
 */
function seedPullKeysInSqlite(): () => (string | undefined)[] {
  const meta = wireSqliteSyncMeta(ctx.adapter);
  for (const key of PULL_KEYS) {
    meta.set(`${key}:u`, T0);
  }
  return () => PULL_KEYS.map((key) => meta.get(`${key}:u`));
}

/**
 * Takes the session away just before the `pageIndex`-th page request on
 * `table` (counted from 0 across every read of it), by flipping `anonScoped`
 * on the options object the fake was installed with, which it reads on every
 * request. Pages before it are answered as the user, that page and everything
 * after it as nobody. The wrapping pattern of syncTombstoneRaces.test.ts's
 * failed refresh read, on `.range()`.
 */
function flipAnonBeforePage(
  remote: SupabaseOpts,
  table: string,
  pageIndex: number
) {
  const realFrom = (supabase as any).from;
  let pages = 0;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t !== table) {
      return builder;
    }
    const realRange = builder.range;
    builder.range = (from: number, to: number) => {
      if (pages++ === pageIndex) {
        remote.anonScoped = true;
      }
      return realRange(from, to);
    };
    return builder;
  };
}

/**
 * Takes the session away at the reset's reachability probe, the one read that
 * calls `.limit()`: after the reset's first session check and its push, and
 * before the probe is answered.
 */
function flipAnonAtProbe(remote: SupabaseOpts) {
  const realFrom = (supabase as any).from;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t !== 'accounts') {
      return builder;
    }
    const realLimit = builder.limit;
    builder.limit = (n: number) => {
      remote.anonScoped = true;
      return realLimit(n);
    };
    return builder;
  };
}

describe('a pull with no session is refused before it reads anything', () => {
  it('pullChanges with no session holds the cursor, stamps neither key and names the sign-in', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.installSupabase({ anonScoped: true });

    const complete = await pullChanges('u');

    // Every read would have answered `[]`: step 1 would bank the cursor over a
    // window it never read, and the attempt key would claim a pull happened.
    // Nothing was read, so nothing is stamped, and the line names the sign-in.
    expect({
      complete,
      transactions: localIds('transactions'),
      cursor: ctx.meta.get('last_txn_pull_at:u'),
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      attempt: ctx.meta.get('last_pull_attempt_at:u'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      transactions: ['t1'],
      cursor: T0,
      lastPullAt: T0,
      attempt: undefined,
      lastError: NO_SESSION,
    });
  });

  it('refuses a new user instead of stamping a complete pull', async () => {
    // Nothing local, so no #19 guard can fire: every `[]` would be taken at its
    // word and "Last synced" stamped over a download of nothing.
    ctx.installSupabase({ anonScoped: true });

    const complete = await pullChanges('u');

    expect({
      complete,
      keys: metaKeys(),
      needsInitialPull: await needsInitialPull('u'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      keys: [],
      needsInitialPull: true,
      lastError: NO_SESSION,
    });
  });

  it('rejects under throwOnError, and stamps and reports nothing itself', async () => {
    ctx.installSupabase({ anonScoped: true });

    let err: unknown = null;
    try {
      await pullChanges('u', { throwOnError: true });
    } catch (e) {
      err = e;
    }

    // String(err), not rejects.toThrow(): these suites are realm-sensitive.
    // The caller (a reset) reports the rejection; the pull itself does not.
    expect(String(err)).toBe(`Error: ${NO_SESSION}`);
    expect({ keys: metaKeys(), lastError: lastError() }).toEqual({
      keys: [],
      lastError: null,
    });
  });
});

describe('a bootstrap with no session', () => {
  it('initialPull with no session stamps nothing, and the next launch with a session bootstraps for real', async () => {
    // The data is on the server all along; the client just cannot see it.
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.recurring_rules = [remoteRule({ id: 'r1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: -5, memo: null },
    ];
    ctx.installSupabase({ anonScoped: true });

    await initialPull('u');

    // Stamping here declares the device fully pulled over nothing, and banks
    // both transaction keys past every row the server holds.
    expect({
      landed: landed(),
      keys: metaKeys(),
      needsInitialPull: await needsInitialPull('u'),
      lastError: lastError(),
    }).toEqual({
      landed: { accounts: [], rules: [], transactions: [], splits: [] },
      keys: [],
      needsInitialPull: true,
      lastError: NO_SESSION,
    });

    // The next launch, signed in again. What the bootstrap stamped is read as
    // it finishes, before the full sync after it: a no-cursor fullSync alone
    // would land the same rows and stamp every key too.
    ctx.installSupabase({});
    let bootstrapped: Record<string, string> = {};
    await startSyncSession('u', {
      onBootstrapped: () => {
        bootstrapped = Object.fromEntries(ctx.meta);
      },
    });

    // The bootstrap ran: its three keys, all from the one snapshot it takes
    // before its first read.
    const snapshot = bootstrapped['last_txn_reconcile_at:u'];
    expect(snapshot).toEqual(expect.any(String));
    expect(bootstrapped).toEqual({
      'last_pull_at:u': snapshot,
      'last_txn_pull_at:u': snapshot,
      'last_txn_reconcile_at:u': snapshot,
    });
    expect({
      landed: landed(),
      keys: metaKeys(),
      // The full sync took the bootstrap for the day's reconcile.
      reconcileKey: ctx.meta.get('last_txn_reconcile_at:u'),
      lastError: lastError(),
    }).toEqual({
      landed: {
        accounts: ['a1'],
        rules: ['r1'],
        transactions: ['t1'],
        splits: ['s1'],
      },
      keys: PULL_KEYS.map((key) => `${key}:u`),
      reconcileKey: snapshot,
      lastError: null,
    });
  });
});

describe('a reset with no session is refused before it wipes anything', () => {
  it('resetLocalData with no session refuses before its push, naming the sign-in and not the unsynced rows', async () => {
    const keys = seedPullKeysInSqlite();
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1', _sync_status: 'pending' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.installSupabase({ anonScoped: true });

    let err: unknown = null;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    expect({
      accounts: localIds('accounts'),
      t1: localStatus('transactions', 't1'),
      keys: keys(),
    }).toEqual({
      accounts: ['a1'],
      t1: 'pending',
      keys: [T0, T0, T0, T0],
    });
    // Without the first check the push is refused too, t1 stays pending, and
    // the reset blames "1 unsynced change(s)" and the connection instead.
    expect(String(err)).toBe(`Error: ${RESET_REFUSED}`);
    expect(lastError()).toBe(RESET_REFUSED);
  });

  it('resetLocalData whose session goes away at the probe refuses before the wipe', async () => {
    const keys = seedPullKeysInSqlite();
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    // Signed in for the first check and the push; gone by the probe, which
    // then reads `[]` with no error, i.e. "reachable".
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    flipAnonAtProbe(remote);

    let err: unknown = null;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    // Past the probe, the wipe runs and the re-download reads nothing: an
    // empty device that says "Synced", while the server still holds it all.
    expect({
      landed: landed(),
      keys: keys(),
      server: ctx.store.accounts.map((a) => a.id),
    }).toEqual({
      landed: { accounts: ['a1'], rules: [], transactions: ['t1'], splits: [] },
      keys: [T0, T0, T0, T0],
      server: ['a1'],
    });
    expect(String(err)).toBe(`Error: ${RESET_REFUSED}`);
    expect(lastError()).toBe(RESET_REFUSED);
  });
});

describe('a push with no session is refused before it writes anything', () => {
  it('pushChanges with no session leaves a queued delete queued and the server row live', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      _sync_status: 'deleted',
    });
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      account_id: 'a2',
      _sync_status: 'pending',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.installSupabase({ anonScoped: true });

    await pushChanges('u');

    // The tombstone UPDATE matches nothing under the anon key, and zero matched
    // rows is the push's success case, which hard-deletes the local row. The
    // server copy stays live, so the delete is lost and the next pull with a
    // session brings a1 back.
    expect({
      a1: localStatus('accounts', 'a1'),
      serverA1DeletedAt: ctx.store.accounts[0].deleted_at ?? null,
      t1: localStatus('transactions', 't1'),
      lastError: lastError(),
    }).toEqual({
      a1: 'deleted',
      serverA1DeletedAt: null,
      t1: 'pending',
      lastError: NO_SESSION,
    });
  });

  it('fullSync with no session: nothing uploaded, nothing stamped, label Sync error', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      _sync_status: 'pending',
    });
    ctx.installSupabase({ anonScoped: true });

    await fullSync('u');

    // Before: the upsert was refused (42501, reported nowhere) and the pull of
    // `[]` completed, so "Last synced: Just now" sat over "1 pending".
    const snapshot = getSyncSnapshot();
    expect({
      label: statusLabel(snapshot),
      lastError: snapshot.lastError,
      pendingCount: snapshot.pendingCount,
      server: ctx.store.accounts,
      keys: metaKeys(),
    }).toEqual({
      label: 'Sync error',
      lastError: NO_SESSION,
      pendingCount: 1,
      server: [],
      keys: [],
    });
  });
});

describe('a session that goes away mid-read fails the read', () => {
  it('a session that goes away between two pages of the accounts read does not delete the accounts past the page', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    // Fresh, so the transaction enumeration stays out of it.
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalAccount(ctx.adapter, { id: 'a2' });
    ctx.store.accounts = [
      remoteAccount({ id: 'a1' }),
      remoteAccount({ id: 'a2' }),
    ];
    // One row per page, so a1 arrives signed and the page that would carry a2
    // is the first one answered as nobody.
    const remote: SupabaseOpts = { maxRows: 1 };
    ctx.installSupabase(remote);
    flipAnonBeforePage(remote, 'accounts', 1);

    const complete = await pullChanges('u');

    // Taken as the end of the read, that empty page makes a1 the whole table,
    // and the absence loop deletes a2 on the strength of a page nobody signed.
    expect({
      complete,
      accounts: localIds('accounts'),
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      accounts: ['a1', 'a2'],
      lastPullAt: T0,
      lastError: lostMidRead('accounts'),
    });
  });

  it('a session that goes away before the trailing page of the incremental read holds the cursor', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.transactions = [
      remoteTxn({ id: 't2', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    flipAnonBeforePage(remote, 'transactions', 1);

    const complete = await pullChanges('u');

    // The page that arrived signed stands; the empty one after it is not the
    // end of the read, so the cursor is not banked over it.
    expect({
      complete,
      cursor: ctx.meta.get('last_txn_pull_at:u'),
      transactions: localIds('transactions'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      cursor: T0,
      transactions: ['t1', 't2'],
      lastError: lostMidRead('transactions'),
    });
  });

  it('a session that goes away before the FIRST page of the incremental read holds the cursor', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_pull_at:u', T0);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.transactions = [
      remoteTxn({ id: 't2', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    flipAnonBeforePage(remote, 'transactions', 0);

    const complete = await pullChanges('u');

    // Step 1 has no #19 guard, so an empty first page was "nothing changed"
    // and the cursor moved past t2 for good.
    expect({
      complete,
      cursor: ctx.meta.get('last_txn_pull_at:u'),
      transactions: localIds('transactions'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      cursor: T0,
      transactions: ['t1'],
      lastError: lostMidRead('transactions'),
    });
  });
});

// The fixture's `anonScoped` answers the way auth-js does after a refresh that
// timed out: no session, and the refresh's error. The other answers put the
// client on the anon key just the same, and each is hand-installed below over
// the anon-scoped fake: a refresh the auth server answered 503 (auth-js words
// a 502/503/504 as "{}", built from the Response itself), no stored session at
// all, which is what auth-js leaves once a refresh has failed for good (so no
// error comes with it), and getSession() rejecting (on web, auth-js's
// cross-tab lock taken from under it — the error keeps the plain name `Error`).
describe('the other answers auth-js gives for "no session" are refused too', () => {
  const REMOVED = async () => ({ data: { session: null }, error: null });
  const GATEWAY = {
    name: 'AuthRetryableFetchError',
    message: '{}',
    status: 503,
  };
  const LOCK_STOLEN = new Error(
    'Lock "lock:sb-test-auth-token" was released because another request stole it'
  );

  it.each([
    {
      how: 'the auth server answering 503',
      getSession: async () => ({ data: { session: null }, error: GATEWAY }),
      message:
        "Couldn't renew your sign-in: the sign-in service is unavailable",
    },
    {
      how: 'no stored session',
      getSession: REMOVED,
      message: "Couldn't verify your sign-in",
    },
    {
      how: 'getSession() rejecting',
      getSession: async () => {
        throw LOCK_STOLEN;
      },
      message: `Couldn't renew your sign-in: ${LOCK_STOLEN.message}`,
    },
  ])(
    'a pull is refused before it reads, with $how',
    async ({ getSession, message }) => {
      ctx.meta.set('last_pull_at:u', T0);
      ctx.meta.set('last_txn_pull_at:u', T0);
      await insertLocalTxn(ctx.adapter, { id: 't1' });
      ctx.installSupabase({ anonScoped: true });
      (supabase as any).auth = { getSession };

      const complete = await pullChanges('u');

      expect({
        complete,
        cursor: ctx.meta.get('last_txn_pull_at:u'),
        attempt: ctx.meta.get('last_pull_attempt_at:u'),
        lastError: lastError(),
      }).toEqual({
        complete: false,
        cursor: T0,
        attempt: undefined,
        lastError: message,
      });
    }
  );

  it('a read whose session auth-js removes between two pages fails as unverified', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalAccount(ctx.adapter, { id: 'a2' });
    ctx.store.accounts = [
      remoteAccount({ id: 'a1' }),
      remoteAccount({ id: 'a2' }),
    ];
    const remote: SupabaseOpts = { maxRows: 1 };
    ctx.installSupabase(remote);
    flipAnonBeforePage(remote, 'accounts', 1);
    (supabase as any).auth = {
      getSession: async () =>
        remote.anonScoped
          ? REMOVED()
          : { data: { session: FAKE_SESSION }, error: null },
    };

    const complete = await pullChanges('u');

    expect({
      complete,
      accounts: localIds('accounts'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      accounts: ['a1', 'a2'],
      lastError:
        "Couldn't download accounts: your sign-in could not be verified",
    });
  });
});

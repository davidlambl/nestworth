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
// fixture's `anonScoped` is the client with no session whose requests reach
// the server; it goes through installSupabase, which installs `auth` as well
// as `from`.
//
// Since #109 the app's client never sends a PostgREST request signed with the
// anon key (lib/fetchWithTimeout.ts refuses it), so the answers above no longer
// reach the engine in the app, and these checks are its second line. The tests
// up to the last describe keep `anonScoped` because it is what the checks
// defend against. The last describe uses `anonRejected`, the client as
// configured since #109, and pins what the engine does with the refusal.
//
// #111: a session that belongs to ANOTHER user, i.e. an account switch
// mid-sync. useSyncEngine is keyed on the user id and its cleanup only flips
// `cancelled`, so a sync for the outgoing user that is in flight or queued when
// the next one signs in runs under the new user's token. RLS then answers
// every read of the old user's rows `[]` and lets every tombstone UPDATE of
// them match nothing, with the anon key's consequences. The same checks now
// compare the session's user with the user being synced, and a push asks
// again just before each tombstone write and each changed parent's split
// DELETE, since the session can go, or change hands, mid-push. A push or a
// pull refused that way only warns (the new user has nothing to act on); a
// bootstrap or a reset reports. The fixture's `sessionUserId` is the
// session's user, and it answers every read and write as that user.
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
  requestPush,
  resetLocalData,
  startSyncSession,
} from '../sync';
import { supabase } from '../supabase';
import { getSyncSnapshot, setLastError } from '../syncStatus';
import { statusLabel } from '../syncStatusHelpers';
import {
  FAKE_SESSION,
  insertLocalAccount,
  insertLocalSplit,
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

/** #111's refusal of a bootstrap: whose session it is, and nothing more. */
const WRONG_USER = 'Signed in as a different account';

/** The reset's refusal under another user's session. */
const WRONG_USER_RESET = `${WRONG_USER} — reset cancelled, your local data is unchanged.`;

/**
 * Which "no session" a flip below turns on: the server's answers to an
 * anon-signed request (`anonScoped`), or the client's refusal to send one
 * (`anonRejected`, since #109). See SupabaseOpts.
 */
type NoSessionFlag = 'anonScoped' | 'anonRejected';

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
function seedPullKeysInSqlite(userId = 'u'): () => (string | undefined)[] {
  const meta = wireSqliteSyncMeta(ctx.adapter);
  for (const key of PULL_KEYS) {
    meta.set(`${key}:${userId}`, T0);
  }
  return () => PULL_KEYS.map((key) => meta.get(`${key}:${userId}`));
}

/**
 * Runs `change` just before the `pageIndex`-th page request on `table`
 * (counted from 0 across every read of it). The fake reads its options on
 * every request, so a change to the object it was installed with applies from
 * that page on. The wrapping pattern of syncTombstoneRaces.test.ts's failed
 * refresh read, on `.range()`.
 */
function beforePage(table: string, pageIndex: number, change: () => void) {
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
        change();
      }
      return realRange(from, to);
    };
    return builder;
  };
}

/**
 * Takes the session away just before the `pageIndex`-th page request on
 * `table`: pages before it are answered as the user, that page and everything
 * after it as nobody.
 */
function flipAnonBeforePage(
  remote: SupabaseOpts,
  table: string,
  pageIndex: number
) {
  beforePage(table, pageIndex, () => {
    remote.anonScoped = true;
  });
}

/**
 * Runs `change` once the `updateIndex`-th UPDATE on `table` (counted from 0)
 * has been answered, before the engine reads the answer: the session going
 * away, or another account signing in, between two of a push's tombstone
 * writes. The UPDATE itself runs under the session it was sent with.
 */
function afterUpdate(table: string, updateIndex: number, change: () => void) {
  const realFrom = (supabase as any).from;
  let updates = 0;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t !== table) {
      return builder;
    }
    const realUpdate = builder.update;
    builder.update = (patch: any) => {
      const upd = realUpdate(patch);
      if (updates++ === updateIndex) {
        // The filters chain on `upd` itself, so its `then` is the one the
        // engine awaits.
        const realThen = upd.then;
        upd.then = (resolve: any, reject: any) =>
          realThen((answer: any) => {
            change();
            return answer;
          }).then(resolve, reject);
      }
      return upd;
    };
    return builder;
  };
}

/**
 * Parks the first local read whose SQL matches `match` until `block` settles,
 * and resolves the returned promise once it is parked — so a test can act
 * while a lock holder sits at a known point (syncLockQueueUsers.test.ts's
 * gate, 'before' form).
 */
function parkFirstRead(
  match: RegExp,
  block: () => Promise<void>
): Promise<void> {
  const real = ctx.adapter.getAllAsync.bind(ctx.adapter);
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let fired = false;
  ctx.adapter.getAllAsync = async (sql: string, params: any[] = []) => {
    if (!fired && match.test(sql)) {
      fired = true;
      arrive();
      await block();
    }
    return real(sql, params);
  };
  return arrived;
}

/**
 * Records the table of every request the engine sends from here on: a sync
 * refused at its entry must leave the list empty.
 */
function trackRequests(): string[] {
  const tables: string[] = [];
  const realFrom = (supabase as any).from;
  (supabase as any).from = (t: string) => {
    tables.push(t);
    return realFrom(t);
  };
  return tables;
}

/** Every console.warn so far, each call's arguments joined by a space. */
const warnings = () =>
  (console.warn as unknown as jest.Mock).mock.calls.map((args: unknown[]) =>
    args.map(String).join(' ')
  );

/**
 * Runs `change` at the reset's reachability probe, the one read that calls
 * `.limit()`: after the reset's first session check and its push, and before
 * the probe is answered.
 */
function atProbe(change: () => void) {
  const realFrom = (supabase as any).from;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t !== 'accounts') {
      return builder;
    }
    const realLimit = builder.limit;
    builder.limit = (n: number) => {
      change();
      return realLimit(n);
    };
    return builder;
  };
}

/**
 * Takes the session away at the reset's reachability probe, as the server
 * answers it (`anonScoped`) or as the client refuses to send it
 * (`anonRejected`, since #109).
 */
function flipAnonAtProbe(
  remote: SupabaseOpts,
  flag: NoSessionFlag = 'anonScoped'
) {
  atProbe(() => {
    remote[flag] = true;
  });
}

/**
 * The session flaps for exactly one page: the `pageIndex`-th page request on
 * `table` is built with `anonRejected` on (the fake answers `.range()` as it
 * is called), and it is off again before any other request, or any session
 * check, can ask. The window #109 closes: that page's own token refresh
 * failed, so it went out signed with the anon key, and the next refresh
 * succeeded.
 */
function refuseOnePage(remote: SupabaseOpts, table: string, pageIndex: number) {
  const realFrom = (supabase as any).from;
  let pages = 0;
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    if (t !== table) {
      return builder;
    }
    const realRange = builder.range;
    builder.range = (from: number, to: number) => {
      if (pages++ !== pageIndex) {
        return realRange(from, to);
      }
      remote.anonRejected = true;
      try {
        return realRange(from, to);
      } finally {
        remote.anonRejected = false;
      }
    };
    return builder;
  };
}

/**
 * Takes the session away as the first tombstone UPDATE on `table` is built:
 * past pushChanges' entry check, before anything is sent. Counts the UPDATEs
 * built on every table, so a test can tell the push reached them.
 */
function flipAnonAtFirstUpdate(
  remote: SupabaseOpts,
  table: string,
  flag: NoSessionFlag
): () => Record<string, number> {
  const realFrom = (supabase as any).from;
  const updates: Record<string, number> = {};
  (supabase as any).from = (t: string) => {
    const builder = realFrom(t);
    const realUpdate = builder.update;
    builder.update = (patch: any) => {
      updates[t] = (updates[t] ?? 0) + 1;
      if (t === table) {
        remote[flag] = true;
      }
      return realUpdate(patch);
    };
    return builder;
  };
  return () => ({ ...updates });
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

// Every test below, up to the nested describe at the end, syncs user a while
// the session is user b's for at least part of the way. Signed as b, the
// server answers a's rows exactly as the anon key does: every read `[]`,
// every tombstone UPDATE a match of nothing, every upsert 42501.
describe("#111 — another user's session", () => {
  /** What a refused push or pull warns: both ids, since no user reads it. */
  const REFUSED = 'the session belongs to b, not a';

  it("pullChanges('a') under b's session holds a's cursor, stamps neither key and only warns", async () => {
    ctx.meta.set('last_pull_at:a', T0);
    ctx.meta.set('last_txn_pull_at:a', T0);
    // Fresh, so the reconcile stays out of it: step 1 is the read no #19
    // guard covers.
    ctx.meta.set('last_txn_reconcile_at:a', new Date().toISOString());
    await insertLocalTxn(ctx.adapter, { id: 't1', user_id: 'a' });
    ctx.store.transactions = [
      remoteTxn({ id: 't1', user_id: 'a' }),
      remoteTxn({ id: 't2', user_id: 'a', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    ctx.installSupabase({ sessionUserId: 'b' });
    const requested = trackRequests();

    const complete = await pullChanges('a');

    // Signed as b, step 1 read `[]`, took it for "nothing changed since T0"
    // and banked the cursor past t2, which no incremental read returns again;
    // and the pull stamped itself complete over reads that saw nothing.
    // Nothing is reported: b is signed in now, and a's pull is not b's to fix.
    expect({
      complete,
      transactions: localIds('transactions'),
      cursor: ctx.meta.get('last_txn_pull_at:a'),
      lastPullAt: ctx.meta.get('last_pull_at:a'),
      attempt: ctx.meta.get('last_pull_attempt_at:a'),
      requested,
      lastError: lastError(),
    }).toEqual({
      complete: false,
      transactions: ['t1'],
      cursor: T0,
      lastPullAt: T0,
      attempt: undefined,
      requested: [],
      lastError: null,
    });
    expect(warnings()).toContain(`[sync] pull refused: ${REFUSED}`);
  });

  it('a fresh user pulled under another session does not stamp a complete pull', async () => {
    // Nothing local, so no #19 guard can fire: every `[]` would be taken at
    // its word, while a's rows sit on the server.
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', user_id: 'a' })];
    ctx.installSupabase({ sessionUserId: 'b' });

    const complete = await pullChanges('a');

    expect({
      complete,
      landed: landed(),
      keys: metaKeys(),
      needsInitialPull: await needsInitialPull('a'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      landed: { accounts: [], rules: [], transactions: [], splits: [] },
      keys: [],
      needsInitialPull: true,
      lastError: null,
    });
  });

  it("pushChanges('a') under b's session leaves a's queued delete queued and the server row live", async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      user_id: 'a',
      _sync_status: 'deleted',
    });
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      user_id: 'a',
      account_id: 'a2',
      _sync_status: 'pending',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    ctx.installSupabase({ sessionUserId: 'b' });
    const requested = trackRequests();

    await pushChanges('a');

    // Signed as b, the tombstone UPDATE matches none of a's rows, and zero
    // matched rows is the push's success case: it hard-deleted a1 here while
    // the server copy stayed live, so a's next pull brought it back. Refused
    // at its entry, the push sends nothing at all.
    expect({
      a1: localStatus('accounts', 'a1'),
      serverA1DeletedAt: ctx.store.accounts[0].deleted_at ?? null,
      t1: localStatus('transactions', 't1'),
      serverTransactions: ctx.store.transactions,
      requested,
      lastError: lastError(),
    }).toEqual({
      a1: 'deleted',
      serverA1DeletedAt: null,
      t1: 'pending',
      serverTransactions: [],
      requested: [],
      lastError: null,
    });
    expect(warnings()).toContain(`[sync] push refused: ${REFUSED}`);
  });

  it('a session that switches between two tombstone UPDATEs leaves the second delete queued', async () => {
    for (const id of ['a1', 'a2']) {
      await insertLocalAccount(ctx.adapter, {
        id,
        user_id: 'a',
        _sync_status: 'deleted',
      });
    }
    ctx.store.accounts = [
      remoteAccount({ id: 'a1', user_id: 'a' }),
      remoteAccount({ id: 'a2', user_id: 'a' }),
    ];
    // Signed in as a for the push's first check and its first tombstone; b
    // signs in as that tombstone is answered.
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);
    afterUpdate('accounts', 0, () => {
      remote.sessionUserId = 'b';
    });

    await pushChanges('a');

    // The first delete landed as a and went; the second UPDATE, signed as b,
    // matched nothing and was taken for success: hard-deleted here, live
    // there. Asked by state, not by id: the push reads the rows unordered.
    const queued = localIds('accounts');
    const live = ctx.store.accounts
      .filter((a) => a.deleted_at == null)
      .map((a) => a.id);
    expect({
      queued: queued.length,
      queuedStatus: queued.map((id) => localStatus('accounts', id)),
      live,
      lastError: lastError(),
    }).toEqual({
      queued: 1,
      queuedStatus: ['deleted'],
      live: queued,
      lastError: null,
    });
  });

  it('a session that switches between two tombstone batches leaves the second batch queued', async () => {
    // 201 queued deletes: a batch of 200, then one.
    const ids = Array.from(
      { length: 201 },
      (_, i) => `t${String(i).padStart(3, '0')}`
    );
    for (const id of ids) {
      await insertLocalTxn(ctx.adapter, {
        id,
        user_id: 'a',
        _sync_status: 'deleted',
      });
    }
    ctx.store.transactions = ids.map((id) => remoteTxn({ id, user_id: 'a' }));
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);
    afterUpdate('transactions', 0, () => {
      remote.sessionUserId = 'b';
    });

    await pushChanges('a');

    // One check per table would pass here: b signs in after the first
    // batch, so only a check before EACH batch keeps the second one queued.
    const queued = localIds('transactions');
    const live = ctx.store.transactions
      .filter((t) => t.deleted_at == null)
      .map((t) => t.id);
    expect({
      queued: queued.length,
      queuedStatus: queued.map((id) => localStatus('transactions', id)),
      live,
      lastError: lastError(),
    }).toEqual({
      queued: 1,
      queuedStatus: ['deleted'],
      live: queued,
      lastError: null,
    });
  });

  it("a session that switches after a parent's upsert leaves a parent whose splits were all removed pending", async () => {
    // The edit removed t1's only split: s1 is 'deleted' and nothing replaces
    // it, so the push sends the split DELETE and no insert after it.
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      user_id: 'a',
      updated_at: '2026-07-01T00:00:00Z',
      _sync_status: 'pending',
    });
    await insertLocalSplit(ctx.adapter, {
      id: 's1',
      transaction_id: 't1',
      _sync_status: 'deleted',
    });
    ctx.store.transactions = [remoteTxn({ id: 't1', user_id: 'a' })];
    ctx.store.transaction_splits = [
      { id: 's1', transaction_id: 't1', amount: 0, memo: null },
    ];
    // b signs in as the parent's upsert, signed as a, is answered.
    const remote: SupabaseOpts = {
      sessionUserId: 'a',
      onAfterUpsert: async (table) => {
        if (table === 'transactions') {
          remote.sessionUserId = 'b';
        }
      },
    };
    ctx.installSupabase(remote);

    await pushChanges('a');

    // Signed as b, the split DELETE matched nothing, which is success, and
    // with no insert after it to be refused the parent was marked synced and
    // s1 dropped here, while the server kept s1: the removal was lost, and
    // the next pull's split refresh would bring s1 back.
    expect({
      t1: localStatus('transactions', 't1'),
      localSplits: localIds('transaction_splits').map(
        (id) => `${id}:${localStatus('transaction_splits', id)}`
      ),
      serverSplits: ctx.store.transaction_splits.map((s) => s.id),
      lastError: lastError(),
    }).toEqual({
      t1: 'pending',
      localSplits: ['s1:deleted'],
      serverSplits: ['s1'],
      lastError: null,
    });
  });

  it("initialPull('a') under b's session stamps nothing and says why", async () => {
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', user_id: 'a' })];
    ctx.installSupabase({ sessionUserId: 'b' });

    await initialPull('a');

    // Signed as b, every read answered `[]` and the bootstrap stamped all
    // three keys over nothing: a's device "fully pulled", with every row it
    // owns still on the server.
    expect({
      landed: landed(),
      keys: metaKeys(),
      needsInitialPull: await needsInitialPull('a'),
      lastError: lastError(),
    }).toEqual({
      landed: { accounts: [], rules: [], transactions: [], splits: [] },
      keys: [],
      needsInitialPull: true,
      lastError: WRONG_USER,
    });
  });

  it("resetLocalData('a') under b's session refuses before its push, and wipes nothing", async () => {
    const keys = seedPullKeysInSqlite('a');
    await insertLocalAccount(ctx.adapter, { id: 'a1', user_id: 'a' });
    await insertLocalTxn(ctx.adapter, { id: 't1', user_id: 'a' });
    // A queued delete, so the refusal has to come before the push: past the
    // first check, the push is refused too and the reset blames "1 unsynced
    // change(s)" instead.
    await insertLocalTxn(ctx.adapter, {
      id: 't2',
      user_id: 'a',
      _sync_status: 'deleted',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    ctx.store.transactions = [
      remoteTxn({ id: 't1', user_id: 'a' }),
      remoteTxn({ id: 't2', user_id: 'a' }),
    ];
    ctx.installSupabase({ sessionUserId: 'b' });

    let err: unknown = null;
    try {
      await resetLocalData('a');
    } catch (e) {
      err = e;
    }

    // Signed as b, the push hard-deleted t2 (its tombstone matched nothing),
    // the probe read `[]` with no error ("reachable"), the wipe ran and the
    // re-download read nothing: a's device emptied, and the reset reported
    // success, while the server still holds it all, t2 live.
    expect({
      landed: landed(),
      t2: localStatus('transactions', 't2'),
      serverT2DeletedAt: ctx.store.transactions[1].deleted_at ?? null,
      keys: keys(),
    }).toEqual({
      landed: {
        accounts: ['a1'],
        rules: [],
        transactions: ['t1', 't2'],
        splits: [],
      },
      t2: 'deleted',
      serverT2DeletedAt: null,
      keys: [T0, T0, T0, T0],
    });
    expect(String(err)).toBe(`Error: ${WRONG_USER_RESET}`);
    expect(lastError()).toBe(WRONG_USER_RESET);
  });

  it("resetLocalData('a') whose session passes to b at the probe refuses before the wipe", async () => {
    const keys = seedPullKeysInSqlite('a');
    await insertLocalAccount(ctx.adapter, { id: 'a1', user_id: 'a' });
    await insertLocalTxn(ctx.adapter, { id: 't1', user_id: 'a' });
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', user_id: 'a' })];
    // a's for the first check and the push; b's by the probe, which then
    // reads `[]` with no error, i.e. "reachable".
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);
    atProbe(() => {
      remote.sessionUserId = 'b';
    });

    let err: unknown = null;
    try {
      await resetLocalData('a');
    } catch (e) {
      err = e;
    }

    // Past the probe, the wipe runs and a's device is left empty whatever the
    // re-download does: before #111 it read `[]` as b and stamped itself
    // complete; refused by the pull's own check, it leaves a's keys unset.
    expect({ landed: landed(), keys: keys() }).toEqual({
      landed: { accounts: ['a1'], rules: [], transactions: ['t1'], splits: [] },
      keys: [T0, T0, T0, T0],
    });
    expect(String(err)).toBe(`Error: ${WRONG_USER_RESET}`);
    expect(lastError()).toBe(WRONG_USER_RESET);
  });

  it("resetLocalData('a') whose session passes to b during the wipe rejects, and says so", async () => {
    const keys = seedPullKeysInSqlite('a');
    await insertLocalAccount(ctx.adapter, { id: 'a1', user_id: 'a' });
    ctx.store.accounts = [remoteAccount({ id: 'a1', user_id: 'a' })];
    // a's through step 2b; b's from the wipe's accounts DELETE on, so the
    // re-download, pullChanges under throwOnError, is the first thing to meet
    // b's session.
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);
    const realRun = ctx.adapter.runAsync.bind(ctx.adapter);
    ctx.adapter.runAsync = async (sql: string, params: any[] = []) => {
      const result = await realRun(sql, params);
      if (/DELETE FROM accounts WHERE user_id = \?/.test(sql)) {
        remote.sessionUserId = 'b';
      }
      return result;
    };

    let err: unknown = null;
    try {
      await resetLocalData('a');
    } catch (e) {
      err = e;
    }

    // Past the wipe this is a failed reset, not a cancelled one: a's keys stay
    // unset, so a's next launch re-bootstraps. Before, the re-download read
    // `[]` as b, stamped itself complete, and the reset reported success over
    // an empty device.
    expect({ landed: landed(), keys: keys() }).toEqual({
      landed: { accounts: [], rules: [], transactions: [], splits: [] },
      keys: [undefined, undefined, undefined, undefined],
    });
    expect(String(err)).toBe(`Error: ${WRONG_USER}`);
    expect(lastError()).toBe(WRONG_USER);
  });

  it('a session that switches between two pages of a read fails the read and holds the cursor', async () => {
    ctx.meta.set('last_pull_at:a', T0);
    ctx.meta.set('last_txn_pull_at:a', T0);
    ctx.meta.set('last_txn_reconcile_at:a', new Date().toISOString());
    ctx.store.transactions = [
      remoteTxn({ id: 't1', user_id: 'a', updated_at: '2026-07-01T00:00:00Z' }),
      remoteTxn({ id: 't2', user_id: 'a', updated_at: '2026-07-01T00:00:00Z' }),
    ];
    // One row per page: t1 arrives signed as a, and b signs in before the
    // page that would carry t2, which b's session answers `[]`.
    const remote: SupabaseOpts = { sessionUserId: 'a', maxRows: 1 };
    ctx.installSupabase(remote);
    beforePage('transactions', 1, () => {
      remote.sessionUserId = 'b';
    });

    const complete = await pullChanges('a');

    // Taken for the end of the read, that page banked the cursor past t2.
    expect({
      complete,
      transactions: localIds('transactions'),
      cursor: ctx.meta.get('last_txn_pull_at:a'),
      lastPullAt: ctx.meta.get('last_pull_at:a'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      transactions: ['t1'],
      cursor: T0,
      lastPullAt: T0,
      lastError:
        "Couldn't download transactions: your sign-in belongs to a different account",
    });
  });

  it("the switch end to end: a's sync and its queued follow-up are refused, and b's sync runs as b", async () => {
    ctx.meta.set('last_pull_at:a', T0);
    ctx.meta.set('last_txn_pull_at:a', T0);
    ctx.meta.set('last_txn_reconcile_at:a', new Date().toISOString());
    // a's unsynced work: an edit and a queued delete.
    await insertLocalAccount(ctx.adapter, {
      id: 'a-edit',
      user_id: 'a',
      _sync_status: 'pending',
    });
    await insertLocalAccount(ctx.adapter, {
      id: 'a-gone',
      user_id: 'a',
      _sync_status: 'deleted',
    });
    ctx.store.accounts = [
      remoteAccount({ id: 'a-gone', user_id: 'a' }),
      remoteAccount({ id: 'b1', user_id: 'b' }),
    ];
    ctx.store.transactions = [
      remoteTxn({
        id: 'a-new',
        user_id: 'a',
        updated_at: '2026-07-01T00:00:00Z',
      }),
    ];
    const remote: SupabaseOpts = { sessionUserId: 'a' };
    ctx.installSupabase(remote);

    // a's push holds the lock, parked at its first read of pending rows...
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const parked = parkFirstRead(
      /FROM accounts WHERE _sync_status = 'pending'/,
      () => gate
    );
    const aPush = requestPush('a');
    await parked;
    // ...when b signs in. a's own full sync, requested now, is queued behind
    // it as the holder's user; b's startup sync waits for the lock.
    remote.sessionUserId = 'b';
    const aFollowUp = fullSync('a');
    const bSync = fullSync('b');
    open();
    await aPush;
    await aFollowUp;
    await bSync;

    // Before: a's push sent its tombstone under b's token and hard-deleted
    // a-gone on the zero match, and the drained full sync pulled a's rows as
    // b, read `[]` and banked a's cursor past a-new.
    expect({
      aEdit: localStatus('accounts', 'a-edit'),
      aGone: localStatus('accounts', 'a-gone'),
      serverAGoneDeletedAt: ctx.store.accounts[0].deleted_at ?? null,
      aNew: localStatus('transactions', 'a-new'),
      aCursor: ctx.meta.get('last_txn_pull_at:a'),
      aLastPull: ctx.meta.get('last_pull_at:a'),
      b1: localStatus('accounts', 'b1'),
      bBootstrapped: !(await needsInitialPull('b')),
      lastError: lastError(),
    }).toEqual({
      aEdit: 'pending',
      aGone: 'deleted',
      serverAGoneDeletedAt: null,
      aNew: null,
      aCursor: T0,
      aLastPull: T0,
      b1: 'synced',
      bBootstrapped: true,
      lastError: null,
    });
    expect(warnings()).toEqual(
      expect.arrayContaining([
        `[sync] push refused: ${REFUSED}`,
        `[sync] pull refused: ${REFUSED}`,
      ])
    );
  });

  // The per-write checks refuse either failure, so they also close #95's
  // mid-push residue: a session that simply goes away between the push's
  // entry check and a later write. Signed with the anon key, that write
  // matches nothing just as it does signed as another user. User 'u' here,
  // with no second account.
  describe('the same checks, for a session that goes away mid-push', () => {
    it('a session that goes away between two tombstone UPDATEs leaves the second delete queued', async () => {
      for (const id of ['a1', 'a2']) {
        await insertLocalAccount(ctx.adapter, { id, _sync_status: 'deleted' });
      }
      ctx.store.accounts = [
        remoteAccount({ id: 'a1' }),
        remoteAccount({ id: 'a2' }),
      ];
      const remote: SupabaseOpts = {};
      ctx.installSupabase(remote);
      afterUpdate('accounts', 0, () => {
        remote.anonScoped = true;
      });

      await pushChanges('u');

      // The second UPDATE, signed with the anon key, matched nothing and was
      // taken for success: hard-deleted here, live there.
      const queued = localIds('accounts');
      const live = ctx.store.accounts
        .filter((a) => a.deleted_at == null)
        .map((a) => a.id);
      expect({
        queued: queued.length,
        queuedStatus: queued.map((id) => localStatus('accounts', id)),
        live,
      }).toEqual({
        queued: 1,
        queuedStatus: ['deleted'],
        live: queued,
      });
    });

    it('a session that goes away between two tombstone batches leaves the second batch queued', async () => {
      const ids = Array.from(
        { length: 201 },
        (_, i) => `t${String(i).padStart(3, '0')}`
      );
      for (const id of ids) {
        await insertLocalTxn(ctx.adapter, { id, _sync_status: 'deleted' });
      }
      ctx.store.transactions = ids.map((id) => remoteTxn({ id }));
      const remote: SupabaseOpts = {};
      ctx.installSupabase(remote);
      afterUpdate('transactions', 0, () => {
        remote.anonScoped = true;
      });

      await pushChanges('u');

      const queued = localIds('transactions');
      const live = ctx.store.transactions
        .filter((t) => t.deleted_at == null)
        .map((t) => t.id);
      expect({
        queued: queued.length,
        queuedStatus: queued.map((id) => localStatus('transactions', id)),
        live,
      }).toEqual({
        queued: 1,
        queuedStatus: ['deleted'],
        live: queued,
      });
    });

    it("a session that goes away after a parent's upsert leaves a parent whose splits were all removed pending", async () => {
      await insertLocalTxn(ctx.adapter, {
        id: 't1',
        updated_at: '2026-07-01T00:00:00Z',
        _sync_status: 'pending',
      });
      await insertLocalSplit(ctx.adapter, {
        id: 's1',
        transaction_id: 't1',
        _sync_status: 'deleted',
      });
      ctx.store.transactions = [remoteTxn({ id: 't1' })];
      ctx.store.transaction_splits = [
        { id: 's1', transaction_id: 't1', amount: 0, memo: null },
      ];
      const remote: SupabaseOpts = {
        onAfterUpsert: async (table) => {
          if (table === 'transactions') {
            remote.anonScoped = true;
          }
        },
      };
      ctx.installSupabase(remote);

      await pushChanges('u');

      expect({
        t1: localStatus('transactions', 't1'),
        localSplits: localIds('transaction_splits').map(
          (id) => `${id}:${localStatus('transaction_splits', id)}`
        ),
        serverSplits: ctx.store.transaction_splits.map((s) => s.id),
      }).toEqual({
        t1: 'pending',
        localSplits: ['s1:deleted'],
        serverSplits: ['s1'],
      });
    });
  });
});

// PINS, not regression proofs. No fixture suite reaches lib/fetchWithTimeout.ts
// (every one mocks ../supabase), so `anonRejected` hands the engine what
// postgrest-js makes of the wrapper's refusal, and the engine's handling of a
// request that fails with `{ error }` predates #109. What these pin is that the
// refusal lands on those failure paths: a read that fails, a write that stays
// queued. The regression proof is supabaseAnonRejection.test.ts, through the
// real client. Where the user's words differ, they differ through
// lib/requestError.ts's NoSessionError arm, and only there is a test here red
// without #109.
describe('since #109 an anon-signed request is refused before it is sent, and the engine treats the refusal as a failure', () => {
  it('a session lost mid-push leaves its deletes queued, and the next push with a session sends them (pin)', async () => {
    await insertLocalAccount(ctx.adapter, {
      id: 'a1',
      _sync_status: 'deleted',
    });
    await insertLocalTxn(ctx.adapter, {
      id: 't1',
      account_id: 'a1',
      _sync_status: 'deleted',
    });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1', account_id: 'a1' })];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    const updates = flipAnonAtFirstUpdate(remote, 'accounts', 'anonRejected');

    await pushChanges('u');

    // The session goes after the entry check, as the first tombstone UPDATE
    // is built. Sent with the anon key, each UPDATE matched nothing, and zero
    // matched rows is the success case that hard-deletes the local row: the
    // delete was lost, and the next pull brought the row back. Refused, each
    // takes its error branch and the row stays queued. Nothing is reported:
    // the next sync's entry check is what names the sign-in.
    //
    // Since #111 each tombstone write asks for the session just before it is
    // built, so only the accounts UPDATE reaches the wrapper: its own check
    // passed, and the session went in the window after it, which is the
    // window the wrapper covers. The transactions batch asks first, finds no
    // session and is never built. The next test drives a batch into that
    // window.
    expect({
      updates: updates(),
      a1: localStatus('accounts', 'a1'),
      t1: localStatus('transactions', 't1'),
      server: [
        ctx.store.accounts[0].deleted_at ?? null,
        ctx.store.transactions[0].deleted_at ?? null,
      ],
      lastError: lastError(),
    }).toEqual({
      updates: { accounts: 1 },
      a1: 'deleted',
      t1: 'deleted',
      server: [null, null],
      lastError: null,
    });

    // The next push, still without a session, is refused at its entry check.
    await pushChanges('u');
    expect({
      a1: localStatus('accounts', 'a1'),
      t1: localStatus('transactions', 't1'),
      lastError: lastError(),
    }).toEqual({ a1: 'deleted', t1: 'deleted', lastError: NO_SESSION });

    // Signed in again, the deletes go up as tombstones and leave the device.
    ctx.installSupabase({});
    await pushChanges('u');
    expect({
      a1: localStatus('accounts', 'a1'),
      t1: localStatus('transactions', 't1'),
      server: [
        ctx.store.accounts[0].deleted_at ?? null,
        ctx.store.transactions[0].deleted_at ?? null,
      ],
    }).toEqual({
      a1: null,
      t1: null,
      server: [expect.any(String), expect.any(String)],
    });
  });

  it("a session lost after a tombstone batch's own check leaves the batch queued (pin)", async () => {
    // What #111's per-batch check leaves to the wrapper: the check passes,
    // and the session goes as the batch's UPDATE is built. Refused before it
    // is sent, the batch takes its error branch and stays queued.
    await insertLocalTxn(ctx.adapter, { id: 't1', _sync_status: 'deleted' });
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    const updates = flipAnonAtFirstUpdate(
      remote,
      'transactions',
      'anonRejected'
    );

    await pushChanges('u');

    expect({
      updates: updates(),
      t1: localStatus('transactions', 't1'),
      serverT1DeletedAt: ctx.store.transactions[0].deleted_at ?? null,
      lastError: lastError(),
    }).toEqual({
      updates: { transactions: 1 },
      t1: 'deleted',
      serverT1DeletedAt: null,
      lastError: null,
    });
  });

  it('a page refused while the session flapped fails the read, though every session check finds one (pin; its words red without #109)', async () => {
    ctx.meta.set('last_pull_at:u', T0);
    // Fresh, so the transaction enumeration stays out of it.
    ctx.meta.set('last_txn_reconcile_at:u', new Date().toISOString());
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalAccount(ctx.adapter, { id: 'a2' });
    ctx.store.accounts = [
      remoteAccount({ id: 'a1' }),
      remoteAccount({ id: 'a2' }),
    ];
    // One row per page: a1 arrives signed, and the page that would carry a2
    // is the one whose refresh failed.
    const remote: SupabaseOpts = { maxRows: 1 };
    ctx.installSupabase(remote);
    refuseOnePage(remote, 'accounts', 1);

    const complete = await pullChanges('u');

    // The window CONTRIBUTING's Known Issues used to name: answered, that page
    // was `200 []`, the session was back by the time readAllPages asked, and
    // the empty page ended the read, so the absence loop deleted a2 locally.
    // Refused, it fails the read, and the pull withholds what a failed read
    // withholds.
    expect({
      complete,
      accounts: localIds('accounts'),
      lastPullAt: ctx.meta.get('last_pull_at:u'),
      lastError: lastError(),
    }).toEqual({
      complete: false,
      accounts: ['a1', 'a2'],
      lastPullAt: T0,
      lastError:
        "Couldn't download accounts: your sign-in could not be verified",
    });
  });

  it('a reset whose session goes before its probe is refused at the probe, naming the sign-in (pin; its words red without #109)', async () => {
    const keys = seedPullKeysInSqlite();
    await insertLocalAccount(ctx.adapter, { id: 'a1' });
    await insertLocalTxn(ctx.adapter, { id: 't1' });
    ctx.store.accounts = [remoteAccount({ id: 'a1' })];
    ctx.store.transactions = [remoteTxn({ id: 't1' })];
    const remote: SupabaseOpts = {};
    ctx.installSupabase(remote);
    flipAnonAtProbe(remote, 'anonRejected');

    let err: unknown = null;
    try {
      await resetLocalData('u');
    } catch (e) {
      err = e;
    }

    // Refused at the probe rather than at step 2b, so it reads as the cloud
    // being out of reach, with the sign-in named in the parentheses.
    const refused =
      "Can't reach the cloud — reset cancelled, your local data is unchanged. (your sign-in could not be verified)";
    expect({ landed: landed(), keys: keys() }).toEqual({
      landed: { accounts: ['a1'], rules: [], transactions: ['t1'], splits: [] },
      keys: [T0, T0, T0, T0],
    });
    expect(String(err)).toBe(`Error: ${refused}`);
    expect(lastError()).toBe(refused);
  });
});

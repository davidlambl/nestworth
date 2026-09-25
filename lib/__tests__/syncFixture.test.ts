// The Supabase fake is now shared by every sync suite, so the behaviours those
// suites lean on are asserted here rather than assumed. Each test below pins a
// property of real PostgREST/Postgres that a sloppier fake would get wrong in a
// way that makes a *sync* test pass for the wrong reason.
//
// The fixture imports '../supabase' and '../db' at module scope, so the same
// mocks sync.test.ts declares are required here even though this file only
// exercises the in-memory fake.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  FAKE_SESSION,
  fakeSession,
  makeSupabase,
  makeAdapter,
  remoteAccount,
  remoteRule,
  remoteTxn,
  type Store,
  type SupabaseOpts,
} from '../testing/syncFixture';

const SERVER_NOW = '2026-06-01T12:00:00+00:00';
const TOMBSTONE = '2026-06-01T12:00:00Z';

function makeStore(): Store {
  return {
    accounts: [],
    transactions: [],
    transaction_splits: [],
    recurring_rules: [],
  };
}

describe('makeAdapter().withTransactionAsync()', () => {
  it('runs ROLLBACK when its BEGIN fails, ending the transaction already open, as expo-sqlite does', async () => {
    // expo-sqlite 16.0.10 (src/SQLiteDatabase.ts) runs BEGIN inside the try,
    // so a BEGIN refused because a transaction is already open on the shared
    // connection still reaches the catch, and its ROLLBACK ends that other
    // transaction. With BEGIN outside the try the fixture hid every such
    // collision from the sync tests (#97).
    const adapter = makeAdapter();
    try {
      adapter._sqlite.exec('BEGIN');
      adapter._sqlite
        .prepare("INSERT INTO sync_meta (key, value) VALUES ('k', 'v')")
        .run();

      let err: unknown = null;
      try {
        await adapter.withTransactionAsync(async () => {});
      } catch (e) {
        err = e;
      }

      expect(String(err)).toContain(
        'cannot start a transaction within a transaction'
      );
      expect(adapter._sqlite.inTransaction).toBe(false);
      expect(
        adapter._sqlite.prepare('SELECT COUNT(*) AS n FROM sync_meta').get()
      ).toEqual({ n: 0 });
    } finally {
      adapter._sqlite.close();
    }
  });
});

describe('makeSupabase().update()', () => {
  it('stamps updated_at on every matched row, mirroring the BEFORE UPDATE trigger', async () => {
    // Postgres bumps updated_at on ANY update, including one that only sets
    // deleted_at. That bump is the whole delivery mechanism for tombstones: it
    // is what puts the row above the next device's `updated_at > cursor`
    // cursor. A fake that left updated_at alone would let a broken client look
    // correct here and lose every delete in production.
    const store = makeStore();
    store.transactions = [
      remoteTxn({ id: 'T1', updated_at: '2026-05-01T00:00:00Z' }),
      remoteTxn({ id: 'T2', updated_at: '2026-05-01T00:00:00Z' }),
    ];
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { error } = await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'T1');

    expect(error).toBeNull();
    expect(store.transactions[0]).toMatchObject({
      deleted_at: TOMBSTONE,
      updated_at: SERVER_NOW,
    });
    // The unmatched row is untouched — no blanket restamp.
    expect(store.transactions[1].updated_at).toBe('2026-05-01T00:00:00Z');
    expect(store.transactions[1].deleted_at).toBeUndefined();
  });

  it('resolves without an error when it matches zero rows', async () => {
    // A tombstoning push must treat "matched nothing" as success: the row may
    // never have been pushed, may already be purged, or may already carry a
    // tombstone (the `.is('deleted_at', null)` filter). PostgREST answers 204
    // with no body, so `data` is null and `error` is null — if the fake
    // reported an error, push would never reach its local hard delete.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'nonexistent');

    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('does not re-stamp a row the .is(deleted_at, null) filter excludes', async () => {
    // The filter is what stops a retried or cascaded tombstone from bumping
    // updated_at again and re-broadcasting the same delete to every device.
    const store = makeStore();
    store.transactions = [
      remoteTxn({
        id: 'T1',
        updated_at: '2026-05-01T00:00:00Z',
        deleted_at: '2026-05-01T00:00:00Z',
      }),
    ];
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'T1')
      .is('deleted_at', null);

    expect(store.transactions[0].updated_at).toBe('2026-05-01T00:00:00Z');
  });

  it('errors on .select().single() with zero rows, the way PostgREST does', async () => {
    // Documents why the sync code must never chain .single() onto a tombstoning
    // update: a no-op match would surface as a failure and strand the delete.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'nonexistent')
      .select('id')
      .single();

    expect(data).toBeNull();
    expect(error?.code).toBe('PGRST116');
  });

  it('returns the matched rows, narrowed to the selected columns', async () => {
    const store = makeStore();
    store.transactions = [remoteTxn({ id: 'T1' }), remoteTxn({ id: 'T2' })];
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .in('id', ['T1', 'T2'])
      .select('id, deleted_at');

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: 'T1', deleted_at: TOMBSTONE },
      { id: 'T2', deleted_at: TOMBSTONE },
    ]);
  });

  it('reports a per-table write failure via failWritesOn', async () => {
    const store = makeStore();
    store.transactions = [remoteTxn({ id: 'T1' })];
    const sb = makeSupabase(store, {
      failWritesOn: new Set(['transactions']),
    });

    const { error } = await sb
      .from('transactions')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'T1');

    expect(error).toBeTruthy();
    expect(store.transactions[0].deleted_at).toBeUndefined();
  });
});

describe('makeSupabase().insert()', () => {
  // The split upload is the only INSERT the sync engine issues, and since #20
  // it reads `updated_at` back from it. Both halves of the server's behaviour
  // here decide whether a push test means anything.
  it('resolves the inserted rows through .select(), narrowed to the columns asked for', async () => {
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert([
        { id: 's1', transaction_id: 'T1', amount: -20, memo: 'Half' },
        { id: 's2', transaction_id: 'T1', amount: -10, memo: null },
      ])
      .select('id, updated_at');

    expect(error).toBeNull();
    // Narrowed: `amount` and `memo` were not asked for and must not come back,
    // or narrowing the client's select would be invisible here.
    expect(data).toEqual([
      { id: 's1', updated_at: SERVER_NOW },
      { id: 's2', updated_at: SERVER_NOW },
    ]);
    expect(store.transaction_splits).toHaveLength(2);
  });

  it('answers with no body when nothing is selected', async () => {
    // PostgREST returns 204 unless asked for a representation; the delete-path
    // callers rely on the error alone.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert({ id: 's1', transaction_id: 'T1', amount: -20, memo: null });

    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(store.transaction_splits).toHaveLength(1);
  });

  it('defaults a missing updated_at and re-renders one that is supplied', async () => {
    // `update_updated_at()` is a BEFORE UPDATE trigger, so an INSERT keeps the
    // client's value -- but PostgREST re-serializes timestamptz on the way
    // back, so '...Z' comes home as '...+00:00'. The client must adopt that
    // rendering rather than assume the string it sent survives. A row that
    // omits the column takes the `default now()` from
    // 006_split_updated_at.sql, which is how a pre-006 client's insert (and a
    // local split with no timestamp yet) stays valid.
    //
    // Two separate requests, deliberately: in one bulk insert the omitted key
    // would be null-filled rather than defaulted (see the mixed-keys test
    // below), which is exactly why push decides on the key set once per batch.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const omitted = await sb
      .from('transaction_splits')
      .insert([{ id: 's1', transaction_id: 'T1', amount: -20 }])
      .select('id, updated_at');
    const supplied = await sb
      .from('transaction_splits')
      .insert([
        {
          id: 's2',
          transaction_id: 'T1',
          amount: -10,
          updated_at: '2026-05-01T00:00:00Z',
        },
      ])
      .select('id, updated_at');

    expect(omitted.data).toEqual([{ id: 's1', updated_at: SERVER_NOW }]);
    expect(supplied.data).toEqual([
      { id: 's2', updated_at: '2026-05-01T00:00:00+00:00' },
    ]);
  });

  it('null-fills a key that only some objects of a bulk insert carry (23502)', async () => {
    // postgrest-js sends `?columns=` set to the UNION of the array's keys, and
    // PostgREST, given `columns`, does not insist that every object carry the
    // same keys (no PGRST102): it fills a listed key that a row omits with
    // NULL. So the row that omitted `updated_at` reaches Postgres with an
    // explicit null and the not-null column rejects the whole statement. 23502
    // is not a missing-column error, so nothing in push would report it -- the
    // parent transaction would simply stall 'pending' in silence. That is why
    // the `updated_at` key set is decided once per batch rather than per row.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert([
        { id: 's1', transaction_id: 'T1', amount: -20 },
        {
          id: 's2',
          transaction_id: 'T1',
          amount: -10,
          updated_at: '2026-05-01T00:00:00Z',
        },
      ])
      .select('id, updated_at');

    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '23502' });
    expect(store.transaction_splits).toEqual([]);
  });

  it('defaults a key that EVERY object of a bulk insert omits', async () => {
    // A column absent from the union is not in `?columns=` at all, so it takes
    // its default -- the shape push sends when any split in the batch has no
    // local timestamp.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert([
        { id: 's1', transaction_id: 'T1', amount: -20 },
        { id: 's2', transaction_id: 'T1', amount: -10 },
      ])
      .select('id, updated_at');

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: 's1', updated_at: SERVER_NOW },
      { id: 's2', updated_at: SERVER_NOW },
    ]);
  });

  it('defaults per row instead of null-filling under defaultToNull: false', async () => {
    // `Prefer: missing=default`: an omitted key takes the column default even
    // when a sibling carries it. Push does not use this option.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert(
        [
          { id: 's1', transaction_id: 'T1', amount: -20 },
          {
            id: 's2',
            transaction_id: 'T1',
            amount: -10,
            updated_at: '2026-05-01T00:00:00Z',
          },
        ],
        { defaultToNull: false }
      )
      .select('id, updated_at');

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: 's1', updated_at: SERVER_NOW },
      { id: 's2', updated_at: '2026-05-01T00:00:00+00:00' },
    ]);
  });

  it('rejects an explicit null updated_at the way a not-null column does', async () => {
    // The client must OMIT the key for a split whose local timestamp is NULL,
    // not send `updated_at: null`. A fake that accepted the null would hide a
    // push that fails with 23502 for every such row in production.
    const store = makeStore();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    const { error } = await sb
      .from('transaction_splits')
      .insert({ id: 's1', transaction_id: 'T1', amount: -20, updated_at: null })
      .select('id, updated_at');

    expect(error).toMatchObject({ code: '23502' });
    expect(store.transaction_splits).toEqual([]);
  });

  it('reports a write failure instead of storing the rows', async () => {
    const store = makeStore();
    const sb = makeSupabase(store, {
      failWritesOn: new Set(['transaction_splits']),
    });

    const { data, error } = await sb
      .from('transaction_splits')
      .insert({ id: 's1', transaction_id: 'T1', amount: -20 })
      .select('id, updated_at');

    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'network unreachable' });
    expect(store.transaction_splits).toEqual([]);
  });
});

describe('makeSupabase() .is(col, null)', () => {
  it('matches rows that omit the key entirely, not just explicit nulls', async () => {
    // Every fixture row predates deleted_at and simply leaves the key off, the
    // way a row written before the 005 migration looks. If `.is` compared with
    // `=== null`, a live-rows read would come back EMPTY and a pull test would
    // "pass" while asserting nothing.
    const store = makeStore();
    store.transactions = [
      remoteTxn({ id: 'LIVE' }), // no deleted_at key at all
      { ...remoteTxn({ id: 'EXPLICIT' }), deleted_at: null },
      remoteTxn({ id: 'DEAD', deleted_at: TOMBSTONE }),
    ];
    const sb = makeSupabase(store);

    const { data } = await sb
      .from('transactions')
      .select('id')
      .is('deleted_at', null);

    // The read builder hands back whole rows (it does not narrow on select),
    // so compare ids.
    expect(data?.map((r: any) => r.id)).toEqual(['LIVE', 'EXPLICIT']);
  });

  it('matches only tombstoned rows when given a non-null value', async () => {
    const store = makeStore();
    store.transactions = [
      remoteTxn({ id: 'LIVE' }),
      remoteTxn({ id: 'DEAD', deleted_at: TOMBSTONE }),
    ];
    const sb = makeSupabase(store);

    const { data } = await sb
      .from('transactions')
      .select('id')
      .eq('deleted_at', TOMBSTONE);

    expect(data?.map((r: any) => r.id)).toEqual(['DEAD']);
  });
});

describe('makeSupabase() maxRows', () => {
  it('truncates every response the way PostgREST does, .range() included', async () => {
    // PostgREST answers with min(requested, max_rows) rows and says nothing
    // about the clamp. That silence is the whole of #64, so the fake has to
    // reproduce it — otherwise no test can drive a second page at all, and a
    // read that stops on a short page looks like a read that saw everything.
    const store = makeStore();
    store.accounts = [1, 2, 3, 4, 5].map((n) => remoteAccount({ id: `a${n}` }));
    const sb = makeSupabase(store, { maxRows: 2 });

    const first = await sb
      .from('accounts')
      .select('id')
      .order('id')
      .range(0, 999);
    expect(first.data?.map((r: any) => r.id)).toEqual(['a1', 'a2']);

    // Advancing by rows RETURNED is the only thing that reaches a3.
    const second = await sb
      .from('accounts')
      .select('id')
      .order('id')
      .range(2, 1001);
    expect(second.data?.map((r: any) => r.id)).toEqual(['a3', 'a4']);

    // A bare await is clamped too, so a test can prove a read is unpaged.
    const unpaged = await sb.from('accounts').select('id');
    expect(unpaged.data?.map((r: any) => r.id)).toEqual(['a1', 'a2']);
  });

  it('leaves every response whole when it is not set', async () => {
    const store = makeStore();
    store.accounts = [1, 2, 3].map((n) => remoteAccount({ id: `a${n}` }));
    const sb = makeSupabase(store);

    const { data } = await sb.from('accounts').select('id');

    expect(data?.length).toBe(3);
  });
});

describe('makeSupabase() account tombstone cascade', () => {
  function storeWithChildren(): Store {
    const store = makeStore();
    store.accounts = [remoteAccount({ id: 'a1' })];
    store.transactions = [
      remoteTxn({ id: 'T1', account_id: 'a1' }),
      remoteTxn({
        id: 'T2',
        account_id: 'a1',
        deleted_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      }),
      remoteTxn({ id: 'T3', account_id: 'other' }),
    ];
    store.recurring_rules = [remoteRule({ id: 'R1', account_id: 'a1' })];
    return store;
  }

  it('stamps live children when enabled (the accounts_tombstone_children trigger)', async () => {
    const store = storeWithChildren();
    const sb = makeSupabase(store, { serverNow: SERVER_NOW });

    await sb
      .from('accounts')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'a1')
      .is('deleted_at', null);

    const txn = (id: string) => store.transactions.find((r) => r.id === id);
    // Live child: tombstoned AND bumped, so other devices pull it incrementally.
    expect(txn('T1')).toMatchObject({
      deleted_at: TOMBSTONE,
      updated_at: SERVER_NOW,
    });
    // Already-tombstoned child: left alone (`and deleted_at is null` in the
    // trigger), so it is not re-broadcast to every device.
    expect(txn('T2')).toMatchObject({
      deleted_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    // Another account's child is untouched.
    expect(txn('T3')?.deleted_at).toBeUndefined();
    expect(store.recurring_rules[0]).toMatchObject({
      deleted_at: TOMBSTONE,
      updated_at: SERVER_NOW,
    });
  });

  it('leaves children alone when disabled, so a test can prove the client does not rely on the trigger', async () => {
    const store = storeWithChildren();
    const sb = makeSupabase(store, {
      serverNow: SERVER_NOW,
      cascadeTombstones: false,
    });

    await sb.from('accounts').update({ deleted_at: TOMBSTONE }).eq('id', 'a1');

    expect(store.accounts[0].deleted_at).toBe(TOMBSTONE);
    expect(store.transactions.find((r) => r.id === 'T1')?.deleted_at).toBe(
      undefined
    );
    expect(store.recurring_rules[0].deleted_at).toBeUndefined();
  });
});

// #95: a client with no session signs its requests with the anon key, and RLS
// answers them without an error object on anything but an insert. The sync
// tests that take the session away (syncSession.test.ts) lean on each of these
// answers, so each is pinned here.
describe('makeSupabase() anonScoped', () => {
  function seeded(): Store {
    const store = makeStore();
    store.accounts = [remoteAccount({ id: 'a1' })];
    store.transactions = [remoteTxn({ id: 'T1' })];
    store.transaction_splits = [
      { id: 's1', transaction_id: 'T1', amount: 1, memo: null },
    ];
    return store;
  }

  it('reads nothing, cleanly, through .range() and through a bare await', async () => {
    const sb = makeSupabase(seeded(), { anonScoped: true });

    const paged = await sb
      .from('accounts')
      .select('*')
      .eq('user_id', 'u')
      .order('id')
      .range(0, 999);
    const bare = await sb.from('transactions').select('id');

    expect(paged).toEqual({ data: [], error: null });
    expect(bare).toEqual({ data: [], error: null });
  });

  it('refuses an upsert and an insert with 42501, and stores nothing', async () => {
    const store = seeded();
    const sb = makeSupabase(store, { anonScoped: true });

    // An edit of a row the server has: the merge path must not run either.
    const upserted = await sb
      .from('accounts')
      .upsert({ ...remoteAccount({ id: 'a1' }), name: 'Renamed' })
      .select('id, updated_at, deleted_at')
      .single();
    const inserted = await sb
      .from('transaction_splits')
      .insert([{ id: 's2', transaction_id: 'T1', amount: 2, memo: null }])
      .select('id, updated_at');

    expect(upserted).toEqual({
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "accounts"',
      },
    });
    expect(inserted).toEqual({
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "transaction_splits"',
      },
    });
    expect(store.accounts).toEqual([remoteAccount({ id: 'a1' })]);
    expect(store.transaction_splits.map((s) => s.id)).toEqual(['s1']);
  });

  it('matches nothing with an UPDATE: no stamp, no cascade, no error', async () => {
    // Zero matched rows is what the push reads as "the server agrees it is
    // gone" — which is why a push with no session must not run at all.
    const store = seeded();
    const before = JSON.parse(JSON.stringify(store));
    const sb = makeSupabase(store, { anonScoped: true, serverNow: SERVER_NOW });

    const res = await sb
      .from('accounts')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'a1')
      .is('deleted_at', null);

    expect(res).toEqual({ data: null, error: null });
    expect(store).toEqual(before);
  });

  it('removes nothing with a DELETE, and reports no error', async () => {
    const store = seeded();
    const sb = makeSupabase(store, { anonScoped: true });

    const res = await sb
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', 'T1');

    expect(res).toEqual({ data: null, error: null });
    expect(store.transaction_splits.map((s) => s.id)).toEqual(['s1']);
  });

  it('has no session to hand out, and says why', async () => {
    const sb = makeSupabase(makeStore(), { anonScoped: true });

    const { data, error } = await sb.auth.getSession();

    expect(data.session).toBeNull();
    expect(error?.name).toBe('AuthRetryableFetchError');
  });

  it('hands out FAKE_SESSION when signed in, which is the default', async () => {
    const sb = makeSupabase(makeStore());

    expect(await sb.auth.getSession()).toEqual({
      data: { session: FAKE_SESSION },
      error: null,
    });
    // The suites' own user, whom every row builder defaults to: the engine
    // compares the two since #111.
    expect(FAKE_SESSION.user.id).toBe('u');
  });

  it('reads the option on every request, so a test can take the session away between two pages', async () => {
    const store = makeStore();
    store.accounts = [1, 2].map((n) => remoteAccount({ id: `a${n}` }));
    const opts: SupabaseOpts = { maxRows: 1 };
    const sb = makeSupabase(store, opts);

    const first = await sb
      .from('accounts')
      .select('id')
      .order('id')
      .range(0, 999);
    opts.anonScoped = true;
    const second = await sb
      .from('accounts')
      .select('id')
      .order('id')
      .range(1, 1000);
    const session = await sb.auth.getSession();

    expect(first.data?.map((r: any) => r.id)).toEqual(['a1']);
    expect(second).toEqual({ data: [], error: null });
    expect(session.data.session).toBeNull();
  });
});

describe('makeSupabase() sessionUserId (#111)', () => {
  // Another user's session: RLS answers every request the way the anon key's
  // does, as far as that user's rows go, and a test switches users mid-sync by
  // changing the option.
  function seeded(): Store {
    const store = makeStore();
    store.accounts = [
      remoteAccount({ id: 'a1' }),
      remoteAccount({ id: 'b1', user_id: 'b' }),
    ];
    store.transactions = [remoteTxn({ id: 'T1' })];
    store.transaction_splits = [
      { id: 's1', transaction_id: 'T1', amount: 1, memo: null },
    ];
    return store;
  }

  it("hands out the session of the user it was installed with, 'u' when none is named", async () => {
    const u = await makeSupabase(makeStore()).auth.getSession();
    const b = await makeSupabase(makeStore(), {
      sessionUserId: 'b',
    }).auth.getSession();

    expect(u).toEqual({ data: { session: fakeSession('u') }, error: null });
    expect(b).toEqual({ data: { session: fakeSession('b') }, error: null });
    expect(b.data.session?.user.id).toBe('b');
  });

  it('reads the option on every request, so a test can switch users between two', async () => {
    const opts: SupabaseOpts = {};
    const sb = makeSupabase(seeded(), opts);

    const before = await sb.from('accounts').select('id').order('id');
    const sessionBefore = await sb.auth.getSession();
    opts.sessionUserId = 'b';
    const after = await sb.from('accounts').select('id').order('id');
    const sessionAfter = await sb.auth.getSession();

    expect(before.data?.map((r: any) => r.id)).toEqual(['a1']);
    expect(sessionBefore.data.session?.user.id).toBe('u');
    expect(after.data?.map((r: any) => r.id)).toEqual(['b1']);
    expect(sessionAfter.data.session?.user.id).toBe('b');
  });

  it("reads leave out another user's rows, a split under their parent included, cleanly", async () => {
    const store = seeded();
    // A split whose parent the store does not hold: no user to scope it by.
    store.transaction_splits.push({
      id: 's9',
      transaction_id: 'T9',
      amount: 9,
      memo: null,
    });
    const sb = makeSupabase(store, { sessionUserId: 'b' });

    const paged = await sb
      .from('accounts')
      .select('*')
      .eq('user_id', 'u')
      .order('id')
      .range(0, 999);
    const bare = await sb.from('transactions').select('id');
    const splits = await sb
      .from('transaction_splits')
      .select('id')
      .order('id')
      .range(0, 999);

    expect(paged).toEqual({ data: [], error: null });
    expect(bare).toEqual({ data: [], error: null });
    // s1 rides u's T1, which 001's split policy checks; s9 reads as every
    // orphan split in the suites always has.
    expect(splits.error).toBeNull();
    expect(splits.data?.map((r: any) => r.id)).toEqual(['s9']);
  });

  it("matches none of another user's rows with an UPDATE or a DELETE: no stamp, no cascade, no error", async () => {
    // Zero matched rows is the push's success case — for a tombstone, and for
    // the split DELETE of a parent whose splits were all removed — which is
    // why a push under another user's session must not send either.
    const store = seeded();
    const before = JSON.parse(JSON.stringify(store));
    const sb = makeSupabase(store, {
      sessionUserId: 'b',
      serverNow: SERVER_NOW,
    });

    const updated = await sb
      .from('accounts')
      .update({ deleted_at: TOMBSTONE })
      .eq('id', 'a1')
      .is('deleted_at', null);
    const deleted = await sb.from('transactions').delete().eq('id', 'T1');
    const splitsDeleted = await sb
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', 'T1');

    expect(updated).toEqual({ data: null, error: null });
    expect(deleted).toEqual({ data: null, error: null });
    expect(splitsDeleted).toEqual({ data: null, error: null });
    expect(store).toEqual(before);
  });

  it("refuses an upsert or an insert that carries another user's user_id, and a split under their parent, with 42501", async () => {
    const store = seeded();
    const sb = makeSupabase(store, { sessionUserId: 'b' });

    // An edit of a's row, and a new one for a: both fail the WITH CHECK.
    const edit = await sb
      .from('accounts')
      .upsert({ ...remoteAccount({ id: 'a1' }), name: 'Renamed' })
      .select('id, updated_at, deleted_at')
      .single();
    const fresh = await sb
      .from('accounts')
      .upsert([
        remoteAccount({ id: 'a2' }),
        remoteAccount({ id: 'b2', user_id: 'b' }),
      ])
      .select('id');
    const split = await sb
      .from('transaction_splits')
      .insert([{ id: 's2', transaction_id: 'T1', amount: 2, memo: null }])
      .select('id, updated_at');
    // b's own rows are b's to write, and a split whose parent the store does
    // not hold passes as it always has (the foreign key is not modelled).
    const own = await sb
      .from('accounts')
      .upsert({ ...remoteAccount({ id: 'b1', user_id: 'b' }), name: 'Mine' })
      .select('id')
      .single();
    const orphan = await sb
      .from('transaction_splits')
      .insert({ id: 's3', transaction_id: 'T9', amount: 3, memo: null });

    const denied = (table: string) => ({
      code: '42501',
      message: `new row violates row-level security policy for table "${table}"`,
    });
    expect(edit).toEqual({ data: null, error: denied('accounts') });
    expect(fresh).toEqual({ data: null, error: denied('accounts') });
    expect(split).toEqual({ data: null, error: denied('transaction_splits') });
    expect(own).toEqual({ data: { id: 'b1' }, error: null });
    expect(orphan).toEqual({ data: null, error: null });
    expect(store.accounts.map((a) => [a.id, a.name])).toEqual([
      ['a1', 'Checking'],
      ['b1', 'Mine'],
    ]);
    expect(store.transaction_splits.map((s) => s.id)).toEqual(['s1', 's3']);
  });
});

describe('makeSupabase() purgedIds and writeError (#98)', () => {
  it('refuses a purged id with a hinted 23503 before any conflict check, and stores nothing', async () => {
    // reject_purged_id() (008) is a BEFORE INSERT trigger, so it sees the
    // proposed row before ON CONFLICT looks for an existing one: it refuses a
    // recorded id whether or not a row with that id is there, and one refused
    // row fails the whole statement. The hint is the half the client keys on
    // -- a hint-less 23503 is a row the server never held, and dropping one of
    // those destroys what the user typed. The hook fires for the refusal,
    // because the client acts on it, so a mid-flight edit can race it.
    const existing = remoteTxn({
      id: 'T1',
      updated_at: '2026-05-01T00:00:00Z',
    });
    const store = makeStore();
    // A copy, so an in-place write to the stored row could not also change
    // what it is compared against below.
    store.transactions = [{ ...existing }];
    const hooked: string[] = [];
    const sb = makeSupabase(store, {
      serverNow: SERVER_NOW,
      purgedIds: new Set(['T1']),
      onAfterUpsert: async (table) => {
        hooked.push(table);
      },
    });

    const one = await sb
      .from('transactions')
      .upsert(remoteTxn({ id: 'T1', payee: 'Edited' }), { onConflict: 'id' })
      .select('id, updated_at, deleted_at')
      .single();
    const batch = await sb
      .from('transactions')
      .upsert([remoteTxn({ id: 'T2' }), remoteTxn({ id: 'T1' })], {
        onConflict: 'id',
      })
      .select('id');

    expect(one.data).toBeNull();
    expect(one.error).toEqual({
      code: '23503',
      message: 'transactions T1 was deleted and its tombstone has been purged',
      details: null,
      hint: 'purged',
    });
    expect(batch.data).toBeNull();
    expect(batch.error).toMatchObject({ code: '23503', hint: 'purged' });
    // The existing row is untouched, and T2 did not go in with the batch.
    expect(store.transactions).toEqual([existing]);
    expect(hooked).toEqual(['transactions', 'transactions']);
  });

  it('reports writeError instead of the network failure, and an ordinary refusal does not fire the hook', async () => {
    // A test needs the server's other 23503 shapes to prove the client tells
    // them apart from 008's. The client leaves such a row alone, so there is
    // no mid-flight race to drive, and the hook stays quiet as before.
    // `offline` is the network whatever writeError says.
    const refusal = {
      code: '23503',
      message: 'account a1 is deleted',
      details: null,
      hint: null,
    };
    const store = makeStore();
    const hooked: string[] = [];
    const sb = makeSupabase(store, {
      failWritesOn: new Set(['transactions']),
      writeError: refusal,
      onAfterUpsert: async (table) => {
        hooked.push(table);
      },
    });

    const { data, error } = await sb
      .from('transactions')
      .upsert(remoteTxn({ id: 'T1' }), { onConflict: 'id' })
      .select('id')
      .single();
    const offline = await makeSupabase(store, {
      offline: true,
      writeError: refusal,
    })
      .from('transactions')
      .upsert(remoteTxn({ id: 'T1' }), { onConflict: 'id' });

    expect(data).toBeNull();
    expect(error).toBe(refusal);
    expect(offline.error).toEqual({ message: 'network unreachable' });
    expect(store.transactions).toEqual([]);
    expect(hooked).toEqual([]);
  });

  it('refuses a purged id ahead of the anon 42501, in the order Postgres runs them', async () => {
    // BEFORE ROW INSERT triggers run ahead of the RLS WITH CHECK (ExecInsert),
    // so an anon-signed upsert of a purged id is refused as purged, and only a
    // fresh id meets the 42501 (checked against 008 in PGlite). The client
    // drops the first, which is right whoever asks: the id was purged.
    const store = makeStore();
    const sb = makeSupabase(store, {
      anonScoped: true,
      purgedIds: new Set(['A3']),
    });

    const purged = await sb
      .from('accounts')
      .upsert(remoteAccount({ id: 'A3' }), { onConflict: 'id' })
      .select('id')
      .single();
    const fresh = await sb
      .from('accounts')
      .upsert(remoteAccount({ id: 'A4' }), { onConflict: 'id' })
      .select('id')
      .single();

    expect(purged.error).toMatchObject({ code: '23503', hint: 'purged' });
    expect(fresh.error).toMatchObject({ code: '42501' });
    expect(store.accounts).toEqual([]);
  });
});

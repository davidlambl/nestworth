// A run of the receipt sweep (#176), scripts/receipt-sweep/sweep.js, against
// the fixture's fake Storage and PostgREST signed as the service role: RLS
// bypassed, `storage.search`'s listing, `count: 'exact'`, and only the columns
// select() named.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  makeSupabase,
  type Objects,
  type Store,
  type SupabaseOpts,
} from '../testing/syncFixture';
import { sweepReceipts } from '../../scripts/receipt-sweep/sweep';

const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const pgDaysAgo = (n: number) => daysAgo(n).replace('Z', '+00:00');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const txnId = (n: number) => id('aaaaaaaa', n);
const uploadId = (n: number) => id('bbbbbbbb', n);
/** A key of this user's: `<user>/<transaction>.<upload>.jpg`. */
const keyOf = (txn: string, upload: string | null, user = USER) =>
  `${user}/${txn}.${upload ? `${upload}.` : ''}jpg`;

let store: Store;
let objects: Objects;

beforeEach(() => {
  store = { transactions: [], purged_ids: [] };
  objects = new Map();
});

/** A photo in the bucket, its bytes written `written` days ago. */
function photo(key: string, written: number) {
  objects.set(`receipts/${key}`, {
    contentType: 'image/jpeg',
    body: 'bytes',
    created_at: daysAgo(written),
    updated_at: daysAgo(written),
    size: 1000,
  });
}

/** A transaction on the server, last changed `changed` days ago. */
function txn(
  idValue: string,
  receipt: string | null,
  changed: number,
  over: Record<string, unknown> = {}
) {
  store.transactions.push({
    id: idValue,
    user_id: USER,
    account_id: 'a1',
    receipt_path: receipt,
    memo: 'not selected by the sweep',
    updated_at: pgDaysAgo(changed),
    deleted_at: null,
    ...over,
  });
}

const inBucket = (key: string) => objects.has(`receipts/${key}`);
const client = (opts: SupabaseOpts = {}) =>
  makeSupabase(
    store,
    { serviceRole: true, projectReads: true, ...opts },
    objects
  ) as any;
const sweep = (
  mode: 'dry-run' | 'apply',
  opts: SupabaseOpts = {},
  extra: Record<string, unknown> = {},
  c: any = client(opts)
) => sweepReceipts(c, { mode, now: NOW, ...extra });

/** Every photo the state table names, each with what the sweep must do. */
function seedStateTable() {
  const k = {
    named: keyOf(txnId(1), uploadId(1)),
    namedDeleted: keyOf(txnId(2), uploadId(2)),
    young: keyOf(txnId(3), uploadId(3)),
    recent: keyOf(txnId(4), null),
    replaced: keyOf(txnId(5), null),
    purged: keyOf(txnId(6), uploadId(6)),
    missing: keyOf(txnId(7), uploadId(7)),
    unknown: `${USER}/scan.jpg`,
    foreign: keyOf(txnId(9), uploadId(9)),
    deletedEarlier: keyOf(txnId(2), null),
  };
  // Named by a live transaction, the photo 400 days old.
  photo(k.named, 400);
  txn(txnId(1), k.named, 400);
  // Named only by a deleted transaction (until the purge reclaims the row).
  photo(k.namedDeleted, 400);
  txn(txnId(2), k.namedDeleted, 45, { deleted_at: pgDaysAgo(45) });
  // The same deleted transaction's earlier photo, replaced before the delete.
  photo(k.deletedEarlier, 400);
  // An upload 10 days ago whose attach never reached the server.
  photo(k.young, 10);
  txn(txnId(3), null, 300);
  // Replaced 5 days ago: another device's stale edit can still name it.
  photo(k.recent, 400);
  txn(txnId(4), keyOf(txnId(4), uploadId(4)), 5);
  photo(keyOf(txnId(4), uploadId(4)), 5);
  // Replaced 40 days ago.
  photo(k.replaced, 400);
  txn(txnId(5), keyOf(txnId(5), uploadId(5)), 40);
  photo(keyOf(txnId(5), uploadId(5)), 40);
  // Its transaction purged (008 recorded the id).
  photo(k.purged, 400);
  store.purged_ids.push({
    table_name: 'transactions',
    id: txnId(6),
    purged_at: pgDaysAgo(3),
  });
  // Its transaction never reached the server.
  photo(k.missing, 400);
  // A name the app never makes.
  photo(k.unknown, 400);
  // Its transaction is another user's.
  photo(k.foreign, 400);
  txn(txnId(9), null, 400, { user_id: OTHER });
  return k;
}

describe('the sweep, against the fake Storage and PostgREST as the service role (#176)', () => {
  it('removes exactly the photos nothing names, written and unchanged for 30 days, and keeps every other state', async () => {
    const k = seedStateTable();

    const report = await sweep('apply');

    expect(report.stopped).toBeNull();
    for (const kept of [
      k.named,
      k.namedDeleted,
      k.young,
      k.recent,
      k.unknown,
      k.foreign,
      keyOf(txnId(4), uploadId(4)),
      keyOf(txnId(5), uploadId(5)),
    ]) {
      expect([kept, inBucket(kept)]).toEqual([kept, true]);
    }
    for (const removed of [k.replaced, k.purged, k.missing, k.deletedEarlier]) {
      expect([removed, inBucket(removed)]).toEqual([removed, false]);
    }
    expect(report.states).toEqual({
      named: 3,
      'named-deleted': 1,
      young: 1,
      'transaction-recent': 1,
      'unknown-key': 1,
      'transaction-foreign': 1,
      orphan: 4,
    });
    expect(
      report.records.map((r: any) => [r.key, r.result, r.transaction])
    ).toEqual([
      // All 400 days old: in key order.
      [k.deletedEarlier, 'removed', 'deleted'],
      [k.replaced, 'removed', 'live'],
      [k.purged, 'removed', 'purged'],
      [k.missing, 'removed', 'missing'],
    ]);
    expect(report.anomalies.map((a: any) => a.state).sort()).toEqual([
      'transaction-foreign',
      'unknown-key',
    ]);
    expect(report.listed).toBe(12);
    expect(report.folders).toBe(1);
  });

  it('a dry run removes nothing, and reports what an apply run would remove', async () => {
    const k = seedStateTable();
    const before = [...objects.keys()].sort();
    const requests: string[] = [];

    const report = await sweep('dry-run', {
      onStorageRequest: (op) => {
        requests.push(op);
      },
    });

    expect([...objects.keys()].sort()).toEqual(before);
    expect(requests).not.toContain('remove');
    expect(report.records.map((r: any) => [r.key, r.result])).toEqual([
      [k.deletedEarlier, 'would-remove'],
      [k.replaced, 'would-remove'],
      [k.purged, 'would-remove'],
      [k.missing, 'would-remove'],
    ]);
  });

  it('keeps a photo its transaction names again after the names were read: the second look', async () => {
    const k = { photo: keyOf(txnId(1), null) };
    photo(k.photo, 400);
    txn(txnId(1), keyOf(txnId(1), uploadId(1)), 40);
    const c = client();
    const from = c.from;
    c.from = (table: string) => {
      const builder = from(table);
      const select = builder.select;
      builder.select = (cols?: string, options?: any) => {
        // The transactions read by id (the only read asking for user_id):
        // a stale device's push lands just before it.
        if (table === 'transactions' && cols?.includes('user_id')) {
          store.transactions[0].receipt_path = k.photo;
          store.transactions[0].updated_at = pgDaysAgo(0);
        }
        return select(cols, options);
      };
      return builder;
    };

    const report = await sweep('apply', {}, {}, c);

    expect(inBucket(k.photo)).toBe(true);
    expect(report.states).toEqual({ renamed: 1 });
    expect(report.records).toEqual([]);
  });

  it('keeps a photo named again between the transactions read and its removal: the last look', async () => {
    const k = { photo: keyOf(txnId(1), null) };
    photo(k.photo, 400);
    txn(txnId(1), keyOf(txnId(1), uploadId(1)), 40);
    const c = client();
    const from = c.from;
    c.from = (table: string) => {
      const builder = from(table);
      const inFilter = builder.in;
      builder.in = (col: string, vals: any[]) => {
        // The last look (the only read filtering on receipt_path): the push
        // lands just before it.
        if (table === 'transactions' && col === 'receipt_path') {
          store.transactions[0].receipt_path = k.photo;
        }
        return inFilter(col, vals);
      };
      return builder;
    };

    const report = await sweep('apply', {}, {}, c);

    expect(inBucket(k.photo)).toBe(true);
    expect(report.records.map((r: any) => r.result)).toEqual(['renamed']);
  });

  it('keeps a photo a deleted transaction names at the last look, as the names read would', async () => {
    const k = { photo: keyOf(txnId(1), null) };
    photo(k.photo, 400);
    txn(txnId(1), keyOf(txnId(1), uploadId(1)), 40, {
      deleted_at: pgDaysAgo(40),
    });
    const c = client();
    const from = c.from;
    c.from = (table: string) => {
      const builder = from(table);
      const inFilter = builder.in;
      builder.in = (col: string, vals: any[]) => {
        // A stale device's push lands on the tombstone just before the last
        // look: the deleted row names the photo again.
        if (table === 'transactions' && col === 'receipt_path') {
          store.transactions[0].receipt_path = k.photo;
        }
        return inFilter(col, vals);
      };
      return builder;
    };

    const report = await sweep('apply', {}, {}, c);

    expect(inBucket(k.photo)).toBe(true);
    expect(report.records.map((r: any) => r.result)).toEqual(['renamed']);
  });

  it('reads every page: a page cut short by the server does not end the names read, and a folder longer than a listing page is listed whole', async () => {
    // 1,203 photos in one folder (two listing pages), every one named by its
    // transaction; the server answers at most 7 rows a request.
    for (let n = 1; n <= 1203; n += 1) {
      const key = keyOf(txnId(n), uploadId(n));
      photo(key, 400);
      txn(txnId(n), key, 400);
    }
    const orphan = keyOf(txnId(5000), null);
    photo(orphan, 400);
    txn(txnId(5000), keyOf(txnId(5000), uploadId(5000)), 40);

    const report = await sweep('apply', { maxRows: 7 });

    expect(report.stopped).toBeNull();
    expect(report.listed).toBe(1204);
    expect(report.states).toEqual({ named: 1203, orphan: 1 });
    expect(report.records.map((r: any) => [r.key, r.result])).toEqual([
      [orphan, 'removed'],
    ]);
    expect(objects.size).toBe(1203);
  });

  it('reads the names in id order, which its pages of ids rely on: a server answering in its own order would hide the names past the first page', async () => {
    // Ids are random, so the server's own order (the heap's) is not id
    // order; the fake answers a read without .order() in the order the
    // rows were stored, so these are stored in a scrambled order. Every
    // photo is named by its transaction, and the server answers at most 7
    // rows a request.
    for (let i = 0; i < 30; i += 1) {
      const n = ((i * 7) % 30) + 1;
      const key = keyOf(txnId(n), uploadId(n));
      photo(key, 400);
      txn(txnId(n), key, 400);
    }

    const report = await sweep('apply', { maxRows: 7 });

    expect(report.states).toEqual({ named: 30 });
    expect(report.stopped).toBeNull();
    expect(report.records).toEqual([]);
    expect(objects.size).toBe(30);
  });

  it('stops before removing anything when a read fails', async () => {
    seedStateTable();
    const before = objects.size;

    const report = await sweep('apply', {
      errorReadsOn: new Set(['transactions']),
    });

    expect(report.stopped).toMatch(
      /^reading the transactions that name a receipt failed: /
    );
    expect(objects.size).toBe(before);
    expect(report.records).toEqual([]);
  });

  it('stops before listing anything when purged_ids cannot be read, and says a read that got no answer is not a refusal of the key', async () => {
    seedStateTable();
    const requests: string[] = [];

    const report = await sweep('apply', {
      errorReadsOn: new Set(['purged_ids']),
      onStorageRequest: (op) => {
        requests.push(op);
      },
    });

    expect(report.stopped).toBe(
      'reading purged_ids got no answer (a network error), so the key was not checked: network unreachable'
    );
    expect(report.listed).toBeNull();
    expect(requests).toEqual([]);
  });

  it("stops before listing anything under a user's session or the anon key, which cannot read purged_ids (008)", async () => {
    seedStateTable();
    for (const opts of [
      { serviceRole: false, sessionUserId: USER },
      { serviceRole: false, anonScoped: true },
    ]) {
      const requests: string[] = [];
      const report = await sweep('apply', {
        ...opts,
        onStorageRequest: (op) => {
          requests.push(op);
        },
      });
      expect(report.stopped).toBe(
        'the key cannot read purged_ids, which only a secret (service role) key can: permission denied for table purged_ids (42501)'
      );
      expect(requests).toEqual([]);
    }
  });

  it('stops when the server answers fewer transactions than it matched, so a missing row never reads as a purged one', async () => {
    photo(keyOf(txnId(1), null), 400);
    txn(txnId(1), null, 400);
    photo(keyOf(txnId(2), null), 400);
    txn(txnId(2), null, 400);
    const before = objects.size;

    const report = await sweep('apply', { maxRows: 1 });

    expect(report.stopped).toBe(
      'reading the transactions of unnamed receipts came back short (1 of 2 rows)'
    );
    expect(objects.size).toBe(before);
  });

  it('removes at most the run limit, the oldest first, and leaves the rest for the next run', async () => {
    for (let n = 1; n <= 7; n += 1) {
      photo(keyOf(txnId(n), null), 100 + n);
    }

    const report = await sweep('apply', {}, { maxRemovals: 5 });

    expect(report.deferred).toBe(2);
    expect(report.records.map((r: any) => [r.key, r.result])).toEqual(
      [7, 6, 5, 4, 3].map((n) => [keyOf(txnId(n), null), 'removed'])
    );
    expect(inBucket(keyOf(txnId(1), null))).toBe(true);
    expect(inBucket(keyOf(txnId(2), null))).toBe(true);
  });

  it('counts a photo removed meanwhile (in the app, or by another run) as already gone, not as a failure', async () => {
    const gone = keyOf(txnId(1), null);
    const stays = keyOf(txnId(2), null);
    photo(gone, 400);
    photo(stays, 400);

    const report = await sweep('apply', {
      onStorageRequest: (op) => {
        if (op === 'remove') objects.delete(`receipts/${gone}`);
      },
    });

    expect(report.stopped).toBeNull();
    expect(report.records.map((r: any) => [r.key, r.result])).toEqual([
      [gone, 'already-gone'],
      [stays, 'removed'],
    ]);
  });

  it('stops where a removal fails; the batches before it stay removed', async () => {
    for (let n = 1; n <= 150; n += 1) {
      photo(keyOf(txnId(n), null), 400);
    }
    const c = client();
    const storageFrom = c.storage.from;
    let removals = 0;
    c.storage.from = (bucket: string) => {
      const api = storageFrom(bucket);
      const remove = api.remove;
      api.remove = async (paths: string[]) => {
        removals += 1;
        if (removals === 2) {
          return {
            data: null,
            error: { message: 'Internal Server Error', statusCode: '500' },
          };
        }
        return remove(paths);
      };
      return api;
    };

    const report = await sweep('apply', {}, {}, c);

    expect(report.stopped).toBe(
      'removing 50 photo(s) failed: Internal Server Error (500)'
    );
    expect(
      report.records.filter((r: any) => r.result === 'removed')
    ).toHaveLength(100);
    expect(objects.size).toBe(50);
  });

  it('never removes a folder inside a user folder, a file at the root, or anything of another bucket', async () => {
    photo(`${USER}/sub/${txnId(1)}.jpg`, 400);
    objects.set(`receipts/${txnId(2)}.jpg`, {
      contentType: 'image/jpeg',
      body: 'x',
      created_at: daysAgo(400),
      updated_at: daysAgo(400),
    });
    objects.set(`avatars/${keyOf(txnId(3), null)}`, {
      contentType: 'image/jpeg',
      body: 'x',
      created_at: daysAgo(400),
      updated_at: daysAgo(400),
    });

    const report = await sweep('apply');

    expect(objects.size).toBe(3);
    expect(report.nestedFolders).toBe(1);
    expect(report.states).toEqual({ 'unknown-key': 1 });
    expect(report.records).toEqual([]);
  });

  it("lists every user's folder", async () => {
    photo(keyOf(txnId(1), null, USER), 400);
    photo(keyOf(txnId(2), null, OTHER), 400);
    txn(txnId(2), null, 400, { user_id: OTHER });

    const report = await sweep('apply');

    expect(report.folders).toBe(2);
    expect(report.records.map((r: any) => r.result)).toEqual([
      'removed',
      'removed',
    ]);
    expect(objects.size).toBe(0);
  });

  it('refuses a mode that is neither dry-run nor apply', async () => {
    await expect(
      sweepReceipts(client(), { mode: 'remove' as any, now: NOW })
    ).rejects.toThrow("The sweep's mode is dry-run or apply, not remove.");
  });
});

// useRemoveReceipt (#23): a receipt is removed from Storage first, then from
// its transaction, whose receipt_path the push uploads as null. A removal
// that fails changes nothing and says so in its own words, which the mutation
// cache renders as "Save failed: …" and the screen shows inline (Alert.alert
// does nothing on web or in Electron); it never clears a transaction while
// the photo stays in the bucket. A photo already gone is no failure: the
// transaction is cleared all the same, which is how a dangling receipt (a
// transaction the reset's re-download brought back naming a photo removed
// meanwhile) is healed.
//
// The Storage bucket is the fixture's fake (lib/testing/syncFixture.ts),
// which answers as storage-js does: a removal of nothing answers [] with no
// error; offline, a StorageUnknownError. The seeded row is synced, as one is
// once the attach that named the receipt has been pushed.
//
// This hook is new with #23, so this suite cannot load on the code before
// it. Each test was proven red under the mutant named in its title. The
// harness is useUpdateAccount.test.ts's: react-test-renderer and
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

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { requestPush } from '../sync';
import { useRemoveReceipt } from '../hooks/useRemoveReceipt';
import { RECEIPT_REMOVED_BUT_GONE } from '../receiptRemove';
import { forgetReceiptUrls, receiptUrl } from '../receiptStorage';
import {
  insertLocalTxn,
  wireSyncMocks,
  type SupabaseOpts,
} from '../testing/syncFixture';

/** When t1 last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When a delete on this device marked it, while the removal was out. */
const DELETED_AT = '2026-10-15T08:00:00.000Z';
const PATH = 'u/t1.n1.jpg';
const OBJECT = `receipts/${PATH}`;

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let removeReceipt: ReturnType<typeof useRemoveReceipt>;
let invalidate: jest.SpyInstance;
let warn: jest.SpyInstance;

function Harness() {
  const mutation = useRemoveReceipt();
  useEffect(() => {
    removeReceipt = mutation;
  });
  return null;
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  forgetReceiptUrls();
  (requestPush as unknown as jest.Mock).mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await insertLocalTxn(ctx.adapter, {
    id: 't1',
    receipt_path: PATH,
    updated_at: SYNCED_AT,
  });
  ctx.objects.set(OBJECT, { contentType: 'image/jpeg', body: 'JPEG' });

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
  onlineManager.setOnline(true);
  warn.mockRestore();
  ctx.adapter._sqlite.close();
});

type Row = { _sync_status: string | null; receipt_path: string | null };

/** t1's status and receipt, and its stamp's age; undefined once it is gone. */
function t1(): (Row & { restamped: boolean }) | undefined {
  const row = ctx.adapter._sqlite
    .prepare(
      "SELECT _sync_status, receipt_path, updated_at FROM transactions WHERE id = 't1'"
    )
    .get() as (Row & { updated_at: string }) | undefined;
  return row
    ? {
        _sync_status: row._sync_status,
        receipt_path: row.receipt_path,
        restamped: row.updated_at > SYNCED_AT && row.updated_at !== DELETED_AT,
      }
    : undefined;
}

const unchanged = {
  _sync_status: 'synced',
  receipt_path: PATH,
  restamped: false,
};

/** The outcome as a string: never rejects.toThrow() next to better-sqlite3. */
async function removeThrough(path = PATH): Promise<string> {
  let outcome = '';
  await act(async () => {
    try {
      outcome = `resolved ${String(
        await removeReceipt.mutateAsync({ transactionId: 't1', path })
      )}`;
    } catch (e) {
      outcome = String(e);
    }
  });
  return outcome;
}

/** Re-installs the fake with `opts`, over the same store and bucket. */
function serverAnswers(opts: SupabaseOpts) {
  ctx.installSupabase(opts);
}

/** Runs `change` on the local store while the removal is out. */
function whileRemoving(change: () => void) {
  serverAnswers({
    onStorageRequest: (op) => {
      if (op === 'remove') {
        change();
      }
    },
  });
}

/** The query keys invalidated, in order. */
function invalidated(): unknown[] {
  return invalidate.mock.calls.map(([filters]) => filters.queryKey);
}

describe('useRemoveReceipt (#23)', () => {
  it('removes the photo, then clears the transaction for the push, and refreshes the screens (mutants: the push not requested, success-only invalidation)', async () => {
    const outcome = await removeThrough();

    expect(outcome).toBe('resolved true');
    expect(ctx.objects.has(OBJECT)).toBe(false);
    expect(t1()).toEqual({
      _sync_status: 'pending',
      receipt_path: null,
      restamped: true,
    });
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
    expect(invalidated()).toEqual([['transaction', 't1'], ['transactions']]);
  });

  it('changes nothing when Storage cannot be reached, and says so (mutants: the local write first, the error not mapped)', async () => {
    serverAnswers({ offline: true });

    const outcome = await removeThrough();

    // The local write first: t1 cleared and pushed while its photo stays in
    // the bucket, named by nothing. Unmapped: "…: Failed to fetch".
    expect(outcome).toBe(
      'Error: The receipt was not removed: the network is unavailable'
    );
    expect(ctx.objects.has(OBJECT)).toBe(true);
    expect(t1()).toEqual(unchanged);
    expect(requestPush).not.toHaveBeenCalled();
    // A refusal refreshes the screens too.
    expect(invalidated()).toEqual([['transaction', 't1'], ['transactions']]);
  });

  it('clears a transaction whose photo is already gone: a dangling receipt is healed (mutant: an empty answer read as a failure)', async () => {
    ctx.objects.delete(OBJECT);

    const outcome = await removeThrough();

    expect(outcome).toBe('resolved true');
    expect(t1()).toEqual({
      _sync_status: 'pending',
      receipt_path: null,
      restamped: true,
    });
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      ['[receipt] already gone from Storage:', PATH],
    ]);
  });

  it('refuses before any request without a session of its own: Storage would answer an anon removal with nothing removed (mutant: no session check)', async () => {
    serverAnswers({ anonScoped: true });

    const anon = await removeThrough();
    serverAnswers({ sessionUserId: 'someone-else' });
    const wrongUser = await removeThrough();

    // Without the check: Storage, under RLS, removes nothing and answers [],
    // which reads as "already gone": t1 cleared and pushed, its photo left
    // in the bucket.
    expect(anon).toBe(
      'Error: The receipt was not removed: your sign-in could not be renewed (the request timed out)'
    );
    expect(wrongUser).toBe(
      'Error: The receipt was not removed: your sign-in belongs to a different account'
    );
    expect(ctx.objects.has(OBJECT)).toBe(true);
    expect(t1()).toEqual(unchanged);
    expect(requestPush).not.toHaveBeenCalled();
  });

  it("refuses before any request a receipt in another account's folder: Storage would remove nothing and answer [], which reads as already gone (mutant: the folder check dropped)", async () => {
    // Another account's transaction, still on this device after its sign-out
    // (sign-out wipes no rows; until #177 useTransaction read it by id
    // alone), naming its own photo.
    const theirs = 'u0/t1.n1.jpg';
    ctx.adapter._sqlite
      .prepare("UPDATE transactions SET receipt_path = ? WHERE id = 't1'")
      .run(theirs);
    ctx.objects.set(`receipts/${theirs}`, {
      contentType: 'image/jpeg',
      body: 'THEIRS',
    });
    const requests: string[] = [];
    serverAnswers({
      onStorageRequest: (op) => {
        requests.push(op);
      },
    });

    const outcome = await removeThrough(theirs);

    // Without the check: Storage, under RLS, removes nothing and answers [],
    // read as a photo already gone: t1 cleared here and left pending, for the
    // other account's next push to upload as null, its photo kept and named
    // by nothing.
    expect(outcome).toBe(
      'Error: The receipt was not removed: it belongs to a different account'
    );
    expect(requests).toEqual([]);
    expect(ctx.objects.has(`receipts/${theirs}`)).toBe(true);
    expect(t1()).toEqual({
      _sync_status: 'synced',
      receipt_path: theirs,
      restamped: false,
    });
    expect(requestPush).not.toHaveBeenCalled();
  });

  it('never un-deletes a transaction deleted here while the removal was out, and says so (mutant: the status filter dropped)', async () => {
    whileRemoving(() => {
      ctx.adapter._sqlite
        .prepare(
          "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = 't1'"
        )
        .run(DELETED_AT);
    });

    const outcome = await removeThrough();

    // Without the filter: 'resolved true', and t1 'pending' again, so the
    // push would upload a transaction the user had deleted.
    expect(t1()).toEqual({
      _sync_status: 'deleted',
      receipt_path: PATH,
      restamped: false,
    });
    expect(outcome).toBe(`Error: ${RECEIPT_REMOVED_BUT_GONE}`);
    expect(ctx.objects.has(OBJECT)).toBe(false);
    expect(requestPush).not.toHaveBeenCalled();
  });

  it('says so when the transaction left this device while the removal was out (mutant: a zero match read as moved on)', async () => {
    whileRemoving(() => {
      ctx.adapter._sqlite
        .prepare("DELETE FROM transactions WHERE id = 't1'")
        .run();
    });

    const outcome = await removeThrough();

    // Storage removed the photo, and the words say it went.
    expect(outcome).toBe(
      'Error: The receipt was removed, but this transaction no longer exists on this device, or was deleted here.'
    );
    expect(ctx.objects.has(OBJECT)).toBe(false);
    expect(t1()).toBeUndefined();
    expect(requestPush).not.toHaveBeenCalled();
  });

  it("says the photo was already gone when Storage had none to remove and the transaction left meanwhile (mutants: the words of a removal that removed one, Storage's answer not passed on)", async () => {
    ctx.objects.delete(OBJECT);
    whileRemoving(() => {
      ctx.adapter._sqlite
        .prepare("DELETE FROM transactions WHERE id = 't1'")
        .run();
    });

    const outcome = await removeThrough();

    // Storage answered that it removed nothing: "The receipt was removed,
    // but…" would tell the user of a removal that never happened.
    expect(outcome).toBe(
      "Error: The receipt's photo was already gone, and this transaction no longer exists on this device, or was deleted here."
    );
    expect(t1()).toBeUndefined();
    expect(requestPush).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      ['[receipt] already gone from Storage:', PATH],
    ]);
  });

  it('leaves a receipt that replaced this one elsewhere meanwhile, and pushes nothing (mutant: the path condition dropped)', async () => {
    whileRemoving(() => {
      ctx.adapter._sqlite
        .prepare(
          "UPDATE transactions SET receipt_path = 'u/t1.n9.png' WHERE id = 't1'"
        )
        .run();
    });

    const outcome = await removeThrough();

    expect(outcome).toBe('resolved false');
    expect(t1()).toEqual({
      _sync_status: 'synced',
      receipt_path: 'u/t1.n9.png',
      restamped: false,
    });
    expect(requestPush).not.toHaveBeenCalled();
    expect(ctx.objects.has(OBJECT)).toBe(false);
  });

  it('fails at once while offline instead of waiting, paused, to remove the photo later (mutant: networkMode left as online)', async () => {
    onlineManager.setOnline(false);
    serverAnswers({ offline: true });

    await act(async () => {
      removeReceipt.mutate({ transactionId: 't1', path: PATH });
    });
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });

    // Left 'online', the mutation pauses: nothing settles until the device
    // is back, and then the photo goes with nobody looking.
    const [mutation] = qc.getMutationCache().getAll();
    expect(mutation.state.isPaused).toBe(false);
    expect(String(mutation.state.error)).toBe(
      'Error: The receipt was not removed: the network is unavailable'
    );
    expect(t1()).toEqual(unchanged);
  });

  it('forgets the URL kept for the removed photo, so a transaction still naming it shows it missing (mutant: the URL kept)', async () => {
    await receiptUrl('u', PATH);

    await removeThrough();

    // A row the re-download brings back naming the photo: signed again, it
    // reads as missing instead of showing the photo from the cache.
    let missing: unknown = 'resolved';
    try {
      await receiptUrl('u', PATH);
    } catch (e) {
      missing = String(e);
    }
    expect(missing).toBe('StorageApiError: Object not found');
  });
});

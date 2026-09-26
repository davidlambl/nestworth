// useReceiptPhoto attaches a receipt only to a transaction this device still
// has and has not deleted (#138). It uploads the photo first and writes the
// path after, and the upload takes as long as the network does: meanwhile a
// pulled tombstone or the reset's wipe can remove the row, and a delete on
// this device can mark it deleted. The UPDATE used to match nothing in the
// first case and to un-delete the row in the second (#139's receipt half);
// either way the hook reported success, requested a push and left the
// uploaded object behind. Now the attach is refused, the object is removed
// (best effort: a failed removal only warns), and the refusal is reported on
// the sync indicator as well as in the Alert, which does nothing on web or in
// Electron. The indicator carries every failure the hook meets, so while the
// device is online web and Electron no longer swallow a failed upload either.
// Offline they still do: the indicator says Offline ahead of any error, and
// the reconnection's sync clears it. An upload that never reached Storage
// reads as the network being unavailable, through describeRequestError, not
// as the platform's fetch text; every other failure keeps its own words.
//
// Own file, importing only the hook and the fixture, so it loads on the code
// before #138 as well: that is where each regression test here was proven red.
// react-native is stubbed down to Alert, so expo-image-picker must be stubbed
// too (the real one loads expo-modules-core, which needs react-native's
// Platform). The Storage bucket is a stub; an upload can change the store
// before it resolves, as anything else may while the network is waited on.
// The seeded row is synced: the save that ran just before the upload wrote it
// pending, and only once its own push has marked it synced can a tombstone or
// the wipe take it.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../supabase', () => {
  const bucket = { upload: jest.fn(), remove: jest.fn() };
  return { supabase: { storage: { from: jest.fn(() => bucket) } } };
});
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('../syncStatus', () => ({ setLastError: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { supabase } from '../supabase';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { setLastError } from '../syncStatus';
import { useReceiptPhoto } from '../hooks/useReceiptPhoto';
import { insertLocalTxn, makeAdapter } from '../testing/syncFixture';

const bucket = supabase.storage.from('receipts') as unknown as {
  upload: jest.Mock;
  remove: jest.Mock;
};
/** Every bucket the hook asked for, in order: the stub answers any name. */
const storageFrom = supabase.storage.from as unknown as jest.Mock;

/** When the seeded transaction last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When a delete on this device marked it, during the upload. */
const DELETED_AT = '2026-09-26T08:00:00.000Z';
const URI = 'file:///tmp/receipt.jpg';
const PATH = 'u/t1.jpg';
const REFUSAL =
  'The receipt was not attached: this transaction no longer exists on this device, or was deleted here.';
const NOT_REMOVED = '[receipt] upload not removed:';

let adapter: ReturnType<typeof makeAdapter>;
let renderer: ReactTestRenderer;
let hook: ReturnType<typeof useReceiptPhoto>;
let savedFetch: typeof fetch;
let warn: jest.SpyInstance;

function Harness() {
  const receipt = useReceiptPhoto();
  useEffect(() => {
    hook = receipt;
  });
  return null;
}

beforeEach(async () => {
  jest.clearAllMocks();
  bucket.upload.mockReset();
  bucket.upload.mockResolvedValue({ data: { path: PATH }, error: null });
  bucket.remove.mockReset();
  bucket.remove.mockResolvedValue({ data: [{ name: PATH }], error: null });
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  savedFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async () => ({
    blob: async () => 'BLOB',
  })) as unknown as typeof fetch;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await insertLocalTxn(adapter, { id: 't1', updated_at: SYNCED_AT });

  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness));
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  globalThis.fetch = savedFetch;
  warn.mockRestore();
  adapter._sqlite.close();
});

type ReceiptRow = {
  _sync_status: string;
  receipt_path: string | null;
  updated_at: string;
};

/** t1's status, receipt and stamp; undefined once it is gone. */
function t1(): ReceiptRow | undefined {
  return adapter._sqlite
    .prepare(
      "SELECT _sync_status, receipt_path, updated_at FROM transactions WHERE id = 't1'"
    )
    .get() as ReceiptRow | undefined;
}

/** A pulled tombstone or the reset's wipe: t1 gone from this device. */
function removeT1() {
  adapter._sqlite.prepare("DELETE FROM transactions WHERE id = 't1'").run();
}

/** A delete on this device, or of t1's account: t1 marked deleted. */
function markT1Deleted() {
  adapter._sqlite
    .prepare(
      "UPDATE transactions SET _sync_status = 'deleted', updated_at = ? WHERE id = 't1'"
    )
    .run(DELETED_AT);
}

/** The next upload succeeds once `change` has run on the store. */
function uploadWhile(change: () => void) {
  bucket.upload.mockImplementationOnce(async () => {
    change();
    return { data: { path: PATH }, error: null };
  });
}

/**
 * What storage-js 2.101.1 resolves when the upload never reached Storage (a
 * DNS failure, a captive portal, a dropped connection, while NetInfo still
 * says online): a StorageUnknownError carrying the platform's fetch text,
 * Chrome's here. Built by hand: its name and message are all
 * describeRequestError reads, and @supabase/storage-js is not a direct
 * dependency of the app.
 */
function unreachableStorageError(): Error {
  const error = new Error('Failed to fetch');
  error.name = 'StorageUnknownError';
  return error;
}

/** Attaches the photo to t1 through the hook; what uploadPhoto returned. */
async function attach(): Promise<unknown> {
  let out: unknown = 'not returned';
  await act(async () => {
    out = await hook.uploadPhoto(URI, 't1');
  });
  return out;
}

/** The hook's own warnings about an upload it could not remove. */
function removalWarnings(): unknown[][] {
  return warn.mock.calls.filter((call) => call[0] === NOT_REMOVED);
}

describe('useReceiptPhoto.uploadPhoto (#138)', () => {
  it('refuses the attach when the transaction is removed during the upload: the upload is removed, no push, and the refusal shows on every platform', async () => {
    uploadWhile(removeT1);

    const out = await attach();

    // Before #138: 'u/t1.jpg', a push requested, the object left in the
    // bucket, and nothing shown on web or in Electron.
    expect(out).toBeNull();
    expect(requestPush).not.toHaveBeenCalled();
    expect(bucket.remove).toHaveBeenCalledTimes(1);
    expect(bucket.remove).toHaveBeenCalledWith([PATH]);
    // The upload's bucket, then the removal's.
    expect(storageFrom.mock.calls).toEqual([['receipts'], ['receipts']]);
    expect(setLastError).toHaveBeenCalledTimes(1);
    expect(setLastError).toHaveBeenCalledWith(`Save failed: ${REFUSAL}`);
    expect(Alert.alert).toHaveBeenCalledWith('Upload failed', REFUSAL);
    expect(t1()).toBeUndefined();
    expect(removalWarnings()).toEqual([]);
  });

  it('refuses the attach when the transaction is marked deleted during the upload, and leaves it deleted (#139)', async () => {
    uploadWhile(markT1Deleted);

    const out = await attach();

    // Before #138: t1 'pending' again with the receipt, a transaction the
    // user had deleted brought back to life, and a push requested for it.
    expect(t1()).toEqual({
      _sync_status: 'deleted',
      receipt_path: null,
      updated_at: DELETED_AT,
    });
    expect(out).toBeNull();
    expect(requestPush).not.toHaveBeenCalled();
    expect(bucket.remove).toHaveBeenCalledWith([PATH]);
    expect(setLastError).toHaveBeenCalledWith(`Save failed: ${REFUSAL}`);
    expect(Alert.alert).toHaveBeenCalledWith('Upload failed', REFUSAL);
  });

  it('pin: attaches the receipt to a transaction that is still here, marks it pending, and requests one push', async () => {
    const out = await attach();

    expect(out).toBe(PATH);
    expect(globalThis.fetch).toHaveBeenCalledWith(URI);
    expect(storageFrom.mock.calls).toEqual([['receipts']]);
    expect(bucket.upload).toHaveBeenCalledWith(PATH, 'BLOB', {
      contentType: 'image/jpg',
      upsert: true,
    });
    const row = t1();
    expect(row).toEqual({
      _sync_status: 'pending',
      receipt_path: PATH,
      updated_at: expect.any(String),
    });
    expect(row!.updated_at > SYNCED_AT).toBe(true);
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(requestPush).toHaveBeenCalledWith('u');
    expect(bucket.remove).not.toHaveBeenCalled();
    expect(setLastError).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('reports a failed upload on the sync indicator as well as in the Alert, and writes nothing', async () => {
    bucket.upload.mockResolvedValueOnce({
      data: null,
      error: new Error('Bucket not found'),
    });
    const before = t1();

    const out = await attach();

    // Before #138: the Alert only, which does nothing on web or in Electron.
    expect(setLastError).toHaveBeenCalledWith('Save failed: Bucket not found');
    expect(Alert.alert).toHaveBeenCalledWith(
      'Upload failed',
      'Bucket not found'
    );
    expect(out).toBeNull();
    expect(bucket.remove).not.toHaveBeenCalled();
    expect(requestPush).not.toHaveBeenCalled();
    expect(t1()).toEqual(before);
  });

  it("reports an upload that never reached Storage as the network being unavailable, not in the fetch error's own words", async () => {
    bucket.upload.mockResolvedValueOnce({
      data: null,
      error: unreachableStorageError(),
    });

    const out = await attach();

    // Before #138: no setLastError at all, and the Alert (iOS only) read
    // "Failed to fetch". Unmapped, this change first read "Save failed:
    // Failed to fetch" on every platform.
    expect(setLastError).toHaveBeenCalledWith(
      'Save failed: the network is unavailable'
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      'Upload failed',
      'the network is unavailable'
    );
    expect(out).toBeNull();
    expect(bucket.remove).not.toHaveBeenCalled();
    expect(requestPush).not.toHaveBeenCalled();
  });

  it('keeps a failed read of the picked file in its own words: only the upload is a request', async () => {
    // React Native's fetch of a file:// URI fails with the same words as a
    // network failure. It is not one, so it must not read as the network
    // being unavailable: only the upload's error goes through
    // describeRequestError, never the catch as a whole.
    (globalThis.fetch as unknown as jest.Mock).mockRejectedValueOnce(
      new TypeError('Network request failed')
    );

    const out = await attach();

    // Before #138: no setLastError at all.
    expect(setLastError).toHaveBeenCalledWith(
      'Save failed: Network request failed'
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      'Upload failed',
      'Network request failed'
    );
    expect(out).toBeNull();
    expect(bucket.upload).not.toHaveBeenCalled();
    expect(requestPush).not.toHaveBeenCalled();
  });

  it('warns when the removal removed nothing, and still reports the refusal', async () => {
    // What a removal the bucket's policies do not allow most likely answers.
    bucket.remove.mockResolvedValueOnce({ data: [], error: null });
    uploadWhile(removeT1);

    const out = await attach();

    // Before #138: no refusal, so no removal and nothing to warn about.
    expect(removalWarnings()).toEqual([[NOT_REMOVED, PATH, 'nothing removed']]);
    expect(setLastError).toHaveBeenCalledWith(`Save failed: ${REFUSAL}`);
    expect(Alert.alert).toHaveBeenCalledWith('Upload failed', REFUSAL);
    expect(out).toBeNull();
  });

  it("warns when the removal rejects, and still reports the refusal, not the removal's error", async () => {
    const failure = new Error('socket hang up');
    bucket.remove.mockRejectedValueOnce(failure);
    uploadWhile(removeT1);

    const out = await attach();

    // Before #138: no refusal at all.
    expect(setLastError).toHaveBeenCalledTimes(1);
    expect(setLastError).toHaveBeenCalledWith(`Save failed: ${REFUSAL}`);
    expect(removalWarnings()).toEqual([[NOT_REMOVED, PATH, failure]]);
    expect(Alert.alert).toHaveBeenCalledWith('Upload failed', REFUSAL);
    expect(out).toBeNull();
  });
});

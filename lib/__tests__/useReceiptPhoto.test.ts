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
// Since #152 the hook keeps the whole picked asset, not just its URI, and the
// object's key and type come first from the asset's mimeType
// (lib/receiptObject.ts): on web the URI is a blob: URL, whose tail used to
// become the "extension".
// The body is the file's bytes as an ArrayBuffer: storage-js wraps a Blob in
// FormData, which React Native cannot send. Every attach here picks first and
// uploads what the pick returned, as the two transaction screens do. The
// bytes are compared with toStrictEqual: toHaveBeenCalledWith compares two
// ArrayBuffers by their own keys, which they have none of, so it passes any
// ArrayBuffer, an empty one included.
//
// Own file, importing only the hook and the fixture, so it loads on the code
// before #138 as well: that is where each #138 regression test here was
// proven red. The #152 ones were proven red on the code just before #152.
// react-native is stubbed down to Alert, so expo-image-picker must be stubbed
// too (the real one loads expo-modules-core, which needs react-native's
// Platform): its permission requests grant, and each picker resolves the
// asset a test hands it. The Storage bucket is a stub; an upload can change
// the store before it resolves, as anything else may while the network is
// waited on.
// The seeded row is synced: the save that ran just before the upload wrote it
// pending, and only once its own push has marked it synced can a tombstone or
// the wipe take it.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
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
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../supabase';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { setLastError } from '../syncStatus';
import { useReceiptPhoto } from '../hooks/useReceiptPhoto';
import { insertLocalTxn, makeAdapter } from '../testing/syncFixture';

const picker = ImagePicker as unknown as {
  requestMediaLibraryPermissionsAsync: jest.Mock;
  launchImageLibraryAsync: jest.Mock;
  requestCameraPermissionsAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
};
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
/** What expo-image-picker returns on iOS: a cached file, typed by its extension. */
const IOS_ASSET = {
  uri: URI,
  width: 1200,
  height: 900,
  type: 'image',
  mimeType: 'image/jpeg',
  fileName: null,
  fileSize: 8,
};
/**
 * What it returns on web and in Electron (ExponentImagePicker.web.ts): the
 * picked File's object URL, type and name. The URL has no dot at all on
 * localhost; on a deployed host its last dot falls in the host name.
 */
const WEB_ASSET = {
  uri: 'blob:http://localhost:8081/0b7f2a8e-4d7c-4c55-9a0e-1f6c1d2e3f40',
  width: 1200,
  height: 900,
  type: 'image',
  mimeType: 'image/png',
  fileName: 'receipt.png',
  fileSize: 8,
};
/** The picked file's bytes, as the hook reads them: a JPEG's first eight. */
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]).buffer;
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
  // Both readers answer, so a hook that reads a Blob is caught by what it
  // uploads rather than by a missing method.
  globalThis.fetch = jest.fn(async () => ({
    blob: async () => 'BLOB',
    arrayBuffer: async () => BYTES,
  })) as unknown as typeof fetch;
  picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
    status: 'granted',
  });
  picker.requestCameraPermissionsAsync.mockResolvedValue({
    status: 'granted',
  });
  picker.launchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [IOS_ASSET],
  });
  picker.launchCameraAsync.mockResolvedValue({
    canceled: false,
    assets: [IOS_ASSET],
  });
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

/**
 * Picks a photo and attaches it to t1 through the hook, as the transaction
 * screens do: what the pick returned goes back to uploadPhoto. Resolves what
 * uploadPhoto returned.
 */
async function attach(asset: object = IOS_ASSET): Promise<unknown> {
  picker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [asset],
  });
  let out: unknown = 'not returned';
  await act(async () => {
    const picked = await hook.pickPhoto();
    out = await hook.uploadPhoto(picked!, 't1');
  });
  return out;
}

/** The body of the one upload the hook made. */
function uploadedBody(): unknown {
  expect(bucket.upload).toHaveBeenCalledTimes(1);
  return bucket.upload.mock.calls[0][1];
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

  it("attaches the receipt to a transaction that is still here: the file's bytes under the asset's type, the row pending, one push (#152)", async () => {
    const out = await attach();

    expect(out).toBe(PATH);
    expect(globalThis.fetch).toHaveBeenCalledWith(URI);
    expect(storageFrom.mock.calls).toEqual([['receipts']]);
    // Before #152: the Blob, which storage-js sends as FormData and React
    // Native's FormData cannot carry, typed 'image/jpg' from the URI.
    expect(bucket.upload).toHaveBeenCalledWith(PATH, BYTES, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    expect(uploadedBody()).toStrictEqual(BYTES);
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

describe('useReceiptPhoto: the key and the type come from the picked asset (#152)', () => {
  it('stores a photo picked on web under the type of the picked file, not the tail of its blob: URL', async () => {
    const out = await attach(WEB_ASSET);

    // Before #152: 'u/t1.blob:http://localhost:8081/0b7f…' as the key (the
    // URL has no dot, so the whole of it was the "extension"), and the
    // content type built from it.
    expect(bucket.upload).toHaveBeenCalledWith('u/t1.png', BYTES, {
      contentType: 'image/png',
      upsert: true,
    });
    expect(uploadedBody()).toStrictEqual(BYTES);
    expect(globalThis.fetch).toHaveBeenCalledWith(WEB_ASSET.uri);
    expect(out).toBe('u/t1.png');
    expect(t1()!.receipt_path).toBe('u/t1.png');
    expect(requestPush).toHaveBeenCalledTimes(1);
    expect(setLastError).not.toHaveBeenCalled();
  });

  it('keeps the whole picked asset for the screens to pass back, from the camera and from the library, until clearPhoto', async () => {
    let fromCamera: unknown;
    await act(async () => {
      fromCamera = await hook.takePhoto();
    });

    // Before #152: the hook kept only the URI (photoUri), so the asset's
    // type never reached the upload.
    expect(hook.photo).toEqual(IOS_ASSET);
    expect(fromCamera).toEqual(IOS_ASSET);

    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [WEB_ASSET],
    });
    await act(async () => {
      await hook.pickPhoto();
    });
    expect(hook.photo).toEqual(WEB_ASSET);

    await act(async () => {
      hook.clearPhoto();
    });
    expect(hook.photo).toBeNull();
  });
});

// A receipt that replaces another keeps the replaced photo in the bucket
// (#23). The push uploads the whole local row (pushChanges: `SELECT *` minus
// `_sync_status`), so a device that edited the transaction before it pulled
// the replace still names the old key, and its push puts that key back on the
// server, newest by arrival, from where every device pulls it. The receipt
// then shows the old photo, as any field the stale edit carried shows its old
// value. Had the replace removed that photo, every device would show the
// receipt as missing, and the photo that replaced it would be named by
// nothing.
//
// Two devices on one server: A is the fixture's adapter, B a second one.
// The real useReceiptPhoto against the fixture's fake Storage, the real
// pushChanges and pullChanges. Both cases are green on the code before #23,
// where a photo of the same type overwrote the replaced one in place under
// the same key and one of another type never removed it: a pin there. Red
// under a replace that removes the replaced photo, as #23's first draft did.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
  })),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'n1') }));
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({
  ...jest.requireActual('../sync'),
  requestPush: jest.fn(),
}));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as ImagePicker from 'expo-image-picker';
import { getDb } from '../db';
import { pullChanges, pushChanges } from '../sync';
import { useReceiptPhoto } from '../hooks/useReceiptPhoto';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';

/** When t1 last synced on both devices, in PostgREST's rendering. */
const SYNCED_AT = '2026-05-10T00:00:00+00:00';
/** The photo that replaces it, as its bytes arrive. */
const NEW_BYTES = new Uint8Array([1, 2, 3]).buffer;

let ctx: ReturnType<typeof wireSyncMocks>;
let deviceB: ReturnType<typeof makeAdapter>;
let renderer: ReactTestRenderer;
let hook: ReturnType<typeof useReceiptPhoto>;
let quiet: jest.SpyInstance[];
let savedFetch: PropertyDescriptor | undefined;

function Harness() {
  const receipt = useReceiptPhoto();
  useEffect(() => {
    hook = receipt;
  });
  return null;
}

/** The device the next hook call, push or pull runs on. */
function onDevice(adapter: ReturnType<typeof makeAdapter>) {
  (getDb as unknown as jest.Mock).mockImplementation(async () => adapter);
}

/** a1 and t1 naming `old`, on the server and on both devices; its photo stored. */
async function seed(old: string, type: string) {
  ctx.store.accounts = [remoteAccount({ id: 'a1', updated_at: SYNCED_AT })];
  ctx.store.transactions = [
    remoteTxn({ id: 't1', receipt_path: old, updated_at: SYNCED_AT }),
  ];
  ctx.objects.set(`receipts/${old}`, { contentType: type, body: 'OLD' });
  for (const adapter of [ctx.adapter, deviceB]) {
    await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
    await insertLocalTxn(adapter, {
      id: 't1',
      receipt_path: old,
      updated_at: SYNCED_AT,
    });
  }
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  // Saved as its descriptor, never read: since SDK 56 Expo installs fetch as
  // a lazy getter whose first read loads expo/fetch, which needs the real
  // react-native module this suite mocks away.
  savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  globalThis.fetch = jest.fn(async () => ({
    arrayBuffer: async () => NEW_BYTES,
  })) as unknown as typeof fetch;
  deviceB = makeAdapter();
  onDevice(ctx.adapter);
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness));
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch);
  quiet.forEach((spy) => spy.mockRestore());
  ctx.adapter._sqlite.close();
  deviceB._sqlite.close();
});

/** What the server's t1 names, and whether that photo is in the bucket. */
function serverReceipt() {
  const path = ctx.store.transactions.find((r: any) => r.id === 't1')
    .receipt_path as string | null;
  return { path, inBucket: !!path && ctx.objects.has(`receipts/${path}`) };
}

describe('a replaced receipt and a stale edit from another device (#23)', () => {
  it.each([
    // A key from before #23, as the stored receipts have.
    ['of the same type', 'u/t1.jpg', 'image/jpeg'],
    ['of another type', 'u/t1.png', 'image/png'],
  ])(
    "keeps the replaced photo, so another device's stale edit brings back a receipt that shows, never a missing one (a photo %s)",
    async (_kind, old, type) => {
      await seed(old, type);
      // B edits t1's memo offline: pending, still naming the old receipt.
      deviceB._sqlite
        .prepare(
          "UPDATE transactions SET memo = 'Edited offline', updated_at = ?, _sync_status = 'pending' WHERE id = 't1'"
        )
        .run('2026-10-16T08:00:00.000Z');

      // A replaces the receipt with a JPEG (pick, then Save) and pushes.
      (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: 'file:///new.jpg', mimeType: 'image/jpeg' }],
      });
      let attached: unknown;
      await act(async () => {
        const picked = await hook.pickPhoto();
        attached = await hook.uploadPhoto(picked!, 't1');
        await new Promise((resolve) => setImmediate(resolve));
      });
      ctx.installSupabase({ serverNow: '2026-10-16T09:00:00+00:00' });
      await pushChanges('u');

      expect(serverReceipt()).toEqual({ path: attached, inBucket: true });
      // Until B and A have both synced, B shows the old photo, not a gap.
      expect(ctx.objects.has(`receipts/${old}`)).toBe(true);

      // B comes back online: its sync pushes before it pulls, the whole row.
      onDevice(deviceB);
      ctx.installSupabase({ serverNow: '2026-10-16T09:05:00+00:00' });
      await pushChanges('u');
      onDevice(ctx.adapter);
      await pullChanges('u');

      // Removed by the replace: { path: old, inBucket: false }, a receipt
      // every device shows as missing.
      expect(serverReceipt()).toEqual({ path: old, inBucket: true });
      expect(
        ctx.adapter._sqlite
          .prepare(
            "SELECT receipt_path, memo FROM transactions WHERE id = 't1'"
          )
          .get()
      ).toEqual({ receipt_path: old, memo: 'Edited offline' });
      // The photo that replaced it is still in the bucket, named by nothing
      // (Known Issues), and the edit's memo stands.
      expect(ctx.objects.has(`receipts/${attached}`)).toBe(true);
    }
  );
});

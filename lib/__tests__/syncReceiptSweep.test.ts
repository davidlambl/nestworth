// The receipt sweep (#176) and #23's race: a replaced photo is kept because
// another device's edit, made before it pulled the replace, still names it,
// and its push names it again on the server (syncReceiptReplace.test.ts). The
// sweep must not remove that photo while such a push can still come: it
// keeps a photo whose transaction changed within the grace, however old the
// photo is, and removes it only once nothing has named it for 30 days.
//
// Two devices on one server, as in syncReceiptReplace.test.ts: A is the
// fixture's adapter, B a second one; the real useReceiptPhoto against the
// fixture's fake Storage, the real pushChanges and pullChanges, and the real
// sweep signed as the service role against the same store and bucket. Ids are
// UUIDs, as the app's are: the sweep removes nothing whose key is not
// `<user>/<transaction>.<…>`.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
  })),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'cccccccc-0000-4000-8000-000000000001'),
}));
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({
  useAuth: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));
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
  makeSupabase,
  remoteAccount,
  remoteTxn,
  wireSyncMocks,
} from '../testing/syncFixture';
import { sweepReceipts } from '../../scripts/receipt-sweep/sweep';

const USER = '11111111-1111-4111-8111-111111111111';
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
/** The receipt t1 names before the replace: a key from before #23. */
const OLD = `${USER}/${T1}.jpg`;
/** The photo that replaces it (expo-crypto's mocked upload id). */
const NEW = `${USER}/${T1}.cccccccc-0000-4000-8000-000000000001.jpg`;
/** When t1 last synced on both devices, and the old photo was uploaded. */
const SYNCED_AT = '2026-05-10T00:00:00+00:00';
const REPLACED_AT = '2026-10-16T09:00:00+00:00';
const DAY = 24 * 60 * 60 * 1000;
const after = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString();

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

/** The server's clock for the next requests, signed in as USER. */
function serverAt(now: string) {
  ctx.installSupabase({ sessionUserId: USER, serverNow: now });
}

/** The sweep, as the service role, at `now`. */
function sweepAt(now: string) {
  return sweepReceipts(
    makeSupabase(
      ctx.store,
      { serviceRole: true, projectReads: true },
      ctx.objects
    ) as any,
    { mode: 'apply', now: Date.parse(now) }
  );
}

const named = (adapter: ReturnType<typeof makeAdapter>) =>
  (
    adapter._sqlite
      .prepare('SELECT receipt_path FROM transactions WHERE id = ?')
      .get(T1) as { receipt_path: string | null }
  ).receipt_path;
const serverNames = () =>
  ctx.store.transactions.find((r: any) => r.id === T1).receipt_path as string;
const inBucket = (key: string) => ctx.objects.has(`receipts/${key}`);

beforeEach(async () => {
  ctx = wireSyncMocks({ sessionUserId: USER });
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  // Saved as its descriptor, never read: since SDK 56 Expo installs fetch as
  // a lazy getter whose first read loads expo/fetch, which needs the real
  // react-native module this suite mocks away.
  savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  globalThis.fetch = jest.fn(async () => ({
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })) as unknown as typeof fetch;
  deviceB = makeAdapter();

  // t1 names OLD on the server and on both devices; OLD uploaded in May.
  ctx.store.accounts = [
    remoteAccount({ id: 'a1', user_id: USER, updated_at: SYNCED_AT }),
  ];
  ctx.store.transactions = [
    remoteTxn({
      id: T1,
      user_id: USER,
      receipt_path: OLD,
      updated_at: SYNCED_AT,
    }),
  ];
  ctx.objects.set(`receipts/${OLD}`, {
    contentType: 'image/jpeg',
    body: 'OLD',
    created_at: SYNCED_AT,
    updated_at: SYNCED_AT,
  });
  for (const adapter of [ctx.adapter, deviceB]) {
    await insertLocalAccount(adapter, {
      id: 'a1',
      user_id: USER,
      updated_at: SYNCED_AT,
    });
    await insertLocalTxn(adapter, {
      id: T1,
      user_id: USER,
      receipt_path: OLD,
      updated_at: SYNCED_AT,
    });
  }
  // B edits t1's memo offline: pending, still naming OLD.
  deviceB._sqlite
    .prepare(
      "UPDATE transactions SET memo = 'Edited offline', updated_at = ?, _sync_status = 'pending' WHERE id = ?"
    )
    .run('2026-10-16T08:00:00.000Z', T1);

  onDevice(ctx.adapter);
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness));
  });

  // A replaces the receipt (pick, then Save) and pushes.
  serverAt(REPLACED_AT);
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: 'file:///new.jpg', mimeType: 'image/jpeg' }],
  });
  await act(async () => {
    const picked = await hook.pickPhoto();
    expect(await hook.uploadPhoto(picked!, T1)).toBe(NEW);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await pushChanges(USER);
  expect(serverNames()).toBe(NEW);
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

/** B comes back online `days` after the replace: push first, the whole row. */
async function deviceBSyncs(days: number) {
  onDevice(deviceB);
  serverAt(after(REPLACED_AT, days));
  await pushChanges(USER);
  onDevice(ctx.adapter);
  await pullChanges(USER);
}

describe("the sweep and another device's stale edit of a replaced receipt (#176, #23)", () => {
  it('keeps the replaced photo while the stale edit can still name it again, then removes the photo nothing names 30 days after the last change', async () => {
    // Ten days on, OLD is named by nothing and five months old, but t1
    // changed ten days ago: kept. Removed by its age alone, B's push below
    // would name a photo that is gone, on every device.
    const first = await sweepAt(after(REPLACED_AT, 10));
    expect(first.states).toEqual({ named: 1, 'transaction-recent': 1 });
    expect(inBucket(OLD)).toBe(true);

    // B pushes its edit twenty days after the replace: t1 names OLD again.
    await deviceBSyncs(20);
    expect(serverNames()).toBe(OLD);
    expect(named(ctx.adapter)).toBe(OLD);
    expect(inBucket(OLD)).toBe(true);

    // NEW is now named by nothing: kept while t1's last change is recent.
    const second = await sweepAt(after(REPLACED_AT, 20 + 29));
    expect(second.records).toEqual([]);
    expect(inBucket(NEW)).toBe(true);

    // Thirty days after B's push, NEW goes; OLD, which every device shows,
    // stays.
    const third = await sweepAt(after(REPLACED_AT, 20 + 31));
    expect(third.records.map((r: any) => [r.key, r.result])).toEqual([
      [NEW, 'removed'],
    ]);
    expect(inBucket(OLD)).toBe(true);
    expect(inBucket(NEW)).toBe(false);
    expect([serverNames(), named(ctx.adapter), named(deviceB)]).toEqual([
      OLD,
      OLD,
      OLD,
    ]);
  });

  it('pin, the bound: an edit pushed more than 30 days after the replace names a photo the sweep removed, which every device then shows as missing until it is removed again', async () => {
    const swept = await sweepAt(after(REPLACED_AT, 31));
    expect(swept.records.map((r: any) => [r.key, r.result])).toEqual([
      [OLD, 'removed'],
    ]);

    await deviceBSyncs(35);

    expect(serverNames()).toBe(OLD);
    expect(named(ctx.adapter)).toBe(OLD);
    expect(inBucket(OLD)).toBe(false);
    // The photo that replaced it is named by nothing again, for the next
    // sweep 30 days on.
    expect(inBucket(NEW)).toBe(true);
  });
});

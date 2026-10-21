// useReceiptUrl (#23): the signed URL a screen shows a stored receipt
// through. A signed URL is a bearer token for one photo, so it belongs to the
// account it was signed for: several accounts sign in on one device in turn,
// sign-out wipes no local rows (CONTRIBUTING, "Sync meta keys"), and until
// #177 useTransaction read a transaction by id alone, so a second account
// could render the first one's transaction (a web history entry, a link). No
// screen does now; this stays the second line. A screen must never be handed
// the first account's URL, not even for a render out of TanStack's cache
// before the refetch, and the key, outside the second account's folder, is
// refused before any request (lib/receiptStorage.ts).
// Offline the URL is still asked for, and the query fails rather than waiting,
// paused, with a spinner that never ends.
//
// This hook is new with #23, so this suite cannot load on the code before
// it. Proven red under the mutants named in the titles. The harness is
// useRemoveReceipt.test.ts's: react-test-renderer and createElement, a real
// QueryClient, and the fixture's fake Storage.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
let mockUserId = 'u';
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: mockUserId } }) }));

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useReceiptUrl } from '../hooks/useReceiptUrl';
import { forgetReceiptUrls } from '../receiptStorage';
import { describeRequestError } from '../requestError';
import { wireSyncMocks } from '../testing/syncFixture';

const PATH = 'u/t1.n1.jpg';

let ctx: ReturnType<typeof wireSyncMocks>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
/** Every value the hook handed the screen, render by render. */
let seen: {
  user: string;
  data: string | null;
  error: unknown;
  fetchStatus: string;
  failureCount: number;
}[];

function Harness() {
  const q = useReceiptUrl(PATH);
  seen.push({
    user: mockUserId,
    data: q.data ?? null,
    error: q.error,
    fetchStatus: q.fetchStatus,
    failureCount: q.failureCount,
  });
  return null;
}

const tree = () =>
  createElement(QueryClientProvider, { client: qc }, createElement(Harness));

/** Waits, a tick at a time, until the hook has handed back `done`'s state. */
async function until(done: (last: (typeof seen)[number]) => boolean) {
  for (let i = 0; i < 200 && !done(seen[seen.length - 1]); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

beforeEach(async () => {
  ctx = wireSyncMocks();
  forgetReceiptUrls();
  mockUserId = 'u';
  seen = [];
  ctx.objects.set(`receipts/${PATH}`, { contentType: 'image/jpeg', body: 'J' });
  qc = new QueryClient();
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  await until((last) => !!last?.data);
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.clear();
  onlineManager.setOnline(true);
  ctx.adapter._sqlite.close();
});

it("never hands one account's URL to the next account signed in on the device, not even from the cache (mutants: the account left out of the query key, another account's key retried)", async () => {
  const first = seen[seen.length - 1].data;
  expect(first).toContain('token=');

  // u signs out and u2 signs in; u2's screen renders u's transaction.
  mockUserId = 'u2';
  const requests: string[] = [];
  ctx.installSupabase({
    sessionUserId: 'u2',
    onStorageRequest: (op) => {
      requests.push(op);
    },
  });
  seen = [];
  await act(async () => {
    renderer.update(tree());
  });
  await until((last) => !!last?.error);

  // Without the account in the key: u's URL, rendered from the cache before
  // the refetch. With it, u2's query starts empty, and u's key, outside u2's
  // folder, is refused before any request, and not retried.
  expect(seen.map((s) => s.data)).not.toContain(first);
  const last = seen[seen.length - 1];
  expect(last.data).toBeNull();
  expect(String(last.error)).toBe(
    'ForeignReceiptError: This receipt belongs to a different account.'
  );
  expect(last.failureCount).toBe(1);
  expect(requests).toEqual([]);
});

it('asks for the URL offline too, and settles with the network being unavailable instead of pausing (mutant: networkMode left as online)', async () => {
  // A receipt this device keeps no URL for, opened offline.
  await act(async () => {
    renderer.unmount();
  });
  qc.clear();
  forgetReceiptUrls();
  onlineManager.setOnline(false);
  ctx.installSupabase({ offline: true });
  // The delay before the hook's one retry is TanStack's, not under test.
  qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  seen = [];
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  await until((last) => !!last?.error);

  // Left 'online', TanStack never runs the query while the device is
  // offline: it waits, paused, until the device is back.
  const last = seen[seen.length - 1];
  expect(last.fetchStatus).toBe('idle');
  expect(describeRequestError(last.error)).toBe('the network is unavailable');
});

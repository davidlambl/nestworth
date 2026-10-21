// receiptUrl (#23): a stored receipt is shown through a signed URL, asked of
// Storage for an hour and kept while it has more than ten minutes to run, so
// the refetch every sync ends with hands back the same URL and the photo is
// not downloaded again. A photo that is gone is told apart from every other
// failure (isMissingReceipt), a request with no session of the user's own or
// for a key outside the user's folder is refused before it is made, and one
// that never answers is given up on. No failure carries the URL: it is a
// bearer token for the photo, and a signing still out when the user signs out
// keeps nothing.
//
// The Storage bucket is the fixture's fake (lib/testing/syncFixture.ts),
// which answers as storage-js 2.101.1 does (measured for #23 with a recording
// fetch): a URL with a fresh token on every signing, and for a missing object
// a StorageApiError with HTTP 400 and statusCode '404'.
//
// This module is new with #23, so this suite cannot load on the code before
// it. Each test was proven red under the mutant named in its title.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { describeRequestError } from '../requestError';
import {
  forgetReceiptUrl,
  forgetReceiptUrls,
  isForeignReceipt,
  isMissingReceipt,
  RECEIPT_FOREIGN,
  RECEIPT_URL_MIN_LEFT_MS,
  RECEIPT_URL_TIMEOUT_MS,
  RECEIPT_URL_TTL_S,
  receiptUrl,
} from '../receiptStorage';
import {
  storageApiError,
  storageUnknownError,
  wireSyncMocks,
} from '../testing/syncFixture';

const PATH = 'u/t1.n1.jpg';
const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const SIGNED = 'https://fake.supabase.co/storage/v1/object/sign/receipts';

let ctx: ReturnType<typeof wireSyncMocks>;
let requests: string[][];

beforeEach(() => {
  ctx = wireSyncMocks();
  forgetReceiptUrls();
  requests = [];
  ctx.installSupabase({
    onStorageRequest: (op, paths) => {
      requests.push([op, ...paths]);
    },
  });
  ctx.objects.set(`receipts/${PATH}`, { contentType: 'image/jpeg', body: 'J' });
});

afterEach(() => {
  jest.useRealTimers();
  ctx.adapter._sqlite.close();
});

/** The rejection, or 'resolved': never rejects.toThrow() in these suites. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return 'resolved';
}

describe('receiptUrl (#23)', () => {
  it("signs the user's own receipt in the receipts bucket for an hour (mutants: another bucket, another lifetime)", async () => {
    const url = await receiptUrl('u', PATH, T0);

    // The fake's token carries the lifetime asked for.
    expect(url).toBe(`${SIGNED}/${PATH}?token=t1.3600`);
    expect(RECEIPT_URL_TTL_S).toBe(3600);
    expect(requests).toEqual([['sign', PATH]]);
  });

  it('hands the same URL back while more than ten minutes are left, and signs a new one after (mutants: never kept, kept forever, the margin dropped)', async () => {
    const first = await receiptUrl('u', PATH, T0);
    const lastKept =
      T0 + RECEIPT_URL_TTL_S * 1000 - RECEIPT_URL_MIN_LEFT_MS - 1;

    const kept = await receiptUrl('u', PATH, lastKept);
    const fresh = await receiptUrl('u', PATH, lastKept + 1);

    expect(RECEIPT_URL_MIN_LEFT_MS).toBe(10 * 60 * 1000);
    expect(kept).toBe(first);
    expect(fresh).toBe(`${SIGNED}/${PATH}?token=t2.3600`);
    expect(requests).toEqual([
      ['sign', PATH],
      ['sign', PATH],
    ]);
  });

  it('signs again once a URL is forgotten: a retry asks for a new token (mutant: forget a no-op)', async () => {
    await receiptUrl('u', PATH, T0);
    forgetReceiptUrl(PATH);

    const again = await receiptUrl('u', PATH, T0 + 1000);

    expect(again).toBe(`${SIGNED}/${PATH}?token=t2.3600`);
  });

  it('keeps nothing a signing still out at sign-out would have kept: its URL goes to its caller, and the next ask signs again (mutants: the generation check dropped, sign-out not counted)', async () => {
    // The user signs out (lib/auth.tsx forgets every kept URL) while the
    // first signing is out, and signs in again.
    ctx.installSupabase({
      onStorageRequest: (op, paths) => {
        requests.push([op, ...paths]);
        if (requests.length === 1) {
          forgetReceiptUrls();
        }
      },
    });

    const inFlight = await receiptUrl('u', PATH, T0);
    const next = await receiptUrl('u', PATH, T0 + 1000);
    const again = await receiptUrl('u', PATH, T0 + 2000);

    // Without the check: the first URL kept after the clear and handed out
    // again with no request, a bearer token outliving the session it was
    // signed in. A signing that starts after the sign-out is kept as before.
    expect(inFlight).toBe(`${SIGNED}/${PATH}?token=t1.3600`);
    expect(next).toBe(`${SIGNED}/${PATH}?token=t2.3600`);
    expect(again).toBe(next);
    expect(requests).toEqual([
      ['sign', PATH],
      ['sign', PATH],
    ]);
  });

  it("rejects a photo that is gone with Storage's own error, which reads as missing and keeps nothing (mutants: the error swallowed, a failure kept)", async () => {
    ctx.objects.clear();

    const first = await rejectionOf(receiptUrl('u', PATH, T0));
    const second = await rejectionOf(receiptUrl('u', PATH, T0 + 1000));

    expect(isMissingReceipt(first)).toBe(true);
    expect(String(first)).toBe('StorageApiError: Object not found');
    expect(isMissingReceipt(second)).toBe(true);
    expect(requests).toEqual([
      ['sign', PATH],
      ['sign', PATH],
    ]);
  });

  it("refuses before any request without a session of the user's own, in the words describeRequestError passes through (mutant: no session check)", async () => {
    ctx.installSupabase({
      anonScoped: true,
      onStorageRequest: (op, paths) => {
        requests.push([op, ...paths]);
      },
    });
    const anon = await rejectionOf(receiptUrl('u', PATH, T0));
    ctx.installSupabase({ sessionUserId: 'someone-else' });
    const wrongUser = await rejectionOf(receiptUrl('u', PATH, T0));

    // Without the check: Storage answers the anon key with "Object not
    // found", and the screen would say the photo is missing.
    // In the engine's words (lib/sync.ts, NoSessionError): the refresh's own
    // failure, here the fixture's timed-out token request.
    expect(String(anon)).toBe(
      'NoSessionError: your sign-in could not be renewed (the request timed out)'
    );
    expect(describeRequestError(anon)).toBe(
      'your sign-in could not be renewed (the request timed out)'
    );
    expect(describeRequestError(wrongUser)).toBe(
      'your sign-in belongs to a different account'
    );
    expect(requests).toEqual([]);
  });

  it("never hands one account's kept URL to another account signed in on the device (mutant: the owner check dropped)", async () => {
    // Several accounts sign in on one device in turn and sign-out wipes no
    // rows (CONTRIBUTING, "Sync meta keys"); until #177 useTransaction read
    // by id. So a second account could render the first one's transaction,
    // from a web history entry or a link, and ask for its receipt.
    const first = await receiptUrl('u', PATH, T0);
    ctx.installSupabase({
      sessionUserId: 'u2',
      onStorageRequest: (op, paths) => {
        requests.push([op, ...paths]);
      },
    });

    const second = await rejectionOf(receiptUrl('u2', PATH, T0 + 60_000));

    // Without the check: u's URL, handed out with no request. With it, u's
    // key, outside u2's folder, is refused before any request.
    expect(second).not.toBe('resolved');
    expect(String(second)).not.toContain(first);
    expect(String(second)).toBe(
      'ForeignReceiptError: This receipt belongs to a different account.'
    );
    expect(requests).toEqual([['sign', PATH]]);
  });

  it("refuses a key outside the user's folder before any request, as another account's receipt (mutants: the folder check dropped, without its slash)", async () => {
    // Another account's transaction, still on this device after that account
    // signed out (sign-out wipes no rows; until #177 useTransaction read it
    // by id alone), names a photo in its own folder. 'u0' begins with 'u' on
    // purpose: the check is on the folder, its slash included.
    const theirs = 'u0/t1.n1.jpg';
    ctx.objects.set(`receipts/${theirs}`, {
      contentType: 'image/jpeg',
      body: 'THEIRS',
    });

    const error = await rejectionOf(receiptUrl('u', theirs, T0));

    // Without the check: Storage, under RLS, answers "Object not found", and
    // the screen would say the photo is missing and offer to remove it.
    expect(String(error)).toBe(
      'ForeignReceiptError: This receipt belongs to a different account.'
    );
    expect(requests).toEqual([]);
    expect(isForeignReceipt(error)).toBe(true);
    expect(isMissingReceipt(error)).toBe(false);
    expect(describeRequestError(error)).toBe(RECEIPT_FOREIGN);
  });

  it('rejects a signing that never reached Storage as the network being unavailable, and keeps nothing', async () => {
    ctx.installSupabase({ offline: true });

    const offline = await rejectionOf(receiptUrl('u', PATH, T0));
    ctx.installSupabase({});
    const back = await receiptUrl('u', PATH, T0 + 1000);

    expect(describeRequestError(offline)).toBe('the network is unavailable');
    expect(isMissingReceipt(offline)).toBe(false);
    expect(back).toBe(`${SIGNED}/${PATH}?token=t1.3600`);
  });

  it('gives up on a signing that never answers, as the request timing out (mutant: no timeout)', async () => {
    jest.useFakeTimers();
    ctx.installSupabase({ onStorageRequest: () => new Promise(() => {}) });

    const outcome = rejectionOf(receiptUrl('u', PATH, T0));
    await jest.advanceTimersByTimeAsync(RECEIPT_URL_TIMEOUT_MS);

    const error = await outcome;
    expect(RECEIPT_URL_TIMEOUT_MS).toBe(30_000);
    expect(describeRequestError(error)).toBe('the request timed out');
    expect(isMissingReceipt(error)).toBe(false);
  });

  it('puts no URL and no token in any failure it rejects with', async () => {
    const signed = await receiptUrl('u', PATH, T0);
    forgetReceiptUrl(PATH);
    ctx.objects.clear();
    const missing = await rejectionOf(receiptUrl('u', PATH, T0));

    expect(signed).toContain('token=');
    expect(JSON.stringify(missing)).not.toContain('token');
    expect(String(missing)).not.toContain('token');
    expect(String(missing)).not.toContain('https://');
  });
});

describe('isMissingReceipt (#23)', () => {
  it("reads Storage's NoSuchKey in both renderings, and nothing else (mutants: the status alone, the message alone)", () => {
    expect(
      isMissingReceipt(storageApiError('Object not found', 400, '404'))
    ).toBe(true);
    expect(
      isMissingReceipt(storageApiError('Object not found', 404, 'NoSuchKey'))
    ).toBe(true);
    // A 403, a network failure, a timeout, a bare Error with the same words,
    // and nothing at all are not a missing photo.
    expect(
      isMissingReceipt(
        storageApiError(
          'new row violates row-level security policy',
          400,
          '403'
        )
      )
    ).toBe(false);
    expect(isMissingReceipt(storageUnknownError('Failed to fetch'))).toBe(
      false
    );
    expect(
      isMissingReceipt(Object.assign(new Error('x'), { name: 'TimeoutError' }))
    ).toBe(false);
    expect(isMissingReceipt(new Error('Object not found'))).toBe(false);
    expect(isMissingReceipt(null)).toBe(false);
    // The same fields on something that is not Storage's error.
    expect(isMissingReceipt({ status: 404, statusCode: '404' })).toBe(false);
  });
});

describe('isForeignReceipt (#23)', () => {
  it("reads the signing's own refusal of another account's key, and nothing else (mutant: every failure read as another account's)", () => {
    // A missing photo, a refusal for want of a session, a network failure,
    // a bare Error with the same words, and nothing at all are not it.
    expect(
      isForeignReceipt(storageApiError('Object not found', 400, '404'))
    ).toBe(false);
    expect(
      isForeignReceipt(
        Object.assign(
          new Error('your sign-in belongs to a different account'),
          { name: 'NoSessionError' }
        )
      )
    ).toBe(false);
    expect(isForeignReceipt(storageUnknownError('Failed to fetch'))).toBe(
      false
    );
    expect(isForeignReceipt(new Error(RECEIPT_FOREIGN))).toBe(false);
    expect(isForeignReceipt(null)).toBe(false);
  });
});

import { withAuthTokenTimeout } from '../fetchWithTimeout';

const TOKEN_URL =
  'https://project.supabase.co/auth/v1/token?grant_type=refresh_token';
const LOGOUT_URL = 'https://project.supabase.co/auth/v1/logout';
const STORAGE_URL =
  'https://project.supabase.co/storage/v1/object/receipts/u/photo.jpg';
const REST_URL = 'https://project.supabase.co/rest/v1/transactions?select=*';

const TIMEOUT_MS = 30_000;

/** A fetch that never settles: the stalled-refresh case this wrapper exists for. */
function neverSettles(): jest.Mock {
  return jest.fn(() => new Promise<Response>(() => {}));
}

function ok(): jest.Mock {
  return jest.fn(async () => ({ ok: true }) as unknown as Response);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('withAuthTokenTimeout bounds the token refresh', () => {
  it('aborts a stalled /auth/v1/token request after the deadline', async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );

    const pending = wrapped(TOKEN_URL, { method: 'POST' });
    let err: unknown;
    const settled = pending.catch((e) => {
      err = e;
    });

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await settled;

    // The name is what auth-js and lib/requestError.ts both key off.
    expect((err as Error).name).toBe('AbortError');
    expect(String(err)).toContain('30000ms');
    // The request the wrapper passed down carries the merged signal, so a fetch
    // that does honour signals is cancelled rather than left running.
    expect(base.mock.calls[0][1].signal.aborted).toBe(true);
    // Nothing armed is left behind once the race is over.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no timer armed when the refresh answers in time', async () => {
    const base = ok();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );

    await wrapped(TOKEN_URL, { method: 'POST' });

    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes sign-out, storage and PostgREST through untouched', async () => {
    const base = ok();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );

    for (const url of [LOGOUT_URL, STORAGE_URL, REST_URL]) {
      const init = { method: 'POST', headers: { apikey: 'anon' } };
      await wrapped(url, init);
      const [passedInput, passedInit] = base.mock.calls.at(-1) as [
        string,
        RequestInit,
      ];
      expect(passedInput).toBe(url);
      // The exact same object, not a copy with a signal bolted on: a rejectable
      // signOut() would skip the sign-in navigation, and receipt uploads have no
      // size ceiling to time out against.
      expect(passedInit).toBe(init);
      expect(passedInit.signal).toBeUndefined();
    }
    // No deadline armed for any of them.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('recognises the token endpoint when the input is a Request', async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );
    // Duck-typed: jest's environment has no global Request, and the wrapper only
    // reads `.url`, exactly as a real Request would expose it.
    const request = { url: TOKEN_URL, method: 'POST' } as unknown as Request;

    let err: unknown;
    const settled = wrapped(request).catch((e) => {
      err = e;
    });
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await settled;

    expect((err as Error).name).toBe('AbortError');
  });

  it('short-circuits when the caller’s signal is already aborted', async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );
    const controller = new AbortController();
    controller.abort();

    let err: unknown;
    await wrapped(TOKEN_URL, { signal: controller.signal }).catch((e) => {
      err = e;
    });

    expect((err as Error).name).toBe('AbortError');
    // Rejected on the caller's abort, without waiting out the deadline.
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts when the caller's signal fires before the deadline", async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );
    const controller = new AbortController();

    let err: unknown;
    const settled = wrapped(TOKEN_URL, { signal: controller.signal }).catch(
      (e) => {
        err = e;
      }
    );
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await settled;

    expect((err as Error).name).toBe('AbortError');
    expect(jest.getTimerCount()).toBe(0);
  });
});

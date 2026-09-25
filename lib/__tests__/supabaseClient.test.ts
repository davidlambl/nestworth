// The client is built at module scope, so the only way to see how it is
// configured is to load the module with `createClient` mocked — a bare `{}` is
// enough, because the assertions are about the options `createClient` was
// handed, not about the client.
//
// Loaded afresh by each test (jest.resetModules, then a require) rather than by
// a static import, which would be hoisted above every line of this file: the
// module reads the anon key from the environment as it loads, and under jest
// none is set (nothing loads .env.local, and CI's unit-test step sets no
// Supabase env), so the key has to be in place first. The requires are spelled
// jest.requireMock / jest.requireActual because a bare require() is a lint
// warning here; nothing mocks ../supabase itself, so requireActual loads it
// exactly as a require would, its own imports going through the mocks.
//
// Why pin this at all: before #67 nothing in the app had a request timeout, so a
// stalled socket (a phone holding a dead connection open after a network change)
// left a sync — and everything awaiting the sync lock — waiting forever. And
// before #109 a request signed with the anon key reached PostgREST, whose RLS
// answered it as a success with nothing in it.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
const REST_URL = 'https://project.supabase.co/rest/v1/accounts?select=*';

let savedKey: string | undefined;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  } else {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = savedKey;
  }
  globalThis.fetch = savedFetch;
});

/** Loads lib/supabase.ts afresh and returns the options it gave createClient. */
function clientOptions(): {
  db?: { timeout?: number };
  global?: { fetch?: typeof fetch };
} {
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  jest.resetModules();
  // Side-effect load: loading the module IS the thing under test.
  jest.requireActual('../supabase');
  // The registry was reset above, so this is the mock the module just called.
  const mockedCreateClient = jest.requireMock('@supabase/supabase-js')
    .createClient as jest.Mock;
  expect(mockedCreateClient).toHaveBeenCalledTimes(1);
  expect(mockedCreateClient.mock.calls[0][1]).toBe(ANON_KEY);
  return mockedCreateClient.mock.calls[0][2] ?? {};
}

describe('the Supabase client bounds both halves of a request (#67)', () => {
  it('passes db.timeout so one request cannot hang forever', () => {
    expect(clientOptions().db?.timeout).toBe(30000);
  });

  it('keeps the timeout far above the deliberate stalls in the e2e suite', () => {
    // e2e/web/accounts-first-sync.spec.ts holds the transactions read open for
    // 2500 ms on purpose, to reproduce #55 deterministically. A timeout anywhere
    // near that would abort it and turn that spec red for the wrong reason.
    expect(clientOptions().db?.timeout).toBeGreaterThan(10_000);
  });

  it('wraps fetch, because db.timeout cannot reach the token refresh', () => {
    // supabase-js awaits getAccessToken() before the timed fetch exists, so a
    // stalled `POST /auth/v1/token` hangs the request db.timeout was meant to
    // bound. lib/fetchWithTimeout.ts is what covers that half; its own suite
    // pins the behaviour, this pins that the client is actually given it.
    const wrapped = clientOptions().global?.fetch;
    expect(typeof wrapped).toBe('function');
    expect(wrapped).not.toBe(globalThis.fetch);
  });

  it('bounds a stalled token refresh through that fetch at the same 30 s', async () => {
    // Since #109 the fetch is two wrappers deep, and dropping the timeout
    // from the composition would leave the refresh unbounded again while the
    // refusal kept every other test green.
    jest.useFakeTimers();
    try {
      const platform = jest.fn(() => new Promise<Response>(() => {}));
      globalThis.fetch = platform as unknown as typeof fetch;
      const wrapped = clientOptions().global?.fetch as typeof fetch;

      let err: unknown = null;
      const settled = wrapped(
        'https://project.supabase.co/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
        }
      ).catch((e) => {
        err = e;
      });
      await jest.advanceTimersByTimeAsync(29_999);
      expect(err).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      // Asserted before `settled` is awaited: with the timeout dropped from
      // the composition the request never settles, and awaiting it first
      // would fail on jest's own 5 s test timeout instead of on this line.
      expect((err as Error | null)?.name).toBe('AbortError');
      await settled;
      expect(platform).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the Supabase client refuses a PostgREST request signed with the anon key (#109)', () => {
  it('hands createClient a fetch that refuses an anon-signed /rest/v1/ request and passes a user-signed one to the platform', async () => {
    // lib/supabase.ts calls the global fetch at request time, so this is the
    // platform fetch underneath both wrappers.
    const platform = jest.fn(async () => new Response('[]', { status: 200 }));
    globalThis.fetch = platform as unknown as typeof fetch;
    const wrapped = clientOptions().global?.fetch as typeof fetch;

    let refused: unknown = null;
    await wrapped(REST_URL, {
      headers: new Headers({
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      }),
    }).catch((e) => {
      refused = e;
    });
    expect((refused as Error | null)?.name).toBe('NoSessionError');
    expect(platform).not.toHaveBeenCalled();

    const init = {
      headers: new Headers({
        apikey: ANON_KEY,
        Authorization: 'Bearer user-access-token',
      }),
    };
    await wrapped(REST_URL, init);
    expect(platform).toHaveBeenCalledTimes(1);
    const [passedInput, passedInit] = platform.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(passedInput).toBe(REST_URL);
    expect(passedInit).toBe(init);
  });
});

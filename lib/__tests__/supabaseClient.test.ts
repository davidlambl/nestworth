// The client is built at module scope, so the only way to see how it is
// configured is to load the module with `createClient` mocked — a bare `{}` is
// enough, because the assertions are about the key and the options
// `createClient` was handed, not about the client.
//
// Loaded afresh by each test (jest.resetModules, then a require) rather than by
// a static import, which would be hoisted above every line of this file: the
// module reads its key from the environment as it loads, and under jest none
// is set (nothing loads .env.local, and CI's unit-test step sets no Supabase
// env), so the key has to be in place first. Both key variables are set or
// cleared by every test, so the environment the suite runs in cannot decide
// which key the module builds with: a developer's shell, or Netlify's build,
// which runs `npm test` with the site's own variables set (netlify.toml).
// The requires are spelled jest.requireMock / jest.requireActual because a
// bare require() is a lint warning here; nothing mocks ../supabase itself, so
// requireActual loads it exactly as a require would, its own imports going
// through the mocks.
//
// Why pin this at all: before #67 nothing in the app had a request timeout, so a
// stalled socket (a phone holding a dead connection open after a network change)
// left a sync — and everything awaiting the sync lock — waiting forever. And
// before #109 a request signed with the anon key reached PostgREST, whose RLS
// answered it as a success with nothing in it. Since #191 the client signs
// with the publishable key when the build has one, and the refusal must follow
// whichever key the client signs with, or it compares against a key nothing
// sends and silently stops refusing.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
// A publishable key is no JWT: `sb_publishable_` and a random tail, no dots.
const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuv_12345678';
const REST_URL = 'https://project.supabase.co/rest/v1/accounts?select=*';

const KEY_VARS = [
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
] as const;

let savedKeys: Record<string, string | undefined>;
let savedFetch: typeof fetch;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  savedKeys = Object.fromEntries(
    KEY_VARS.map((name) => [name, process.env[name]])
  );
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const name of KEY_VARS) {
    setEnv(name, savedKeys[name]);
  }
  globalThis.fetch = savedFetch;
});

/** A build's two key variables: a string sets one, undefined unsets it. */
interface BuildKeys {
  publishable?: string;
  anon?: string;
}

interface Built {
  key: string;
  options: {
    db?: { timeout?: number; retry?: boolean };
    global?: { fetch?: typeof fetch };
  };
}

/**
 * Loads lib/supabase.ts afresh under `keys` and returns the key and the
 * options it gave createClient.
 */
function loadWith(keys: BuildKeys): Built {
  setEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', keys.publishable);
  setEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', keys.anon);
  jest.resetModules();
  // Side-effect load: loading the module IS the thing under test.
  jest.requireActual('../supabase');
  // The registry was reset above, so this is the mock the module just called.
  const mockedCreateClient = jest.requireMock('@supabase/supabase-js')
    .createClient as jest.Mock;
  expect(mockedCreateClient).toHaveBeenCalledTimes(1);
  return {
    key: mockedCreateClient.mock.calls[0][1],
    options: mockedCreateClient.mock.calls[0][2] ?? {},
  };
}

/** The options of a build that has the anon key alone, as before #191. */
function clientOptions(): Built['options'] {
  const { key, options } = loadWith({ anon: ANON_KEY });
  expect(key).toBe(ANON_KEY);
  return options;
}

/** The error a call rejected with, or null if it resolved. */
async function rejectionOf(call: Promise<unknown>): Promise<Error | null> {
  try {
    await call;
  } catch (e) {
    return e as Error;
  }
  return null;
}

/**
 * Drives the fetch a build handed createClient the way supabase-js calls it
 * for a PostgREST request: `apikey` is always the client's key, and
 * `Authorization` is the access token, else that same key. Asserts that a
 * request signed with `key` is refused unsent and that a user-signed one
 * reaches the platform fetch, untouched.
 */
async function expectRefusesOnly(
  built: Built,
  key: string,
  platform: jest.Mock
): Promise<void> {
  const wrapped = built.options.global?.fetch as typeof fetch;

  const refused = await rejectionOf(
    wrapped(REST_URL, {
      headers: new Headers({ apikey: key, Authorization: `Bearer ${key}` }),
    })
  );
  expect(refused?.name).toBe('NoSessionError');
  expect(platform).not.toHaveBeenCalled();

  const init = {
    headers: new Headers({
      apikey: key,
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
}

/** A platform fetch that answers every request as PostgREST answers `[]`. */
function installPlatform(): jest.Mock {
  // lib/supabase.ts calls the global fetch at request time, so this is the
  // platform fetch underneath both wrappers.
  const platform = jest.fn(async () => new Response('[]', { status: 200 }));
  globalThis.fetch = platform as unknown as typeof fetch;
  return platform;
}

describe('the Supabase client bounds both halves of a request (#67)', () => {
  it('passes db.timeout so one request cannot hang forever', () => {
    expect(clientOptions().db?.timeout).toBe(30000);
  });

  it("turns postgrest-js's own retries off, so a request is one attempt (#51)", () => {
    expect(clientOptions().db?.retry).toBe(false);
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
    const platform = installPlatform();
    await expectRefusesOnly(loadWith({ anon: ANON_KEY }), ANON_KEY, platform);
  });
});

describe('the Supabase client signs with the publishable key when the build has one, and the refusal follows it (#191)', () => {
  it('builds with the publishable key over the anon key, and refuses a /rest/v1/ request signed with it', async () => {
    // Every build in the transition: .env.local and the EAS environments
    // carry both keys. Handed the anon key, the refusal would compare against
    // a key nothing sends, and pass the publishable-signed request on.
    const platform = installPlatform();
    const built = loadWith({ publishable: PUBLISHABLE_KEY, anon: ANON_KEY });
    expect(built.key).toBe(PUBLISHABLE_KEY);
    await expectRefusesOnly(built, PUBLISHABLE_KEY, platform);
  });

  it('builds with the publishable key alone, once the anon key is gone', async () => {
    const platform = installPlatform();
    const built = loadWith({ publishable: PUBLISHABLE_KEY });
    expect(built.key).toBe(PUBLISHABLE_KEY);
    await expectRefusesOnly(built, PUBLISHABLE_KEY, platform);
  });

  it('falls back to the anon key when the publishable key is unset or blank', async () => {
    // Blank is how GitHub Actions hands over a secret that does not exist, so
    // CI names the publishable key's secret before the owner has stored it.
    for (const publishable of [undefined, '', ' \n']) {
      const platform = installPlatform();
      const built = loadWith({ publishable, anon: ANON_KEY });
      expect([publishable, built.key]).toEqual([publishable, ANON_KEY]);
      await expectRefusesOnly(built, ANON_KEY, platform);
    }
  });

  it('hands createClient an empty key when the build has neither, for it to refuse as before', () => {
    // The real createClient throws "supabaseKey is required." on it
    // (supabaseAnonRejection.test.ts drives that); the mock here only shows
    // what it is handed.
    expect(loadWith({}).key).toBe('');
  });
});

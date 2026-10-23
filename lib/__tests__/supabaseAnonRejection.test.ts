// #109, through the real client. With no session, supabase-js signs every
// request with the anon key (its `_getAccessToken` discards getSession()'s
// error and falls back to the key), and PostgREST's RLS answers each kind as a
// success with nothing in it: a read `200 []`, an UPDATE or a DELETE zero
// matched rows. The engine took those for honest answers, most dangerously a
// tombstone UPDATE's zero rows, which is the success case that hard-deletes the
// local row. Since #109 lib/supabase.ts's fetch wrapper refuses to send such a
// request, and postgrest-js hands the refusal back as `{ error }`, which every
// engine path already treats as a failed read or write.
//
// The client under test is lib/supabase.ts's own export: the real createClient
// is handed the module's own options — the key, db.timeout and both fetch
// wrappers — with one input replaced, the auth storage. The module's lazy
// AsyncStorage is a dynamic import() that jest cannot run without
// --experimental-vm-modules, and the stored session is what each test sets up.
// autoRefreshToken is off too: outside a browser auth-js starts its refresh
// ticker as soon as it initialises, and the stored token never nears expiry.
// Underneath everything is the platform fetch, i.e. the global fetch that
// lib/supabase.ts calls at request time, mocked to answer every request the way
// PostgREST answers an anon-signed read.
//
// Since #191 the client signs with the publishable key when the build has
// one, which the server maps to the same anon role: the last describe drives
// the same refusal through a client built with it. Every test sets or clears
// both key variables, so the environment the suite runs in cannot decide
// which key the module builds with: a developer's shell, or Netlify's build,
// which runs `npm test` with the site's own variables set (netlify.toml).
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeRequestError } from '../requestError';

const mockAuthStorage = new Map<string, string>();

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: (url: string, key: string, options: any) =>
      actual.createClient(url, key, {
        ...options,
        auth: {
          ...options.auth,
          storage: {
            getItem: async (k: string) => mockAuthStorage.get(k) ?? null,
            setItem: async (k: string, v: string) => {
              mockAuthStorage.set(k, v);
            },
            removeItem: async (k: string) => {
              mockAuthStorage.delete(k);
            },
          },
          autoRefreshToken: false,
        },
      }),
  };
});

const PROJECT_URL = 'https://project.supabase.co';
/** supabase-js's default storage key: `sb-<project ref>-auth-token`. */
const SESSION_KEY = 'sb-project-auth-token';
// A legacy anon key is a JWT like any access token.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
// A publishable key is no JWT: `sb_publishable_` and a random tail, no dots.
const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuv_12345678';
const ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.user-signature';

/** A session as auth-js stores it, far from expiry, so reading it is local. */
const STORED_SESSION = {
  access_token: ACCESS_TOKEN,
  refresh_token: 'user-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 4102444800,
  user: { id: 'u', aud: 'authenticated', role: 'authenticated' },
};

/** Every shape of request lib/sync.ts sends, built the way it builds them. */
const BUILDERS: [string, (s: SupabaseClient) => PromiseLike<any>][] = [
  [
    'a paged read',
    (s) =>
      s
        .from('accounts')
        .select('*')
        .eq('user_id', 'u')
        .order('id')
        .range(0, 999),
  ],
  [
    'an upsert read back with .single()',
    (s) =>
      s
        .from('accounts')
        .upsert({ id: 'a1' }, { onConflict: 'id' })
        .select('id, updated_at, deleted_at')
        .single(),
  ],
  [
    'a tombstone UPDATE',
    (s) =>
      s
        .from('accounts')
        .update({ deleted_at: '2026-09-25T00:00:00.000Z' })
        .eq('id', 'a1')
        .is('deleted_at', null),
  ],
  [
    'a split DELETE',
    (s) => s.from('transaction_splits').delete().eq('transaction_id', 't1'),
  ],
  [
    'a split INSERT read back',
    (s) =>
      s
        .from('transaction_splits')
        .insert([{ id: 's1', transaction_id: 't1' }])
        .select('id, updated_at'),
  ],
  [
    "the reset's probe",
    (s) => s.from('accounts').select('id').eq('user_id', 'u').limit(1),
  ],
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The Authorization header of a call the platform fetch received. */
function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

let platform: jest.Mock;
let saved: {
  url?: string;
  key?: string;
  publishable?: string;
  fetch: typeof fetch;
};

beforeEach(() => {
  saved = {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    publishable: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    fetch: globalThis.fetch,
  };
  process.env.EXPO_PUBLIC_SUPABASE_URL = PROJECT_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  // A build with the anon key alone, as before #191, unless a test says so.
  delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  mockAuthStorage.clear();
  platform = jest.fn(async () => json([]));
  globalThis.fetch = platform as unknown as typeof fetch;
});

afterEach(() => {
  for (const [name, value] of [
    ['EXPO_PUBLIC_SUPABASE_URL', saved.url],
    ['EXPO_PUBLIC_SUPABASE_ANON_KEY', saved.key],
    ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', saved.publishable],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  globalThis.fetch = saved.fetch;
});

/**
 * lib/supabase.ts, loaded afresh after the environment is set: the module
 * reads the URL and key as it loads. jest.requireActual is a plain require
 * here (nothing mocks ../supabase; its own imports go through the mocks), and
 * spelled so because a bare require() is a lint warning in this repo.
 */
function loadClient(): SupabaseClient {
  jest.resetModules();
  return jest.requireActual('../supabase').supabase;
}

/**
 * Every request shape the engine sends, through `supabase` with no session:
 * each answered with the refusal, and none of them sent.
 */
async function expectEveryShapeRefused(supabase: SupabaseClient) {
  for (const [shape, build] of BUILDERS) {
    const result = await build(supabase);
    // Sent, each would come back `200 []` with no error: an empty table, a
    // write that landed, a tombstone whose zero rows mean "already gone".
    expect([
      shape,
      {
        data: result.data,
        status: result.status,
        message: result.error?.message,
        code: result.error?.code,
        hint: result.error?.hint,
      },
    ]).toEqual([
      shape,
      {
        data: null,
        status: 0,
        message: 'NoSessionError: your sign-in could not be verified',
        code: '',
        hint: '',
      },
    ]);
    // postgrest-js folds the thrown error's name into `message` and keeps no
    // `name` of its own: why lib/requestError.ts matches the prefix too.
    expect([shape, 'name' in result.error]).toEqual([shape, false]);
    // What a user reads after "Couldn't download <table>: ".
    expect([shape, describeRequestError(result.error)]).toEqual([
      shape,
      'your sign-in could not be verified',
    ]);
  }
  expect(platform).not.toHaveBeenCalled();
}

describe('the app client refuses a PostgREST request signed with the anon key (#109)', () => {
  it('with no session, answers every request shape the engine sends with an error, and sends none of them', async () => {
    await expectEveryShapeRefused(loadClient());
  });

  it('with a session, sends every request shape signed with the access token', async () => {
    mockAuthStorage.set(SESSION_KEY, JSON.stringify(STORED_SESSION));
    const supabase = loadClient();

    for (const [shape, build] of BUILDERS) {
      const calls = platform.mock.calls.length;
      const result = await build(supabase);
      expect([shape, result.error]).toEqual([shape, null]);
      expect([shape, platform.mock.calls.length]).toEqual([shape, calls + 1]);
      // What both wrappers see on the way down: a string URL under /rest/v1/,
      // and the Headers instance supabase-js built, signed as the user.
      const [input, init] = platform.mock.calls[calls] as [string, RequestInit];
      expect([
        shape,
        typeof input,
        new URL(input).pathname.startsWith('/rest/v1/'),
        init.headers instanceof Headers,
        authorizationOf(init),
      ]).toEqual([shape, 'string', true, true, `Bearer ${ACCESS_TOKEN}`]);
    }
  });

  it('lets a page whose own token refresh stalled fail as the timeout it is, unsent', async () => {
    jest.useFakeTimers();
    try {
      // Inside auth-js's 90 s expiry margin, so getSession() refreshes first.
      mockAuthStorage.set(
        SESSION_KEY,
        JSON.stringify({
          ...STORED_SESSION,
          expires_at: Math.floor(Date.now() / 1000) + 30,
        })
      );
      // A dead connection: the refresh never answers but honours its signal,
      // and a request whose signal has already aborted is rejected at once,
      // as a real fetch rejects it.
      const aborted = () =>
        new DOMException('This operation was aborted', 'AbortError');
      platform.mockImplementation((input: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          return Promise.reject(aborted());
        }
        if (new URL(input).pathname === '/auth/v1/token') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(aborted()));
          });
        }
        return Promise.resolve(json([]));
      });
      const supabase = loadClient();

      let result: any = null;
      const read = supabase
        .from('accounts')
        .select('id')
        .range(0, 0)
        .then((r) => {
          result = r;
        });
      for (let second = 0; second < 40; second++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      await read;

      // postgrest-js armed its 30 s timeout before supabase-js awaited the
      // token, and the refresh gave up after as long with no session left, so
      // the page arrived signed with the anon key and its signal already
      // aborted. It fails as the timeout, which is what the user reads, and
      // only the refresh ever reached the platform.
      expect({
        message: result?.error?.message,
        hint: result?.error?.hint,
        userReads: describeRequestError(result?.error),
      }).toEqual({
        message: expect.stringMatching(/^AbortError: /),
        hint: 'Request was aborted (timeout or manual cancellation)',
        userReads: 'the request timed out',
      });
      expect(
        platform.mock.calls.map(([input]) => new URL(input as string).pathname)
      ).toEqual(['/auth/v1/token']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still lets auth-js sign in with the anon key, and the next PostgREST request goes out as the user', async () => {
    platform.mockImplementation(async (input: string) =>
      new URL(input).pathname === '/auth/v1/token'
        ? json({
            access_token: ACCESS_TOKEN,
            refresh_token: 'user-refresh-token',
            token_type: 'bearer',
            expires_in: 3600,
            user: STORED_SESSION.user,
          })
        : json([])
    );
    const supabase = loadClient();

    // Signed out, a read is refused before it is sent.
    const before = await supabase.from('accounts').select('id').range(0, 0);
    expect(before.error?.message).toBe(
      'NoSessionError: your sign-in could not be verified'
    );
    expect(platform).not.toHaveBeenCalled();

    // auth-js signs the sign-in with the anon key itself; the path exempts it.
    const { error } = await supabase.auth.signInWithPassword({
      email: 'someone@example.com',
      password: 'password',
    });
    expect(error).toBeNull();
    expect(platform).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = platform.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(new URL(tokenUrl).pathname).toBe('/auth/v1/token');
    expect(authorizationOf(tokenInit)).toBe(`Bearer ${ANON_KEY}`);

    // Signed in, the same read goes out as the user.
    const after = await supabase.from('accounts').select('id').range(0, 0);
    expect(after.error).toBeNull();
    expect(platform).toHaveBeenCalledTimes(2);
    expect(authorizationOf(platform.mock.calls[1][1])).toBe(
      `Bearer ${ACCESS_TOKEN}`
    );
  });
});

describe('the same refusal through a client built with the publishable key (#191)', () => {
  it('built with the publishable key alone, with no session, answers every request shape the engine sends with an error, and sends none of them', async () => {
    // The end state, once the anon key is gone from a build's environment:
    // supabase-js signs a request with no session `Bearer <publishable key>`,
    // which the server answers as the anon role, exactly as it answered the
    // anon key.
    //
    // Also the tripwire for a supabase-js upgrade. Newer versions stop
    // sending a publishable key as the bearer where they judge it unneeded
    // (2.118.0 already does so for Functions: `omitApiKeyAsBearer`). The
    // wrapper sends a PostgREST request only when it carries a user's bearer
    // token, so a request left with no Authorization, an empty one or a bare
    // `Bearer` is refused as this one is (fetchWithTimeout.test.ts). This
    // test goes red only if a version sends such a request past the fetch
    // lib/supabase.ts hands it, which no fetch wrapper can see.
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    await expectEveryShapeRefused(loadClient());
  });

  it('built with both keys, signs in with the publishable key, and the next PostgREST request goes out as the user, the publishable key as its apikey', async () => {
    // Every build in the transition: .env.local and the EAS environments
    // carry both keys, and the publishable key wins.
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    platform.mockImplementation(async (input: string) =>
      new URL(input).pathname === '/auth/v1/token'
        ? json({
            access_token: ACCESS_TOKEN,
            refresh_token: 'user-refresh-token',
            token_type: 'bearer',
            expires_in: 3600,
            user: STORED_SESSION.user,
          })
        : json([])
    );
    const supabase = loadClient();

    // Signed out, a read is refused before it is sent.
    const before = await supabase.from('accounts').select('id').range(0, 0);
    expect(before.error?.message).toBe(
      'NoSessionError: your sign-in could not be verified'
    );
    expect(platform).not.toHaveBeenCalled();

    // auth-js signs the sign-in with the client's key itself; the path
    // exempts it.
    const { error } = await supabase.auth.signInWithPassword({
      email: 'someone@example.com',
      password: 'password',
    });
    expect(error).toBeNull();
    const [tokenUrl, tokenInit] = platform.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(new URL(tokenUrl).pathname).toBe('/auth/v1/token');
    expect({
      apikey: new Headers(tokenInit.headers).get('apikey'),
      authorization: authorizationOf(tokenInit),
    }).toEqual({
      apikey: PUBLISHABLE_KEY,
      authorization: `Bearer ${PUBLISHABLE_KEY}`,
    });

    // Signed in, the same read goes out as the user.
    const after = await supabase.from('accounts').select('id').range(0, 0);
    expect(after.error).toBeNull();
    expect(platform).toHaveBeenCalledTimes(2);
    const readInit = platform.mock.calls[1][1] as RequestInit;
    expect({
      apikey: new Headers(readInit.headers).get('apikey'),
      authorization: authorizationOf(readInit),
    }).toEqual({
      apikey: PUBLISHABLE_KEY,
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  });

  it('built with neither key, fails as it loads, as before', () => {
    // How a build without its environment has always failed: the export's
    // static render and an EAS build's first launch both stop here.
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => loadClient()).toThrow('supabaseKey is required.');
  });
});

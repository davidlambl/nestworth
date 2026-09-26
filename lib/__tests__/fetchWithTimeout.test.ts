import {
  withAnonRestRejection,
  withAuthTokenTimeout,
} from '../fetchWithTimeout';

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
    // A real Request (this jest environment has the fetch globals), whose
    // `.url` is all the wrapper reads.
    const request = new Request(TOKEN_URL, { method: 'POST' });

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
    // Never sent: racing it instead would let a fast-resolving baseFetch that
    // ignores the signal win over the already-aborted one.
    expect(base).not.toHaveBeenCalled();
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

  // A Request's own signal counts as the caller's, by the rule
  // withAnonRestRejection uses: init's when init names one, else the
  // Request's (#129). Read from init alone, a token Request's own signal was
  // replaced by the wrapper's: already aborted, it was sent anyway, and
  // aborted later, it cancelled nothing. auth-js sends string URLs, so no app
  // request takes this path. Both assert before awaiting the call, since the
  // regression leaves it pending until the deadline.
  it('never sends a token Request whose own signal has already aborted (#129)', async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );
    const controller = new AbortController();
    controller.abort();
    const request = new Request(TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
    });

    let err: unknown = null;
    const settled = wrapped(request).catch((e) => {
      err = e;
    });
    await jest.advanceTimersByTimeAsync(0);

    expect({
      name: (err as Error | null)?.name,
      sent: base.mock.calls.length,
      timers: jest.getTimerCount(),
    }).toEqual({ name: 'AbortError', sent: 0, timers: 0 });
    await settled;
  });

  it('cancels a token Request when its own signal aborts before the deadline (#129)', async () => {
    const base = neverSettles();
    const wrapped = withAuthTokenTimeout(
      base as unknown as typeof fetch,
      TIMEOUT_MS
    );
    const controller = new AbortController();
    const request = new Request(TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
    });

    let err: unknown = null;
    const settled = wrapped(request).catch((e) => {
      err = e;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);

    // The signal the platform was handed is the wrapper's, and it aborted.
    expect({
      name: (err as Error | null)?.name,
      platformAborted: base.mock.calls[0]?.[1]?.signal?.aborted,
      timers: jest.getTimerCount(),
    }).toEqual({ name: 'AbortError', platformAborted: true, timers: 0 });
    await settled;
  });
});

describe('withAnonRestRejection refuses a PostgREST request signed with the anon key (#109)', () => {
  // A legacy anon key is a JWT like a user's access token, and the two share
  // their first segment, so the wrapper compares the whole `Bearer <key>`
  // value: a prefix or a substring would match a user's token.
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
  const USER_TOKEN =
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.user-signature';
  const ANON = `Bearer ${ANON_KEY}`;
  const REST_UPDATE_URL =
    'https://project.supabase.co/rest/v1/accounts?id=eq.a1&deleted_at=is.null';

  /**
   * What reaches the wrapper for a PostgREST call: supabase-js's authed fetch
   * copies postgrest-js's headers into a Headers instance and sets `apikey`
   * (always the anon key) and `Authorization` (the access token, else the
   * anon key) before calling it with a string URL.
   */
  function restInit(authorization: string, method = 'GET'): RequestInit {
    return {
      method,
      headers: new Headers({ apikey: ANON_KEY, Authorization: authorization }),
    };
  }

  /**
   * React Native's Headers, the whatwg-fetch polyfill: `get` hands a value back
   * as it was set, untrimmed, where the web's and Node's trim its ends.
   */
  function untrimmedHeaders(values: Record<string, string>): Headers {
    const byName = new Map(
      Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])
    );
    return {
      get: (name: string) => byName.get(name.toLowerCase()) ?? null,
    } as unknown as Headers;
  }

  /** The error a call rejected with; fails the test if it resolved. */
  async function refusal(call: Promise<unknown>): Promise<Error> {
    try {
      await call;
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected the request to be refused');
  }

  it('refuses a /rest/v1/ request whose Authorization is the anon key, without calling fetch', async () => {
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    // A read, and the tombstone UPDATE a push sends.
    for (const [url, method] of [
      [REST_URL, 'GET'],
      [REST_UPDATE_URL, 'PATCH'],
    ]) {
      const err = await refusal(wrapped(url, restInit(ANON, method)));
      expect(err).toBeInstanceOf(Error);
      // The name and the words are a contract with lib/sync.ts's own
      // NoSessionError and with lib/requestError.ts, which passes both through.
      expect({ name: err.name, message: err.message }).toEqual({
        name: 'NoSessionError',
        message: 'your sign-in could not be verified',
      });
    }
    // Never sent. Sent, RLS answers the read `200 []` and the UPDATE with zero
    // matched rows, and both read as success.
    expect(base).not.toHaveBeenCalled();
  });

  it('passes a /rest/v1/ request signed with a user token through untouched', async () => {
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    // Every request carries the anon key as `apikey`; only Authorization says
    // who signed it. The last two are built to contain the anon key, at
    // either end, without being it.
    const tokens = [
      USER_TOKEN,
      `${ANON_KEY}.${USER_TOKEN}`,
      `${USER_TOKEN}.${ANON_KEY}`,
    ];
    for (const token of tokens) {
      const init = restInit(`Bearer ${token}`);
      await wrapped(REST_URL, init);
      const [passedInput, passedInit] = base.mock.calls.at(-1) as [
        string,
        RequestInit,
      ];
      expect(passedInput).toBe(REST_URL);
      expect(passedInit).toBe(init);
    }
    expect(base).toHaveBeenCalledTimes(tokens.length);
  });

  it('passes auth and Storage through even when signed with the anon key', async () => {
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    // auth-js signs sign-in, sign-up and the refresh with the anon key itself
    // (as a plain object), and Storage goes through the same authed fetch as
    // PostgREST. The path exempts them, whatever the header says.
    const requests: [string, RequestInit][] = [
      [TOKEN_URL, { method: 'POST', headers: { Authorization: ANON } }],
      [
        'https://project.supabase.co/auth/v1/token?grant_type=password',
        { method: 'POST', headers: { Authorization: ANON } },
      ],
      [
        'https://project.supabase.co/auth/v1/signup',
        { method: 'POST', headers: { Authorization: ANON } },
      ],
      [LOGOUT_URL, { method: 'POST', headers: { Authorization: ANON } }],
      [
        'https://project.supabase.co/auth/v1/user',
        { headers: { Authorization: ANON } },
      ],
      [STORAGE_URL, restInit(ANON, 'POST')],
    ];
    for (const [url, init] of requests) {
      await wrapped(url, init);
      const [passedInput, passedInit] = base.mock.calls.at(-1) as [
        string,
        RequestInit,
      ];
      expect(passedInput).toBe(url);
      expect(passedInit).toBe(init);
    }
    expect(base).toHaveBeenCalledTimes(requests.length);
  });

  it('reads the Authorization header in every shape fetch accepts', async () => {
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    const shapes: [string, RequestInfo | URL, RequestInit | undefined][] = [
      ['a Headers instance', REST_URL, restInit(ANON)],
      ['a plain object', REST_URL, { headers: { Authorization: ANON } }],
      [
        'a plain object, lower case',
        REST_URL,
        { headers: { authorization: ANON } },
      ],
      [
        'a plain object, upper case',
        REST_URL,
        { headers: { AUTHORIZATION: ANON } },
      ],
      [
        'an array of pairs',
        REST_URL,
        {
          headers: [
            ['apikey', ANON_KEY],
            ['authorization', ANON],
          ],
        },
      ],
      [
        'a URL object for the input',
        new URL(REST_URL),
        { headers: { Authorization: ANON } },
      ],
      // A Request carries its own headers, which fetch uses when init brings none.
      [
        "a Request's own headers, no init",
        new Request(REST_URL, { headers: { Authorization: ANON } }),
        undefined,
      ],
      [
        "a Request's own headers, init without headers",
        new Request(REST_URL, { headers: { Authorization: ANON } }),
        { method: 'GET' },
      ],
    ];
    for (const [shape, input, init] of shapes) {
      const err = await refusal(wrapped(input, init));
      expect([shape, err.name]).toEqual([shape, 'NoSessionError']);
    }
    expect(base).not.toHaveBeenCalled();

    // Headers in init REPLACE a Request's own, so a user-signed init over an
    // anon-signed Request is what goes out, and goes out.
    const request = new Request(REST_URL, { headers: { Authorization: ANON } });
    const init = { headers: { Authorization: `Bearer ${USER_TOKEN}` } };
    await wrapped(request, init);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0][0]).toBe(request);
    expect(base.mock.calls[0][1]).toBe(init);
  });

  it('passes a /rest/v1/ request with no Authorization header through', async () => {
    // Only what can be seen to be anon-signed is refused. supabase-js always
    // sets Authorization, so this is no request the app sends; it pins that
    // the wrapper does not refuse by path alone, nor by `apikey`.
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    const inits: (RequestInit | undefined)[] = [
      undefined,
      {},
      { headers: { apikey: ANON_KEY } },
      { headers: new Headers({ apikey: ANON_KEY }) },
    ];
    for (const init of inits) {
      await wrapped(REST_URL, init);
      expect(base.mock.calls.at(-1)?.[1]).toBe(init);
    }
    expect(base).toHaveBeenCalledTimes(inits.length);
  });

  it('never refuses anything when the configured key is empty', async () => {
    // An empty key is nobody's signature. supabase-js would sign with
    // `Bearer ` (or `Bearer ` and some whitespace), which fetch trims to
    // `Bearer`: none of it may match.
    const base = ok();
    const inits: RequestInit[] = [
      { headers: new Headers({ Authorization: 'Bearer ' }) },
      { headers: { Authorization: 'Bearer ' } },
      { headers: { Authorization: 'Bearer' } },
      { headers: { Authorization: `Bearer ${USER_TOKEN}` } },
    ];
    for (const key of ['', ' \n']) {
      const wrapped = withAnonRestRejection(
        base as unknown as typeof fetch,
        key
      );
      for (const init of inits) {
        await wrapped(REST_URL, init);
      }
    }
    expect(base).toHaveBeenCalledTimes(inits.length * 2);
  });

  it('compares the header as fetch sends it, ends trimmed, against the configured key read the same way', async () => {
    // A key pasted with a trailing newline (a CI secret, say) reaches the
    // header without it: Headers trims a value's ends. Compared untrimmed, the
    // refusal would silently never fire.
    const base = ok();
    const newline = withAnonRestRejection(
      base as unknown as typeof fetch,
      `${ANON_KEY}\n`
    );
    const inits: [string, RequestInit][] = [
      [
        'a Headers instance',
        { headers: new Headers({ Authorization: `Bearer ${ANON_KEY}\n` }) },
      ],
      [
        "React Native's Headers, which do not trim",
        {
          headers: untrimmedHeaders({ Authorization: `Bearer ${ANON_KEY}\n` }),
        },
      ],
      ['a plain object', { headers: { Authorization: `${ANON} \t` } }],
      ['an array of pairs', { headers: [['Authorization', ` ${ANON}`]] }],
    ];
    for (const [shape, init] of inits) {
      const err = await refusal(newline(REST_URL, init));
      expect([shape, err.name]).toEqual([shape, 'NoSessionError']);
    }

    // Only the ends: a key's own leading space is inside supabase-js's
    // `Bearer ${key}`, so the header it signs with keeps both spaces.
    const leading = withAnonRestRejection(
      base as unknown as typeof fetch,
      ` ${ANON_KEY}`
    );
    const err = await refusal(
      leading(REST_URL, {
        headers: new Headers({ Authorization: `Bearer  ${ANON_KEY}` }),
      })
    );
    expect(err.name).toBe('NoSessionError');
    expect(base).not.toHaveBeenCalled();
  });

  it('rejects a request it would refuse whose signal has already aborted with the AbortError fetch would give it', async () => {
    // A page whose own token refresh stalled: postgrest-js's 30 s timeout has
    // fired by the time the page, left signed with the anon key, gets here.
    // It must read as the timeout it is, and it is not sent either way.
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );

    // abort() without a reason makes the signal's reason a DOMException named
    // AbortError, and that is what fetch rejects with, so it is thrown as is.
    const controller = new AbortController();
    controller.abort();
    const err = await refusal(
      wrapped(REST_URL, { ...restInit(ANON), signal: controller.signal })
    );
    expect(err).toBe(controller.signal.reason);
    expect(err.name).toBe('AbortError');

    // An AbortSignal that carries no reason, as on older platforms.
    const reasonless = { aborted: true } as unknown as AbortSignal;
    const bare = await refusal(
      wrapped(REST_URL, { ...restInit(ANON), signal: reasonless })
    );
    expect({ name: bare.name, isError: bare instanceof Error }).toEqual({
      name: 'AbortError',
      isError: true,
    });
    expect(base).not.toHaveBeenCalled();

    // A request the wrapper does not refuse goes on as before, aborted or not,
    // for fetch itself to reject.
    const init = {
      ...restInit(`Bearer ${USER_TOKEN}`),
      signal: controller.signal,
    };
    await wrapped(REST_URL, init);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0][1]).toBe(init);
  });

  it("takes a Request's own aborted signal, as fetch does, when init names none (#129)", async () => {
    // The web's fetch (WHATWG) takes the signal from init when init names
    // one, null included (which drops a Request's own), and otherwise from
    // the Request. The wrapper read init's alone, so an anon-signed Request
    // carrying its own aborted signal was refused as a missing session where
    // fetch would have reported the abort. supabase-js never sends a Request;
    // the rule is the web's, and the wrapper keeps it. React Native's
    // whatwg-fetch differs for a null init signal alone (it keeps the
    // Request's own), a case no app request reaches.
    const base = ok();
    const wrapped = withAnonRestRejection(
      base as unknown as typeof fetch,
      ANON_KEY
    );
    const aborted = new AbortController();
    aborted.abort();
    const live = new AbortController();
    const anonRequest = (signal: AbortSignal) =>
      new Request(REST_URL, { headers: { Authorization: ANON }, signal });

    // The regression. A Request follows the signal it is given (its own is a
    // new signal, aborted with the same reason), and fetch rejects with that
    // reason. An init signal that is undefined names none, as for fetch.
    const initsNamingNone: [string, RequestInit | undefined][] = [
      ['no init', undefined],
      ['an init without a signal', { method: 'GET' }],
      ['an init whose signal is undefined', { signal: undefined }],
    ];
    for (const [shape, init] of initsNamingNone) {
      const err = await refusal(wrapped(anonRequest(aborted.signal), init));
      expect({
        shape,
        name: err.name,
        reason: err === aborted.signal.reason,
      }).toEqual({ shape, name: 'AbortError', reason: true });
    }

    // Pins, green before the fix too: a signal init names replaces the
    // Request's own, whichever of the two has aborted, and null drops it (the
    // web's rule; whatwg-fetch would keep it, see above).
    const initsNamingOne: [string, AbortSignal, RequestInit, string][] = [
      [
        'null over an aborted Request',
        aborted.signal,
        { signal: null },
        'NoSessionError',
      ],
      [
        'live over an aborted Request',
        aborted.signal,
        { signal: live.signal },
        'NoSessionError',
      ],
      [
        'aborted over a live Request',
        live.signal,
        { signal: aborted.signal },
        'AbortError',
      ],
    ];
    for (const [shape, requestSignal, init, name] of initsNamingOne) {
      const err = await refusal(wrapped(anonRequest(requestSignal), init));
      expect([shape, err.name]).toEqual([shape, name]);
    }
    expect(base).not.toHaveBeenCalled();
  });

  it('composes with withAuthTokenTimeout as lib/supabase.ts wires them', async () => {
    const base = neverSettles();
    const wrapped = withAnonRestRejection(
      withAuthTokenTimeout(base as unknown as typeof fetch, TIMEOUT_MS),
      ANON_KEY
    );

    // A refused request goes no further: nothing sent, no deadline armed.
    const err = await refusal(wrapped(REST_URL, restInit(ANON)));
    expect(err.name).toBe('NoSessionError');
    expect(base).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    // The refresh auth-js signs with the anon key passes the outer wrapper and
    // is still bounded by the inner one.
    let tokenErr: unknown;
    const settled = wrapped(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: ANON },
    }).catch((e) => {
      tokenErr = e;
    });
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await settled;
    expect((tokenErr as Error).name).toBe('AbortError');
    expect(base).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    // A user-signed PostgREST request goes through both untouched (the base
    // never answers, so only the call it received is checked).
    const init = restInit(`Bearer ${USER_TOKEN}`);
    void wrapped(REST_URL, init);
    await jest.advanceTimersByTimeAsync(0);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1][0]).toBe(REST_URL);
    expect(base.mock.calls[1][1]).toBe(init);
    expect(jest.getTimerCount()).toBe(0);
  });
});

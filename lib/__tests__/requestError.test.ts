import { describeRequestError } from '../requestError';

describe('describeRequestError', () => {
  it('collapses the shape postgrest-js reports for a timed-out request', () => {
    // What a request aborted by db.timeout actually looks like: postgrest-js
    // builds `message` from the fetch error's NAME and message, and there is no
    // `code` to key off (it deliberately clears it for aborts).
    expect(
      describeRequestError({
        message: 'AbortError: The operation was aborted',
        details: 'AbortError: The operation was aborted',
        hint: 'Request was aborted (timeout or manual cancellation)',
        code: '',
      })
    ).toBe('the request timed out');
  });

  it('matches on the error name too', () => {
    // A DOMException from a caller's own AbortSignal: the name carries the
    // signal, the message does not have to.
    expect(
      describeRequestError({
        name: 'AbortError',
        message: 'signal is aborted without reason',
      })
    ).toBe('the request timed out');
  });

  it('matches a server-side statement timeout', () => {
    expect(
      describeRequestError({
        message: 'canceling statement due to statement timeout',
        code: '57014',
      })
    ).toBe('the request timed out');
  });

  it('keeps a server message that says something actionable', () => {
    // The point of not flattening everything: these are the messages worth
    // showing, and the reset probe and the reset download both show them.
    expect(
      describeRequestError({
        message: 'new row violates row-level security policy',
        code: '42501',
      })
    ).toBe('new row violates row-level security policy');
    expect(describeRequestError(new Error('JWT expired'))).toBe('JWT expired');
  });

  it('collapses the shape postgrest-js reports for a request that never reached a server', () => {
    // postgrest-js 2.101.1 catches the fetch rejection and builds `message`
    // from its NAME and message; `code` stays empty, and `hint` is set only for
    // aborts. What every offline pull returns, one per table (#66).
    expect(
      describeRequestError({
        message: 'TypeError: Failed to fetch',
        details: 'TypeError: Failed to fetch\n    at fetch (<anonymous>)',
        hint: '',
        code: '',
      })
    ).toBe('the network is unavailable');
  });

  it('matches a bare fetch rejection too', () => {
    expect(describeRequestError(new TypeError('Failed to fetch'))).toBe(
      'the network is unavailable'
    );
  });

  it("matches React Native's wording", () => {
    expect(
      describeRequestError({
        message: 'TypeError: Network request failed',
        code: '',
      })
    ).toBe('the network is unavailable');
  });

  it.each([
    ['Safari / WebKit', 'Load failed'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['Node (undici)', 'fetch failed'],
  ])("matches %s's wording", (_platform, text) => {
    expect(
      describeRequestError({ message: `TypeError: ${text}`, code: '' })
    ).toBe('the network is unavailable');
  });

  it('still reads a timeout as a timeout when it also looks unreachable', () => {
    expect(
      describeRequestError({ name: 'AbortError', message: 'Failed to fetch' })
    ).toBe('the request timed out');
  });

  it('does not take every TypeError, or every failed upload, for a missing network', () => {
    // A bug is a TypeError too, and "upload failed" contains WebKit's phrase in
    // lower case: only the platforms' own wording, exactly, counts.
    expect(
      describeRequestError(
        new TypeError("Cannot read properties of undefined (reading 'id')")
      )
    ).toBe("Cannot read properties of undefined (reading 'id')");
    expect(
      describeRequestError({ message: 'Storage upload failed', code: '500' })
    ).toBe('Storage upload failed');
  });

  it('passes a NoSessionError message through unchanged', () => {
    // lib/sync.ts reports a read that came back empty from a client with no
    // session as its own error (#95), and the user reads it as "Couldn't
    // download <table>: " plus this mapper's reading of it. The message is
    // already copy, built with this mapper: "timed out" is not "timeout", and
    // it names no network failure in any platform's words. Red only if the
    // patterns above are widened far enough to swallow it.
    for (const message of [
      'your sign-in could not be renewed (the request timed out)',
      'your sign-in could not be renewed (the network is unavailable)',
      'your sign-in could not be renewed (the sign-in service is unavailable)',
      'your sign-in could not be verified',
    ]) {
      const error = Object.assign(new Error(message), {
        name: 'NoSessionError',
      });
      expect(describeRequestError(error)).toBe(message);
    }
  });

  it.each([
    [
      'a 503, as auth-js throws it',
      { name: 'AuthRetryableFetchError', message: '{}', status: 503 },
    ],
    ['a 502', { name: 'AuthRetryableFetchError', message: '{}', status: 502 }],
    ['a 504', { name: 'AuthRetryableFetchError', message: '{}', status: 504 }],
    // Either half of the shape is enough on its own.
    [
      'a gateway status with words of its own',
      { name: 'AuthApiError', message: 'Service Unavailable', status: 503 },
    ],
    ['a bare "{}" with no status', { message: '{}' }],
  ])('describes %s from the auth server as the sign-in service', (_, error) => {
    // auth-js builds a 502/503/504's message from the Response itself, and
    // JSON.stringify(response) is "{}" whatever the body said (#95), so the
    // user read "Couldn't renew your sign-in: {}" and a sign-in form of "{}".
    expect(describeRequestError(error)).toBe(
      'the sign-in service is unavailable'
    );
  });

  it('keeps the words of a PostgREST-shaped error that carries a gateway status', () => {
    // postgrest-js hands back a non-ok response's parsed body as its `error`,
    // so a gateway's JSON with a `status` key would arrive like this. Only
    // auth-js's own errors are the sign-in service's.
    expect(
      describeRequestError({ status: 503, message: 'upstream unavailable' })
    ).toBe('upstream unavailable');
  });

  it('keeps the words of an auth error that is not a gateway error', () => {
    // A 500 is an AuthApiError carrying the server's own message; auth-js
    // treats it as final, not retryable, and that message is worth reading.
    expect(
      describeRequestError({
        name: 'AuthApiError',
        message: 'Database error granting user',
        status: 500,
      })
    ).toBe('Database error granting user');
  });

  it('falls back to String(error) when there is no message', () => {
    expect(describeRequestError('offline')).toBe('offline');
    expect(describeRequestError(undefined)).toBe('undefined');
    expect(describeRequestError(null)).toBe('null');
    expect(describeRequestError({ code: 'PGRST301' })).toBe('[object Object]');
  });
});

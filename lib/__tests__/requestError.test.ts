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

  it('falls back to String(error) when there is no message', () => {
    expect(describeRequestError('offline')).toBe('offline');
    expect(describeRequestError(undefined)).toBe('undefined');
    expect(describeRequestError(null)).toBe('null');
    expect(describeRequestError({ code: 'PGRST301' })).toBe('[object Object]');
  });
});

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

  it('falls back to String(error) when there is no message', () => {
    expect(describeRequestError('offline')).toBe('offline');
    expect(describeRequestError(undefined)).toBe('undefined');
    expect(describeRequestError(null)).toBe('null');
    expect(describeRequestError({ code: 'PGRST301' })).toBe('[object Object]');
  });
});

// The client is built at module scope, so the only way to see how it is
// configured is to load the module with `createClient` mocked — jest hoists the
// mock above the imports below, and a bare `{}` is enough because the assertion
// is about the options object `createClient` was handed, not about the client.
//
// Why pin this at all: before #67 nothing in the app had a request timeout, so a
// stalled socket (a phone holding a dead connection open after a network change)
// left a sync — and everything awaiting the sync lock — waiting forever.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

import { createClient } from '@supabase/supabase-js';
// Side-effect import: loading the module IS the thing under test.
import '../supabase';

const mockedCreateClient = createClient as unknown as jest.Mock;

function clientOptions(): {
  db?: { timeout?: number };
  global?: { fetch?: typeof fetch };
} {
  expect(mockedCreateClient).toHaveBeenCalledTimes(1);
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
});

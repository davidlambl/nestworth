// Sign-in is bounded by the same deadline as every other request, because
// /auth/v1/token serves `grant_type=password` too (lib/fetchWithTimeout.ts). So
// on a dead connection signInWithPassword returns an AuthRetryableFetchError
// whose message is the wrapper's own "Auth token request aborted after 30000ms",
// and app/(auth)/sign-in.tsx renders `error.message` verbatim under the form.
// The mapper has to reach this copy too, without touching the auth messages that
// are worth reading.
//
// Recipe from lib/__tests__/useReorderAccounts.test.ts: react-test-renderer and
// createElement, so no JSX is needed in a .ts test.
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
    },
  },
}));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { supabase } from '../supabase';
import { AuthProvider, useAuth } from '../auth';

const auth = supabase.auth as unknown as {
  signInWithPassword: jest.Mock;
  signUp: jest.Mock;
};

const TIMED_OUT = {
  name: 'AuthRetryableFetchError',
  message: 'Auth token request aborted after 30000ms',
  status: 0,
};

let api: ReturnType<typeof useAuth>;
let renderer: ReactTestRenderer;

function Probe() {
  const value = useAuth();
  // Captured in an effect, not during render: assigning to an outer variable
  // while rendering is a side effect the React Compiler rules reject.
  useEffect(() => {
    api = value;
  });
  return null;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(AuthProvider, null, createElement(Probe))
    );
  });
});

afterEach(() => {
  act(() => {
    renderer.unmount();
  });
});

describe('the sign-in screen describes a timed-out request like everywhere else', () => {
  it('maps a timed-out sign-in', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: TIMED_OUT });

    const { error } = await api.signIn('user@example.com', 'hunter2');

    expect(error?.message).toBe('the request timed out');
  });

  it('maps a timed-out sign-up', async () => {
    auth.signUp.mockResolvedValue({ error: TIMED_OUT });

    const { error } = await api.signUp('user@example.com', 'hunter2');

    expect(error?.message).toBe('the request timed out');
  });

  it('maps the auth server answering 503, which auth-js words as "{}"', async () => {
    // auth-js builds a 502/503/504's message from the Response object, and
    // JSON.stringify(response) is "{}" — which the form showed verbatim.
    auth.signInWithPassword.mockResolvedValue({
      error: { name: 'AuthRetryableFetchError', message: '{}', status: 503 },
    });

    const { error } = await api.signIn('user@example.com', 'hunter2');

    expect(error?.message).toBe('the sign-in service is unavailable');
  });

  it('leaves a real auth message alone', async () => {
    // The one the user most needs to read: flattening this to a timeout would be
    // a worse bug than the raw AbortError string.
    auth.signInWithPassword.mockResolvedValue({
      error: { name: 'AuthApiError', message: 'Invalid login credentials' },
    });

    const { error } = await api.signIn('user@example.com', 'wrong');

    expect(error?.message).toBe('Invalid login credentials');
  });

  it('reports no error when the sign-in succeeds', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });

    const { error } = await api.signIn('user@example.com', 'hunter2');

    expect(error).toBeNull();
  });
});

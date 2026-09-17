// Cause 1 of #55: auth-js hands out a fresh User object on every auth event
// (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, ...). useSyncEngine's effect
// used to be keyed on that object, so it was torn down and re-run
// mid-bootstrap on nearly every launch. The engine now survives that, but a
// session per auth event is still the wrong shape; this pins the key to the
// user id. syncLockQueue.test.ts drives startSyncSession directly and cannot
// see the hook.
jest.mock('@react-native-community/netinfo', () =>
  jest.requireActual('@react-native-community/netinfo/jest/netinfo-mock.js')
);
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

let mockUser: { id: string } | null = null;
jest.mock('../auth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../sync', () => ({
  startSyncSession: jest.fn(() => Promise.resolve()),
  fullSync: jest.fn(() => Promise.resolve()),
}));

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SyncProvider } from '../query';
import { startSyncSession } from '../sync';

const startMock = startSyncSession as unknown as jest.Mock;

describe('useSyncEngine', () => {
  it('starts one sync session per user id, not per User object', async () => {
    mockUser = { id: 'u1' };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(SyncProvider, null));
    });
    expect(startMock).toHaveBeenCalledTimes(1);

    // TOKEN_REFRESHED: a new object for the same user.
    mockUser = { id: 'u1' };
    await act(async () => {
      renderer.update(createElement(SyncProvider, null));
    });
    expect(startMock).toHaveBeenCalledTimes(1);

    // A different user is a new session.
    mockUser = { id: 'u2' };
    await act(async () => {
      renderer.update(createElement(SyncProvider, null));
    });
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(startMock.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2']);

    await act(async () => {
      renderer.unmount();
    });
  });
});

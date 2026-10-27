// The biometric lock's reads at launch. The hook reads two things once, when
// it mounts: whether this device can lock (biometric hardware with a face or
// finger enrolled) and the saved switch. With the switch on, the app locks
// when the read answers -- app/_layout.tsx shows LockScreen while isLocked --
// and on web nothing is read and nothing locks. #41 moved the two readers out of the
// hook, so no state is set in the effect's own body; these tests are pins
// (they pass before and after that change) for what the lock screen relies
// on. The lock screen and the Settings switch themselves are verified on a
// device.
//
// react-native is mocked down to `Platform`, as in formError.test.ts, so each
// test can set `OS`; the two Expo modules are mocked whole.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useBiometricLock } from '../hooks/useBiometricLock';

// The mocked module object itself, the one the hook reads at each call.
const rn = jest.requireMock('react-native') as { Platform: { OS: string } };
const hasHardware = LocalAuthentication.hasHardwareAsync as jest.Mock;
const isEnrolled = LocalAuthentication.isEnrolledAsync as jest.Mock;
const getItem = SecureStore.getItemAsync as jest.Mock;

let lock: ReturnType<typeof useBiometricLock>;
let renderer: ReactTestRenderer | undefined;

function Harness() {
  const value = useBiometricLock();
  useEffect(() => {
    lock = value;
  });
  return null;
}

/** Lets the reads answer and their state reach the harness. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness));
  });
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  rn.Platform.OS = 'ios';
  hasHardware.mockResolvedValue(true);
  isEnrolled.mockResolvedValue(true);
  getItem.mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

describe('useBiometricLock at mount', () => {
  it('opens locked when the saved switch is on, reading each thing once', async () => {
    getItem.mockResolvedValue('true');

    await mount();

    expect(lock.isAvailable).toBe(true);
    expect(lock.isEnabled).toBe(true);
    expect(lock.isLocked).toBe(true);
    expect(hasHardware).toHaveBeenCalledTimes(1);
    expect(isEnrolled).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledWith('biometric_lock_enabled');
  });

  it('does not read again when the screen renders again', async () => {
    getItem.mockResolvedValue('true');
    await mount();

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        renderer!.update(createElement(Harness));
      });
    }
    await settle();

    expect(hasHardware).toHaveBeenCalledTimes(1);
    expect(isEnrolled).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(lock.isLocked).toBe(true);
  });

  it('opens unlocked when the switch is off or was never set', async () => {
    getItem.mockResolvedValue('false');
    await mount();
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(lock.isEnabled).toBe(false);
    expect(lock.isLocked).toBe(false);

    act(() => {
      renderer!.unmount();
    });
    getItem.mockResolvedValue(null);
    await mount();
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(lock.isEnabled).toBe(false);
    expect(lock.isLocked).toBe(false);
  });

  it('treats a switch it cannot read as off, and handles the failure', async () => {
    getItem.mockRejectedValue(new Error('keychain unavailable'));

    await mount();

    // The read was made and failed; the switch reads as off and the app opens
    // unlocked. Off and unlocked are also where the hook starts, so these
    // values cannot show that the failure was handled: jest does, by failing
    // this test with the read's error when the rejection goes unhandled.
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(lock.isEnabled).toBe(false);
    expect(lock.isLocked).toBe(false);
    expect(lock.isAvailable).toBe(true);
  });

  it('is not available without enrolled biometrics', async () => {
    isEnrolled.mockResolvedValue(false);

    await mount();

    expect(isEnrolled).toHaveBeenCalledTimes(1);
    expect(lock.isAvailable).toBe(false);
  });

  it('reads nothing on web and never locks', async () => {
    rn.Platform.OS = 'web';
    getItem.mockResolvedValue('true');

    await mount();

    expect(hasHardware).not.toHaveBeenCalled();
    expect(isEnrolled).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(lock.isAvailable).toBe(false);
    expect(lock.isEnabled).toBe(false);
    expect(lock.isLocked).toBe(false);
  });
});

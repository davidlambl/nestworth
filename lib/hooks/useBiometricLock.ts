import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'biometric_lock_enabled';

// Whether this device can lock: biometric hardware with a face or finger
// enrolled. Never on web. A check that fails reads as unavailable, with one
// warning, instead of an unhandled rejection (#225).
async function readAvailability(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return compatible && enrolled;
  } catch (e) {
    console.warn(
      '[biometric] availability read failed:',
      e instanceof Error ? e.message : String(e)
    );
    return false;
  }
}

// The saved switch; off when it cannot be read. Never on web.
async function readEnabled(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    const val = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    return val === 'true';
  } catch {
    return false;
  }
}

/**
 * The biometric lock. `isAvailable`: whether this device can lock (the
 * Settings switch is shown only then). `isEnabled`: the saved switch, which
 * `toggle` turns on only after the user authenticates. `isLocked`: whether
 * the app is locked now, which `unlock` ends; the lock engages at launch,
 * when the saved switch is read, not when it is turned on.
 *
 * `isLocked` is null until the saved switch has answered (#225): unknown, so
 * the root layout draws nothing and keeps the splash up, and the app's
 * screens are never drawn under a lock that has not engaged yet. On web
 * there is no lock and nothing is read, so it is false from the first render
 * and the first paint is never held. Each caller reads for itself; the root
 * layout's is the one that locks.
 */
export function useBiometricLock() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState<boolean | null>(() =>
    Platform.OS === 'web' ? false : null
  );
  const [isAvailable, setIsAvailable] = useState(false);

  // Read once, at mount; the saved switch's answer ends the unknown state:
  // on locks the app, off (or unreadable) opens it. The readers live outside
  // the hook and the state is set when each answers, never in the effect's
  // own body (#41).
  useEffect(() => {
    void readAvailability().then(setIsAvailable);
    void readEnabled().then((enabled) => {
      setIsEnabled(enabled);
      setIsLocked(enabled);
    });
  }, []);

  const toggle = async () => {
    if (Platform.OS === 'web') {
      return;
    }
    const newVal = !isEnabled;
    if (newVal) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to enable biometric lock',
        fallbackLabel: 'Use passcode',
      });
      if (!result.success) {
        return;
      }
    }
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, String(newVal));
    setIsEnabled(newVal);
    if (!newVal) {
      setIsLocked(false);
    }
  };

  const unlock = useCallback(async () => {
    if (Platform.OS === 'web') {
      setIsLocked(false);
      return true;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Nestworth',
      fallbackLabel: 'Use passcode',
    });
    if (result.success) {
      setIsLocked(false);
    }
    return result.success;
  }, []);

  return { isEnabled, isLocked, isAvailable, toggle, unlock };
}

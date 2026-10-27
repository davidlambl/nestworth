import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'biometric_lock_enabled';

// Whether this device can lock: biometric hardware with a face or finger
// enrolled. Never on web.
async function readAvailability(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }
  const compatible = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  return compatible && enrolled;
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

export function useBiometricLock() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);

  // Read once, at mount; with the saved switch on, the app locks when the
  // read answers. The readers live outside the hook and the state is set
  // when each answers, never in the effect's own body (#41).
  useEffect(() => {
    void readAvailability().then(setIsAvailable);
    void readEnabled().then((enabled) => {
      setIsEnabled(enabled);
      if (enabled) {
        setIsLocked(true);
      }
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

import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'biometric_lock_enabled';

export function useBiometricLock() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);

  useEffect(() => {
    checkAvailability();
    loadSetting();
  }, []);

  const checkAvailability = async () => {
    if (Platform.OS === 'web') {
      setIsAvailable(false);
      return;
    }
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    setIsAvailable(compatible && enrolled);
  };

  const loadSetting = async () => {
    if (Platform.OS === 'web') {
      return;
    }
    try {
      const val = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      const enabled = val === 'true';
      setIsEnabled(enabled);
      if (enabled) {
        setIsLocked(true);
      }
    } catch {
      setIsEnabled(false);
    }
  };

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

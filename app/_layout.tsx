import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { AuthProvider } from '@/lib/auth';
import { QueryProvider } from '@/lib/query';
import { useRealtimeSync } from '@/lib/hooks/useRealtimeSync';
import { useBiometricLock } from '@/lib/hooks/useBiometricLock';
import { LockScreen } from '@/components/LockScreen';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) {
      throw error;
    }
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <QueryProvider>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </QueryProvider>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  useRealtimeSync();
  const { isLocked, unlock } = useBiometricLock();

  if (isLocked) {
    return <LockScreen onUnlock={unlock} />;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen
          name="account/[id]"
          options={{ title: 'Register', headerBackTitle: 'Accounts' }}
        />
        <Stack.Screen
          name="account/reconcile"
          options={{ title: 'Reconcile', presentation: 'modal' }}
        />
        <Stack.Screen
          name="transaction/new"
          options={{ title: 'New Transaction', presentation: 'modal' }}
        />
        <Stack.Screen
          name="transaction/[id]"
          options={{ title: 'Edit Transaction', presentation: 'modal' }}
        />
        <Stack.Screen
          name="transaction/transfer"
          options={{ title: 'Transfer', presentation: 'modal' }}
        />
        <Stack.Screen
          name="recurring/index"
          options={{ title: 'Recurring Transactions' }}
        />
        <Stack.Screen
          name="recurring/new"
          options={{ title: 'New Recurring Rule', presentation: 'modal' }}
        />
      </Stack>
    </ThemeProvider>
  );
}

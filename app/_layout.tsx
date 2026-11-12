import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type { NativeStackNavigationOptions } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { AppThemeProvider } from '@/lib/theme';
import { AuthProvider } from '@/lib/auth';
import { QueryProvider, SyncProvider } from '@/lib/query';
import { useRealtimeSync } from '@/lib/hooks/useRealtimeSync';
import { useBiometricLock } from '@/lib/hooks/useBiometricLock';
import { sheetHeaderOptions, stackScreenOptions } from '@/lib/stackHeader';
import { LockScreen } from '@/components/LockScreen';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  anchor: '(tabs)',
};

// The navigation theme with the app's tint as its primary colour: on iOS the
// native back button takes the navigation bar's tint, which is the theme's
// primary unless a screen sets headerTintColor, and the default primary is the
// system blue. The app's own back button (#50, removed by #51) was drawn in
// the tint, like the other header controls. The JS tab bar and its headers
// (web, the desktop app) set their own colours; on iOS each tab's Stack takes
// this one like a pushed screen (#248), and the system's tabs their tint
// (components/NativeAppTabs.ios.tsx).
const NAVIGATION_THEMES = {
  light: {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, primary: Colors.light.tint },
  },
  dark: {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, primary: Colors.dark.tint },
  },
};

// The two groups that draw no stack header -- the tabs draw their own (on iOS
// each tab's Stack, #248), the sign-in screens none -- keep no content below
// a bar: with the top edge asked for (lib/stackHeader.ts), each would be
// inset by the status bar twice.
const NO_HEADER: NativeStackNavigationOptions = {
  headerShown: false,
  contentStyle: undefined,
  unstable_nativeProps: undefined,
};

// The splash stays up until the app knows what to draw first: RootLayoutNav
// hides it once the biometric lock's saved switch has answered (#225), so the
// frame after it is the lock screen or the app, never the app's screens under
// a lock that has not engaged yet, and never a blank one while the font, the
// theme and the switch are read. expo-router hides it on an error.
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

  if (!loaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppThemeProvider>
        <QueryProvider>
          <AuthProvider>
            <SyncProvider>
              <RootLayoutNav />
            </SyncProvider>
          </AuthProvider>
        </QueryProvider>
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  useRealtimeSync();
  const { isLocked, unlock } = useBiometricLock();
  // Null while the saved switch is read; known at once on web.
  const lockKnown = isLocked !== null;

  useEffect(() => {
    if (lockKnown) {
      SplashScreen.hideAsync();
    }
  }, [lockKnown]);

  // Unknown: nothing is drawn, under the splash (#225).
  if (!lockKnown) {
    return null;
  }

  if (isLocked) {
    return <LockScreen onUnlock={unlock} />;
  }

  // The header rule every Stack of the app reads (lib/stackHeader.ts): the
  // system header on iOS 26 and later with the content below it, the opaque
  // one elsewhere.
  const screenOptions = stackScreenOptions(colorScheme);
  // The sheets' header (lib/stackHeader.ts): opaque from iOS 27, where a
  // translucent one minimizes and moves the form under it.
  const sheetOptions = sheetHeaderOptions(colorScheme);

  return (
    <ThemeProvider value={NAVIGATION_THEMES[colorScheme]}>
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="(tabs)" options={NO_HEADER} />
        <Stack.Screen name="(auth)" options={NO_HEADER} />
        <Stack.Screen
          name="account/all"
          options={{
            title: 'All Accounts',
            headerBackTitle: 'Accounts',
          }}
        />
        <Stack.Screen
          name="account/[id]"
          options={{
            title: 'Register',
            headerBackTitle: 'Accounts',
          }}
        />
        <Stack.Screen
          name="transaction/new"
          options={{
            title: 'New Transaction',
            presentation: 'modal',
            ...sheetOptions,
          }}
        />
        <Stack.Screen
          name="transaction/[id]"
          options={{
            title: 'Edit Transaction',
            presentation: 'modal',
            ...sheetOptions,
          }}
        />
        <Stack.Screen
          name="transaction/transfer"
          options={{
            title: 'Transfer',
            presentation: 'modal',
            ...sheetOptions,
          }}
        />
        <Stack.Screen
          name="import"
          options={{
            title: 'Import CSV',
            presentation: 'modal',
            ...sheetOptions,
          }}
        />
        <Stack.Screen
          name="recurring/index"
          options={{
            title: 'Recurring Transactions',
            headerBackTitle: 'Settings',
          }}
        />
        <Stack.Screen
          name="recurring/new"
          options={{
            title: 'New Recurring Rule',
            presentation: 'modal',
            ...sheetOptions,
          }}
        />
        <Stack.Screen
          name="unsynced"
          options={{
            title: "Can't Be Uploaded",
            headerBackTitle: 'Settings',
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}

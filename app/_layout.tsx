import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
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
import { LockScreen } from '@/components/LockScreen';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  anchor: '(tabs)',
};

// The navigation theme with the app's tint as its primary colour: on iOS the
// native back button takes the navigation bar's tint, which is the theme's
// primary unless a screen sets headerTintColor, and the default primary is the
// system blue. The app's own back button (#50, removed by #51) was drawn in
// the tint, like the other header controls. Nothing else here reads the
// primary colour: the tab bar and the tabs' headers set their own.
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

  if (isLocked) {
    return <LockScreen onUnlock={unlock} />;
  }

  return (
    <ThemeProvider value={NAVIGATION_THEMES[colorScheme]}>
      {/* Opaque headers, 1.5.0's look. Since SDK 58 a header on iOS 26 and
          later is transparent by default (Liquid Glass) and the screen's
          content runs under it, which none of these screens is laid out for.
          react-native-screens 4.30 lays a screen out under an opaque bar too
          and pads its content by the safe area; it and Apple advise the
          transparent header on iOS 26+ (an opaque bar can leave a strip
          above it on iPhone Duo), a design change of its own (#51). */}
      <Stack screenOptions={{ headerTransparent: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
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
          name="import"
          options={{ title: 'Import CSV', presentation: 'modal' }}
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
          options={{ title: 'New Recurring Rule', presentation: 'modal' }}
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

import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type {
  NativeStackNativeProps,
  NativeStackNavigationOptions,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { Platform } from 'react-native';
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

// The stack's header on iOS 26 and later (#210): the system header (Liquid
// Glass), transparent over the screen's own background, with the content kept
// below it. Since SDK 58 that is the default there, but with the content
// running under the bar, which none of these screens is laid out for; so the
// top edge of react-native-screens' own SafeAreaView, which pads a screen
// below an opaque bar and not below a transparent one, is asked for here. The
// opaque header 1.5.0 drew leaves a strip of another colour above it on iPhone
// Duo: 14 pt of the navigation theme's background above every pushed screen's
// bar on the folded Duo simulator, the strip react-native-screens 4.30's
// release notes and Apple's answer to FB24859353 describe, both advising the
// transparent header. Web, the desktop app and iOS before 26 keep the opaque
// header, 1.5.0's look.
const SYSTEM_HEADER =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

// `unstable_safeAreaEdges` is a prop of react-native-screens' stack item, the
// component expo-router hands `unstable_nativeProps` to; expo-router types
// those as the Screen's props, which do not list it.
const CONTENT_BELOW_HEADER = {
  unstable_safeAreaEdges: { top: true },
} as NativeStackNativeProps;

// The two groups that draw no stack header -- the tabs draw their own, the
// sign-in screens none -- keep no content below a bar: with the top edge asked
// for, each would be inset by the status bar twice.
const NO_HEADER: NativeStackNavigationOptions = {
  headerShown: false,
  contentStyle: undefined,
  unstable_nativeProps: undefined,
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

  // See SYSTEM_HEADER. Under the transparent bar shows the screen's own
  // background, the colour the screens' content is drawn on.
  const screenOptions: NativeStackNavigationOptions = SYSTEM_HEADER
    ? {
        headerTransparent: true,
        contentStyle: { backgroundColor: Colors[colorScheme].background },
        unstable_nativeProps: CONTENT_BELOW_HEADER,
      }
    : { headerTransparent: false };

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

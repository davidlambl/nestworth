import type {
  NativeStackNativeProps,
  NativeStackNavigationOptions,
} from 'expo-router';
import { Platform } from 'react-native';

import Colors from '@/constants/Colors';

/**
 * The header every Stack of the app draws: the root Stack (app/_layout.tsx)
 * and, on iOS, each tab's own (components/TabStack.ios.tsx, #248) -- one
 * rule, read by both.
 */

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

/**
 * A Stack's `screenOptions`: see SYSTEM_HEADER. Under the transparent bar
 * shows the screen's own background, the colour the screens' content is
 * drawn on -- not the navigation theme's, which a Stack nested in a tab would
 * otherwise show there as a band of another grey.
 */
export function stackScreenOptions(
  colorScheme: 'light' | 'dark'
): NativeStackNavigationOptions {
  const screenOptions: NativeStackNavigationOptions = SYSTEM_HEADER
    ? {
        headerTransparent: true,
        contentStyle: { backgroundColor: Colors[colorScheme].background },
        unstable_nativeProps: CONTENT_BELOW_HEADER,
      }
    : { headerTransparent: false };
  return screenOptions;
}

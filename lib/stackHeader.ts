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

// iOS 27's navigation bar minimizes while its screen scrolls
// (UIBarMinimization, which react-native-screens 4.30 turns on for every
// translucent header), and the safe area follows it -- so the SafeAreaView
// above (CONTENT_BELOW_HEADER) shrinks and grows its top padding with the bar
// and moves the form's ScrollView with it, while the ScrollView keeps its
// content offset. When the bar comes back at the end of a fling (it restores
// when the scroll reverses, and the bounce is a reversal), the form's end is
// pushed 58 pt below the sheet: on the folded iPhone Duo simulator a
// Transfer button with 18 of its 56 pt on screen, and every swipe repeated
// it. An opaque header is the one switch react-native-screens offers for the
// minimization (`translucent ? Automatic : Never`), so a form sheet's header is
// opaque from iOS 27, painted the sheet's own colour, with no shadow, and its
// title left in the system's colour as the transparent bar draws it
// (react-navigation would give an opaque header the theme's text colour).
const BAR_MINIMIZES =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 27;

/**
 * The header options of the root Stack's sheets (`presentation: 'modal'`: New
 * and Edit Transaction, Transfer, Import, New Recurring Rule): see
 * BAR_MINIMIZES. Empty below iOS 27, on web and in the desktop app, where the
 * Stack's own options stand. They rest on two library details, which
 * formSheets.test.ts pins: react-native-screens never minimizes an opaque
 * bar (`translucent ? Automatic : Never`, RNSScreenStackHeaderConfig.mm),
 * and native-stack takes the title's colour from `headerTitleStyle` whenever
 * its `color` key is there, even undefined (`'color' in`,
 * useHeaderConfigProps.js), which leaves the title in the system's colour.
 */
export function sheetHeaderOptions(
  colorScheme: 'light' | 'dark'
): NativeStackNavigationOptions {
  return BAR_MINIMIZES
    ? {
        headerTransparent: false,
        headerStyle: { backgroundColor: Colors[colorScheme].background },
        headerShadowVisible: false,
        headerTitleStyle: { color: undefined },
      }
    : {};
}

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

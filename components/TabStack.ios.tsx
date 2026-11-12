import React from 'react';
import { Text } from 'react-native';
import { Stack, useNavigation } from 'expo-router';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { stackScreenOptions } from '@/lib/stackHeader';
import { appTab } from '@/lib/tabs';
// A type only: erased at build time, so Metro never resolves it here, where
// './TabStack' is this file.
import type { TabStackProps } from './TabStack';

/**
 * A tab's group layout on iOS (#248): a Stack of its own with the tab's one
 * screen, because the system's tabs draw no header -- so the system draws
 * this one, under the same rule as every Stack of the app
 * (lib/stackHeader.ts), and the screen's `setOptions` reaches it. Registers
 * and forms are not pushed here but on the root Stack, over the tabs, as
 * before.
 *
 * Every tab's title is a title view, never the bar's plain title: Accounts'
 * own (the app's icon beside the title), the others' TabHeaderTitle below.
 * Why: on an iPad the prototype's screenshots showed Accounts' title view in
 * a row under the top tab bar and no title for Reports and Settings, which
 * then had a plain title -- so a plain title there is taken to be hidden.
 * Measured in the simulator with the title views: on an iPad (iOS 26.5) each
 * tab's title view is drawn, centred under the top tab bar.
 *
 * The title view does NOT keep the header on a scroll. From iOS 27
 * react-native-screens asks UIKit to minimise a translucent bar on a scroll
 * down (`UIBarMinimizationBehaviorAutomatic`; `Never` only for an opaque
 * header, which on a full-screen bar such as a tab's would bring back #210's
 * strip), and the minimisation moves the bar's whole content view -- title
 * view and bar items included (RNSScreenStackHeaderConfig.mm). Measured in
 * the simulator, after a fresh launch and after a tab switch alike: on iOS
 * 26.5 (an iPhone 17, an iPad) no tab's header moves on a scroll; on iPhone
 * Duo folded (iOS 27.1) Settings' title is not drawn while its list is
 * scrolled down and is back on any scroll up, while Accounts' header stays.
 * Reports does not scroll on these three devices. The rule for the tabs'
 * headers: this Stack accepts the system's behaviour -- it sets no
 * minimisation behaviour of its own and does not force the three tabs alike
 * (the root Stack's form sheets do set one from iOS 27, an opaque header:
 * `sheetHeaderOptions`, lib/stackHeader.ts). The strip #210 describes sits
 * above a full-screen bar, and a sheet has no status bar inside it, so by
 * that reasoning a sheet's opaque header shows none -- measured on the
 * folded Duo alone. Not established: why Accounts' header stays while
 * Settings' title goes (a candidate: Accounts mounts its list only after its
 * first read, so UIKit may not observe that list). Not measured: a standard
 * iPhone on iOS 27 (the iOS 27.1 simulator runtime offers the Duo alone).
 */
export function TabStack({ tab, HeaderTitle = TabHeaderTitle }: TabStackProps) {
  const colorScheme = useColorScheme();
  const { screen, title } = appTab(tab);
  return (
    <Stack screenOptions={stackScreenOptions(colorScheme)}>
      <Stack.Screen
        name={screen}
        options={{
          title,
          headerTitle: ({ children }: { children: string }) => (
            <HeaderTitle>{children}</HeaderTitle>
          ),
        }}
      />
    </Stack>
  );
}

/**
 * A tab's title as a title view: the type of Accounts' (AccountsHeaderTitle's
 * text) and of the bar's own title, marked as a heading for VoiceOver as the
 * bar's own title is.
 */
function TabHeaderTitle({ children }: { children: string }) {
  const colors = Colors[useColorScheme() ?? 'light'];
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      style={{ fontSize: 17, fontWeight: '600', color: colors.text }}
    >
      {children}
    </Text>
  );
}

/** The navigation whose header a tab screen sets: the tab's own Stack. */
export function useTabHeaderNavigation() {
  return useNavigation();
}

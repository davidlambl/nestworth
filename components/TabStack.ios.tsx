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
 * Why: on an iPad the simulator showed Accounts' title view in a row under
 * the top tab bar and no title for Reports and Settings, which then had a
 * plain title -- so a plain title there is taken to be hidden (inferred from
 * those screenshots; the iPad re-pass measures it).
 *
 * The title view does NOT keep the header on a scroll. From iOS 27
 * react-native-screens asks UIKit to minimise a translucent bar on a scroll
 * down (`UIBarMinimizationBehaviorAutomatic`; `Never` only for an opaque
 * header, which would bring back #210's strip), and the minimisation moves
 * the bar's whole content view -- title view and bar items included
 * (RNSScreenStackHeaderConfig.mm). On iPhone Duo folded the prototype's
 * Settings bar went on a scroll down and came back on a scroll up, while
 * Accounts' stayed; Accounts mounts its list only after its first read, so
 * UIKit may not observe that list (not measured).
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

import React from 'react';
import { NativeTabs } from 'expo-router/native-tabs';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { TAB_PLACEMENT, TAB_SF_SYMBOLS } from '@/lib/nativeTabs';
import { APP_TABS } from '@/lib/tabs';
// A type only: erased at build time, so Metro never resolves it here, where
// './NativeAppTabs' is this file.
import type { NativeAppTabsProps } from './NativeAppTabs';

/**
 * The app's three tabs on iOS, drawn by the system (#248): the tab bar along
 * the bottom of an iPhone, the rail on iPhone Duo folded, the tab bar or a
 * sidebar on its open display and on an iPad (TAB_PLACEMENT). Each tab's
 * group is a Stack (components/TabStack.ios.tsx), which draws its header.
 */
export function NativeAppTabs({ userId }: NativeAppTabsProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  // Keyed by the account (#177), as the JS tab bar is: a change of account
  // that never passes through "signed out" mounts the tabs afresh -- the
  // system's tab bar controller, every tab's Stack and screen -- so no tab
  // screen keeps the previous account's rows in its own state.
  //
  // The colour scheme is the app's (Settings → Appearance), which can differ
  // from the phone's. The JS tab bar drew it (colors.surface); the system's
  // takes the phone's unless told: react-native-screens sets this as the tab
  // bar controller's overrideUserInterfaceStyle, which its tabs' Stacks and
  // their headers inherit.
  return (
    <NativeTabs
      key={userId}
      tintColor={colors.tabIconSelected}
      preferredPlacement={TAB_PLACEMENT}
      unstable_nativeProps={{ colorScheme }}
    >
      {APP_TABS.map((tab) => (
        <NativeTabs.Trigger key={tab.name} name={tab.name} testID={tab.testID}>
          <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS[tab.name]} />
          <NativeTabs.Trigger.Label>{tab.title}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

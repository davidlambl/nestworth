import type React from 'react';
import { Slot, useNavigation } from 'expo-router';

import type { AppTabName } from '@/lib/tabs';

export type TabStackProps = {
  /** The tab whose group this is (lib/tabs.ts). */
  tab: AppTabName;
  /**
   * The header's title view, where the tab draws its own: Accounts (the app's
   * icon beside the title). On iOS every other tab's title is a title view
   * too, a plain one (TabStack.ios.tsx).
   */
  HeaderTitle?: React.ComponentType<{ children: string }>;
};

/**
 * A tab's group layout (app/(tabs)/(home)/_layout.tsx and its two
 * siblings) on web, in the desktop app and on Android: nothing of its own.
 * The JS tab bar (app/(tabs)/_layout.tsx) draws the tab's header and passes
 * the props above to it, as before #248; the group passes its one screen
 * through. On iOS the group is a Stack (TabStack.ios.tsx), so the system
 * draws the header.
 */
export function TabStack(_props: TabStackProps) {
  return <Slot />;
}

/**
 * The navigation whose header a tab screen sets (`setOptions`): here the JS
 * tab bar's screen, the one around the group's Slot -- a Slot shows no header
 * of its own. On iOS (TabStack.ios.tsx) the tab's own Stack.
 */
export function useTabHeaderNavigation() {
  const navigation = useNavigation();
  return navigation.getParent() ?? navigation;
}

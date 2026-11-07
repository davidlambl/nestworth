import type FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps } from 'react';

/**
 * One of the app's three tabs: the one description every drawing of them
 * reads (#210) -- the JS tab bar and the sidebar on web, in the desktop app
 * and on Android (app/(tabs)/_layout.tsx, components/Sidebar.tsx), and the
 * system's tabs on iOS (components/NativeAppTabs.ios.tsx, #248).
 *
 * Each tab is a route group with a layout of its own (#248): on iOS that
 * layout is a Stack, so the system draws the tab's header; elsewhere it
 * passes the screen through to the tab bar's own header
 * (components/TabStack.tsx). The URLs are the screens' -- a group's name is
 * not part of one.
 */
export type AppTab = {
  /**
   * The route under app/(tabs)/: the tab's group, which the tab bar's screen
   * and the native tab's trigger are both named after.
   *
   * The names keep Accounts the tab a navigator starts on when it is given
   * none -- under a register opened straight from a link, the one Back
   * returns to. Expo Router seeds that state from the groups in its own
   * order, the shortest name first (expo-router's sortRoutes), not the tab
   * bar's: "(home)" sorts before "(reports)", where "(accounts)" would not.
   * tabs.test.ts runs that sort.
   */
  name: '(home)' | '(reports)' | '(settings)';
  /** The screen in that group the tab shows: its route file there. */
  screen: 'index' | 'reports' | 'settings';
  /** The label in the tab bar and the sidebar, and the screen's title. */
  title: string;
  /** The JS tab bar's and the sidebar's icon (iOS: lib/nativeTabs.ts). */
  icon: ComponentProps<typeof FontAwesome>['name'];
  /**
   * The tab button's testID: on iOS the tab bar item's accessibility
   * identifier. The Maestro flows tap tab-accounts and tab-settings.
   */
  testID: string;
  /** The tab's URL: where the sidebar goes. */
  path: '/' | '/reports' | '/settings';
};

export type AppTabName = AppTab['name'];

/** The tabs, in their order. */
export const APP_TABS: readonly AppTab[] = [
  {
    name: '(home)',
    screen: 'index',
    title: 'Accounts',
    icon: 'bank',
    testID: 'tab-accounts',
    path: '/',
  },
  {
    name: '(reports)',
    screen: 'reports',
    title: 'Reports',
    icon: 'bar-chart',
    testID: 'tab-reports',
    path: '/reports',
  },
  {
    name: '(settings)',
    screen: 'settings',
    title: 'Settings',
    icon: 'cog',
    testID: 'tab-settings',
    path: '/settings',
  },
];

/** The tab named `name`. */
export function appTab(name: AppTabName): AppTab {
  const tab = APP_TABS.find((t) => t.name === name);
  if (!tab) {
    throw new Error(`No tab named ${name}`);
  }
  return tab;
}

/**
 * The tab a path is on, which the sidebar shows as the current one. Any path
 * that is no tab's own (a register, a form opened over the tabs) counts as
 * the Accounts tab's.
 */
export function tabForPath(pathname: string): AppTabName {
  return APP_TABS.find((tab) => tab.path === pathname)?.name ?? '(home)';
}

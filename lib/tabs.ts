import type FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps } from 'react';

/**
 * One of the app's three tabs: the one description the tab bar
 * (app/(tabs)/_layout.tsx) and the sidebar (components/Sidebar.tsx) both
 * draw, so a native tab bar for iOS (#211) can draw the same three without a
 * further copy of their names, labels and order (#210).
 */
export type AppTab = {
  /** The route under app/(tabs)/. */
  name: 'index' | 'reports' | 'settings';
  /** The label in the tab bar and the sidebar, and the screen's title. */
  title: string;
  icon: ComponentProps<typeof FontAwesome>['name'];
  /** The tab bar button's testID; the Maestro flows tap tab-accounts and tab-settings. */
  testID: string;
  /** Where the sidebar goes. */
  path: '/' | '/reports' | '/settings';
};

export type AppTabName = AppTab['name'];

/** The tabs, in their order. */
export const APP_TABS: readonly AppTab[] = [
  {
    name: 'index',
    title: 'Accounts',
    icon: 'bank',
    testID: 'tab-accounts',
    path: '/',
  },
  {
    name: 'reports',
    title: 'Reports',
    icon: 'bar-chart',
    testID: 'tab-reports',
    path: '/reports',
  },
  {
    name: 'settings',
    title: 'Settings',
    icon: 'cog',
    testID: 'tab-settings',
    path: '/settings',
  },
];

/**
 * The tab a path is on, which the sidebar shows as the current one. Any path
 * that is no tab's own (a register, a form opened over the tabs) counts as
 * the Accounts tab's.
 */
export function tabForPath(pathname: string): AppTabName {
  return APP_TABS.find((tab) => tab.path === pathname)?.name ?? 'index';
}

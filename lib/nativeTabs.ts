import type { NativeTabsProps, SFSymbolIcon } from 'expo-router/native-tabs';

import type { AppTabName } from './tabs';

/**
 * What the system's tabs on iOS take beyond APP_TABS (#248). Read only by
 * components/NativeAppTabs.ios.tsx, so neither the symbols nor anything of
 * native tabs reaches the web bundle (lib/tabs.ts does: the sidebar and the
 * JS tab bar read it).
 */

type SFSymbolName = Extract<NonNullable<SFSymbolIcon['sf']>, string>;

/**
 * The SF Symbol each tab shows in the tab bar, iPhone Duo's rail and the
 * sidebar: the system's counterparts of the FontAwesome icons the JS tab bar
 * draws (bank, bar-chart, cog). All three are in SF Symbols 1.0 or 2.0, so
 * every iOS the app runs on (16.4 and later) has them.
 */
export const TAB_SF_SYMBOLS: Readonly<Record<AppTabName, SFSymbolName>> = {
  '(home)': 'building.columns',
  '(reports)': 'chart.bar',
  '(settings)': 'gearshape',
};

/**
 * Where the system puts the tabs where it can show either a tab bar or a
 * sidebar -- the one choice to make on iPhone Duo's open display (#211),
 * judged on the device. Any value turns the tab bar into one that can become
 * a sidebar (UITabBarController's `tabSidebar` mode, iOS 18 and later):
 *
 * - `'automatic'` (built): the system's default. On an iPhone that is the tab
 *   bar -- along the bottom upright, in the rail on iPhone Duo folded -- and
 *   on iOS 27 where an iPhone could show a sidebar instead (iPhone Duo open,
 *   a larger iPhone in landscape) still the tab bar. On an iPad the tab bar at
 *   the top, which the user can turn into the sidebar.
 * - `'sidebar'`: on iOS 27 and later, the sidebar wherever an iPhone supports
 *   one (iPhone Duo's open display); elsewhere as `'automatic'`.
 * - `'tabBar'`: the tab bar, also where a sidebar is supported: on iOS the
 *   same as `'automatic'` today, but kept if the system's default changes.
 *
 * On an iPad the placement itself has no effect (Apple: iPadOS shows both,
 * the sidebar minimising into the top tab bar). Before iOS 27 the three
 * values draw the same, and before iOS 18 the tab bar cannot become a sidebar
 * at all (a development build logs react-native-screens' warning that the
 * mode needs iOS 18).
 */
export const TAB_PLACEMENT: NonNullable<NativeTabsProps['preferredPlacement']> =
  'automatic';

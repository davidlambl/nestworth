import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SideInsets } from '@/lib/layout';

/**
 * The side insets a screen keeps its content clear of (#210): on iPhone Duo
 * the system's vertical bar -- the rail, 84 pt on the right edge when folded
 * and on the outer edge of each window in Split View -- and on any iPhone the
 * sensor housing's side in landscape. Both sides are read: the rail stays on
 * the camera's edge whatever the language.
 *
 * Every screen takes its side insets from here and nowhere else (with
 * `sidePadding` and `rightOffset` from lib/layout.ts), so a rule about where
 * content may run under the rail is made in this one place. 0 on web and in
 * the desktop app, on an iPhone held upright and on an iPad. These are the
 * window's insets, not a view's: a page sheet that stops short of the
 * window's edge still gets them.
 */
export function useScreenInsets(): SideInsets {
  const { left, right } = useSafeAreaInsets();
  return useMemo(() => ({ left, right }), [left, right]);
}

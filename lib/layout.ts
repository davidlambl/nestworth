import { Platform } from 'react-native';

/**
 * The window width (points on iOS, CSS pixels on web and in the desktop app)
 * from which the wide layout shows: the sidebar in place of the tab bar
 * (app/(tabs)/_layout.tsx), the accounts panel beside a register
 * (app/account/[id].tsx, app/account/all.tsx), and the sync status in the
 * sidebar instead of the Accounts header (app/(tabs)/index.tsx).
 */
export const WIDE_LAYOUT_MIN_WIDTH = 768;

/** What `isWideLayout` reads about the device it runs on. */
export type LayoutDevice = { os: typeof Platform.OS; isPad: boolean };

const THIS_DEVICE: LayoutDevice = {
  os: Platform.OS,
  isPad: Platform.OS === 'ios' && Platform.isPad,
};

/**
 * Whether a window this wide gets the wide layout: the one rule, read at
 * render time from `useWindowDimensions()` (#210).
 *
 * Never on an iPhone. iPhone Duo's open display is 951 pt wide held like a
 * book and 669 pt in portrait; folded it is 466 pt, and a Split View window
 * 469 pt. By width alone, every unfold would swap the tab bar for the
 * sidebar and every fold or turn swap it back -- and the swap mounts the tab
 * screens afresh, so each would lose its scroll position and what was chosen
 * on it. An iPhone keeps its layout and lets it widen ("allow the existing
 * layout to expand based on the available space", Apple's guidance for
 * iPhone Duo); a sidebar on the open display is the system's to draw, with
 * native tabs (#211). An iPad, a browser window and the desktop app switch
 * at 768, as before.
 */
export function isWideLayout(
  width: number,
  device: LayoutDevice = THIS_DEVICE
): boolean {
  if (device.os === 'ios' && !device.isPad) {
    return false;
  }
  return width >= WIDE_LAYOUT_MIN_WIDTH;
}

/** The left and right safe-area insets of the window a screen is in. */
export type SideInsets = { left: number; right: number };

/**
 * Padding that keeps a container's content clear of the side insets, on top
 * of the `base` padding the container has of its own (#210). Undefined while
 * both insets are 0 -- on web and in the desktop app, on an iPhone in
 * portrait, on an iPad -- so a screen's style there is exactly what it was.
 */
export function sidePadding(
  insets: SideInsets,
  base = 0
): { paddingLeft: number; paddingRight: number } | undefined {
  if (insets.left === 0 && insets.right === 0) {
    return undefined;
  }
  return {
    paddingLeft: base + insets.left,
    paddingRight: base + insets.right,
  };
}

/**
 * A floating element's distance from the right edge: `offset` plus the right
 * inset ("`right: insets.right + 16`, not `right: 16`", Expo's guide to
 * iPhone Duo). Undefined while the right inset is 0, where the element's own
 * `right: offset` stands -- so pass the offset its style already has.
 */
export function rightOffset(
  insets: SideInsets,
  offset: number
): { right: number } | undefined {
  if (insets.right === 0) {
    return undefined;
  }
  return { right: offset + insets.right };
}

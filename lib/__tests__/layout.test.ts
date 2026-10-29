import { Platform } from 'react-native';

import {
  WIDE_LAYOUT_MIN_WIDTH,
  isWideLayout,
  rightOffset,
  sidePadding,
  type LayoutDevice,
} from '../layout';

const iPhone: LayoutDevice = { os: 'ios', isPad: false };
const iPad: LayoutDevice = { os: 'ios', isPad: true };
const web: LayoutDevice = { os: 'web', isPad: false };
const android: LayoutDevice = { os: 'android', isPad: false };

// iPhone Duo, in points (the simulator's device profile: the outer display
// 1398 x 2034 px and the inner 2007 x 2853 px, both at 3x; Split View's left
// window from Expo's guide).
const DUO = { folded: 466, openBook: 951, openPortrait: 669, splitView: 469 };

describe('isWideLayout (#210)', () => {
  it('switches at 768 on web and in the desktop app, as before', () => {
    expect(WIDE_LAYOUT_MIN_WIDTH).toBe(768);
    expect(isWideLayout(767, web)).toBe(false);
    expect(isWideLayout(768, web)).toBe(true);
    expect(isWideLayout(1280, web)).toBe(true);
  });

  it('switches at 768 on an iPad, as before', () => {
    expect(isWideLayout(767, iPad)).toBe(false);
    expect(isWideLayout(768, iPad)).toBe(true);
    expect(isWideLayout(1194, iPad)).toBe(true);
  });

  it('keeps the width rule on Android', () => {
    expect(isWideLayout(767, android)).toBe(false);
    expect(isWideLayout(768, android)).toBe(true);
  });

  it('never gives an iPhone the wide layout, iPhone Duo open included', () => {
    expect(isWideLayout(DUO.openBook, iPhone)).toBe(false);
    expect(isWideLayout(DUO.openPortrait, iPhone)).toBe(false);
    expect(isWideLayout(DUO.folded, iPhone)).toBe(false);
    expect(isWideLayout(1280, iPhone)).toBe(false);
  });

  it("is narrow in Split View's 469 pt window on every device", () => {
    for (const device of [iPhone, iPad, web, android]) {
      expect(isWideLayout(DUO.splitView, device)).toBe(false);
    }
  });

  it('reads the device it runs on when none is given', () => {
    // jest-expo runs as an iPhone.
    expect(Platform.OS).toBe('ios');
    expect(isWideLayout(DUO.openBook)).toBe(false);
  });
});

describe('sidePadding (#210)', () => {
  it('is undefined while both insets are 0, so a style is unchanged', () => {
    expect(sidePadding({ left: 0, right: 0 })).toBeUndefined();
    expect(sidePadding({ left: 0, right: 0 }, 16)).toBeUndefined();
  });

  it('pads each side by its own inset: the rail on the right edge', () => {
    expect(sidePadding({ left: 0, right: 84 })).toStrictEqual({
      paddingLeft: 0,
      paddingRight: 84,
    });
  });

  it('pads each side by its own inset: the rail on the left edge', () => {
    expect(sidePadding({ left: 84, right: 0 })).toStrictEqual({
      paddingLeft: 84,
      paddingRight: 0,
    });
  });

  it("adds the insets to the container's own padding", () => {
    expect(sidePadding({ left: 0, right: 84 }, 16)).toStrictEqual({
      paddingLeft: 16,
      paddingRight: 100,
    });
    expect(sidePadding({ left: 47, right: 47 }, 20)).toStrictEqual({
      paddingLeft: 67,
      paddingRight: 67,
    });
  });
});

describe('rightOffset (#210)', () => {
  it('is undefined while the right inset is 0, the rail on the left included', () => {
    expect(rightOffset({ left: 0, right: 0 }, 24)).toBeUndefined();
    expect(rightOffset({ left: 84, right: 0 }, 24)).toBeUndefined();
  });

  it('moves a floating element clear of a right inset', () => {
    expect(rightOffset({ left: 0, right: 84 }, 24)).toStrictEqual({
      right: 108,
    });
    expect(rightOffset({ left: 0, right: 84 }, 16)).toStrictEqual({
      right: 100,
    });
  });
});

// A form's inline error is spoken by a screen reader on every platform (#164):
// a polite live region on web and Android (components/FormError.tsx), and on
// iOS, which has no live regions, an announcement. These tests pin which
// platform announces, and how.
//
// react-native is mocked down to the two things lib/formError.ts uses, as in
// promptSignOut.test.ts: `Platform` stays a plain object so each test can set
// `OS`, and `AccessibilityInfo` can be swapped for react-native-web's own.
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: {
    announceForAccessibility: jest.fn(),
    announceForAccessibilityWithOptions: jest.fn(),
  },
}));

import { announceFormError } from '../formError';

// The mocked module object itself, the one lib/formError.ts reads at each
// call. (A namespace import would be a copy: replacing a property on it would
// not reach the module under test.)
const rn = jest.requireMock('react-native') as {
  Platform: { OS: string };
  AccessibilityInfo: unknown;
};
const nativeAccessibilityInfo = rn.AccessibilityInfo as {
  announceForAccessibility: jest.Mock;
  announceForAccessibilityWithOptions: jest.Mock;
};

// The AccessibilityInfo the web bundle and Electron actually load (its CommonJS
// build assigns the object itself to module.exports).
const webAccessibilityInfo = jest.requireActual(
  'react-native-web/dist/cjs/exports/AccessibilityInfo'
) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  rn.Platform.OS = 'ios';
  rn.AccessibilityInfo = nativeAccessibilityInfo;
});

describe('announceFormError', () => {
  it('announces a new error on iOS, queued behind what VoiceOver is saying', () => {
    announceFormError('Please enter a valid amount.');

    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions.mock.calls
    ).toStrictEqual([['Please enter a valid amount.', { queue: true }]]);
    expect(
      nativeAccessibilityInfo.announceForAccessibility
    ).not.toHaveBeenCalled();
  });

  it('announces nothing itself on Android, where the live region reads the line', () => {
    rn.Platform.OS = 'android';

    announceFormError('Please enter a valid amount.');

    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
    expect(
      nativeAccessibilityInfo.announceForAccessibility
    ).not.toHaveBeenCalled();
  });

  it("announces nothing on web and in Electron, whose AccessibilityInfo (react-native-web's) has no announceForAccessibilityWithOptions", () => {
    rn.Platform.OS = 'web';
    rn.AccessibilityInfo = webAccessibilityInfo;

    // Why the call must never be made there: it would throw on every error.
    // (Its announceForAccessibility being a function shows this is the real
    // object, so the undefined below cannot come from a wrapper such as
    // `{ default: … }`, on which every method would read undefined.)
    expect(typeof webAccessibilityInfo.announceForAccessibility).toBe(
      'function'
    );
    expect(webAccessibilityInfo.announceForAccessibilityWithOptions).toBe(
      undefined
    );
    expect(() =>
      announceFormError('Please enter a valid amount.')
    ).not.toThrow();
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
  });
});

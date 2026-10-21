// A form's inline error is spoken by a screen reader on every platform (#164):
// a polite live region on web and Android (components/FormError.tsx), and on
// iOS, which has no live regions, VoiceOver is asked to move to the line
// (#178), or, when the line cannot be found, the message is announced. That
// VoiceOver then moves to the line and reads it is not yet confirmed on a
// device. These tests pin which platform does what, and when.
//
// react-native is mocked down to the two things lib/formError.ts uses, as in
// promptSignOut.test.ts: `Platform` stays a plain object so each test can set
// `OS`, and `AccessibilityInfo` can be swapped for react-native-web's own.
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: {
    announceForAccessibility: jest.fn(),
    announceForAccessibilityWithOptions: jest.fn(),
    sendAccessibilityEvent: jest.fn(),
  },
}));

import type { HostInstance } from 'react-native';
import {
  announceFormError,
  focusFormError,
  FORM_ERROR_FOCUS_DELAY_MS,
} from '../formError';

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
  sendAccessibilityEvent: jest.Mock;
};

// The AccessibilityInfo the web bundle and Electron actually load (its CommonJS
// build assigns the object itself to module.exports).
const webAccessibilityInfo = jest.requireActual(
  'react-native-web/dist/cjs/exports/AccessibilityInfo'
) as Record<string, unknown>;

// Stands in for the line's native view (FormError's box); only its identity
// matters here.
const line = { tag: 'the error line' } as unknown as HostInstance;

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

describe('focusFormError', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves VoiceOver to the line once it has had time to appear, instead of announcing it (#178)', () => {
    focusFormError(() => line, 'Please enter an account name.');

    // Not in the commit that mounts the line, while VoiceOver is still busy
    // with the button that was just activated.
    jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS - 1);
    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent
    ).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent.mock.calls
    ).toStrictEqual([[line, 'focus']]);
    // VoiceOver reads the line it lands on; an announcement as well would
    // read it twice.
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
    expect(
      nativeAccessibilityInfo.announceForAccessibility
    ).not.toHaveBeenCalled();
  });

  it('reads the line out instead when there is no line to move to', () => {
    focusFormError(() => null, 'Please enter an account name.');

    jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS);

    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent
    ).not.toHaveBeenCalled();
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions.mock.calls
    ).toStrictEqual([['Please enter an account name.', { queue: true }]]);
  });

  it('finds the line when the wait ends, not when it starts', () => {
    // The line's view may not be there yet when the message is set.
    let current: HostInstance | null = null;
    focusFormError(() => current, 'Please enter an account name.');
    current = line;

    jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS);

    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent.mock.calls
    ).toStrictEqual([[line, 'focus']]);
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
  });

  it('does nothing once cancelled: the message changed, or the form closed, first', () => {
    const cancel = focusFormError(() => line, 'Please enter an account name.');

    cancel();
    jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS * 2);

    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent
    ).not.toHaveBeenCalled();
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
  });

  it('moves nothing and waits for nothing on Android, where the live region reads the line', () => {
    rn.Platform.OS = 'android';

    const cancel = focusFormError(() => line, 'Please enter an account name.');

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS);
    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent
    ).not.toHaveBeenCalled();
    expect(
      nativeAccessibilityInfo.announceForAccessibilityWithOptions
    ).not.toHaveBeenCalled();
    expect(() => cancel()).not.toThrow();
  });

  it("moves nothing on web and in Electron, where moving focus would take the keyboard's and react-native-web has no sendAccessibilityEvent", () => {
    rn.Platform.OS = 'web';
    rn.AccessibilityInfo = webAccessibilityInfo;

    // PIN: the call would throw there (react-native-web 0.21's
    // AccessibilityInfo has no such method; its setAccessibilityFocus is
    // empty).
    expect(webAccessibilityInfo.sendAccessibilityEvent).toBe(undefined);

    const cancel = focusFormError(() => line, 'Please enter an account name.');

    expect(jest.getTimerCount()).toBe(0);
    expect(() =>
      jest.advanceTimersByTime(FORM_ERROR_FOCUS_DELAY_MS)
    ).not.toThrow();
    expect(
      nativeAccessibilityInfo.sendAccessibilityEvent
    ).not.toHaveBeenCalled();
    expect(() => cancel()).not.toThrow();
  });
});

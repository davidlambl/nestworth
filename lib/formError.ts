import { AccessibilityInfo, Platform, type HostInstance } from 'react-native';

/**
 * Speaks a form's new inline error to VoiceOver (#164).
 *
 * Every form reports what the person must fix on the form itself
 * (components/FormError.tsx). A line of text appearing on screen is silent to
 * a screen reader unless something announces it; the Alert it replaced was
 * read out. The line's wrapper is a polite live region (`aria-live`), which
 * react-native-web renders as the DOM attribute and React Native maps to
 * Android's accessibilityLiveRegion, so those two platforms speak it on their
 * own. iOS has no live regions: there the message is posted as an
 * announcement, queued behind whatever VoiceOver is saying (the button that was
 * just pressed) rather than cutting it off. FormError no longer relies on it
 * alone: it moves VoiceOver to the line (focusFormError, #178), and this is
 * what it falls back to when the line cannot be found.
 *
 * Only on iOS: on Android the live region already speaks it, and an
 * announcement as well would read it twice; react-native-web's
 * AccessibilityInfo has no announceForAccessibilityWithOptions at all, so the
 * call would throw on web and in Electron.
 */
export function announceFormError(message: string): void {
  if (Platform.OS !== 'ios') {
    return;
  }
  AccessibilityInfo.announceForAccessibilityWithOptions(message, {
    queue: true,
  });
}

/**
 * How long a new line waits before VoiceOver is moved to it (#178): until the
 * line is on screen and VoiceOver is done with the button that was just
 * activated. Half a second follows the tap closely; a device measurement may
 * tune it.
 */
export const FORM_ERROR_FOCUS_DELAY_MS = 500;

/**
 * Moves VoiceOver to a form's new inline error, so that it reads the line
 * (#178), and returns what cancels that.
 *
 * The queued announcement alone was not heard: on iOS 26, New Account with an
 * empty name, VoiceOver said "Create" and nothing else. Moving VoiceOver to
 * the error is how a native form points at one: React Native's
 * sendAccessibilityEvent(view, 'focus') posts
 * UIAccessibilityLayoutChangedNotification with that view as the element for
 * VoiceOver to move to (traced through React Native's source; that VoiceOver
 * then reads the line, scrolling it into view inside a scroll view, is not
 * yet confirmed on a device). The event is sent after
 * FORM_ERROR_FOCUS_DELAY_MS, never in the commit that mounts the line, and
 * only then is the line looked up (`getLine`); with no line to move to, the
 * message is announced instead. The caller cancels when the message changes
 * or the form goes, so a line that is no longer there is never pointed at.
 *
 * Only on iOS: Android's live region reads the line; on web and in Electron
 * the polite live region does, and moving focus there would move the
 * keyboard's focus too, out of the field being fixed (and react-native-web has
 * no sendAccessibilityEvent).
 */
export function focusFormError(
  getLine: () => HostInstance | null,
  message: string
): () => void {
  if (Platform.OS !== 'ios') {
    return () => undefined;
  }
  const timer = setTimeout(() => {
    const line = getLine();
    if (line) {
      AccessibilityInfo.sendAccessibilityEvent(line, 'focus');
    } else {
      announceFormError(message);
    }
  }, FORM_ERROR_FOCUS_DELAY_MS);
  return () => clearTimeout(timer);
}

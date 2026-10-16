import { AccessibilityInfo, Platform } from 'react-native';

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
 * just pressed) rather than cutting it off.
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

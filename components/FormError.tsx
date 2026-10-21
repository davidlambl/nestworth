import React, { useEffect, useRef } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { focusFormError } from '@/lib/formError';

type Props = {
  /** The error, or null/'' for none. */
  message: string | null;
  /** Screen-prefixed, on the error's text (e.g. `new-txn-error`). */
  testID: string;
  /** The line's placement in its form (its margins). */
  style?: StyleProp<TextStyle>;
  /** A box drawn around the line (the sign-in screen's tinted box). */
  boxStyle?: StyleProp<ViewStyle>;
  /**
   * False for a line that appears on its own, not as the answer to the
   * person's tap (a receipt that cannot be shown, found as the screen opens):
   * VoiceOver reads it out without being moved to it, away from the field the
   * person is on (#38).
   */
  moveFocus?: boolean;
};

/**
 * A form's inline error: what the person must fix, on the form itself, on
 * every platform (#145, #164). Alert.alert is a no-op on web and in Electron
 * (react-native-web's Alert is an empty class), so a form that validated
 * through it said nothing there. Each screen places this where the line
 * stays in view when it appears: under the title of a bottom sheet (the iOS
 * keyboard covers New Account from below; Edit Account rises above it), and
 * directly above the submit button of a scrolling form.
 *
 * Screen readers hear it too. The View around the line is a polite live
 * region (react-native-web renders `aria-live` as the DOM attribute, React
 * Native maps it to Android's accessibilityLiveRegion), and it stays mounted
 * while the message comes and goes: a live region reliably announces only the
 * changes made after it exists, so one mounted together with its text could
 * go unread. iOS has no live regions, and a queued announcement of the line
 * was not heard there (#178), so VoiceOver is asked to move to a new message
 * instead once it is on screen (focusFormError, lib/formError.ts; not yet
 * confirmed on a device). The same message set again is not a change, and is
 * not read again.
 */
export default function FormError({
  message,
  testID,
  style,
  boxStyle,
  moveFocus = true,
}: Props) {
  const colors = Colors[useColorScheme() ?? 'light'];
  // The line's box, which VoiceOver is moved to on iOS (#178).
  const lineRef = useRef<View>(null);

  useEffect(() => {
    if (!message) {
      return;
    }
    // Cancelled when the message changes or the form goes, before it fires.
    return focusFormError(() => (moveFocus ? lineRef.current : null), message);
  }, [message, moveFocus]);

  return (
    <View aria-live="polite" style={styles.region}>
      {message ? (
        // On iOS `accessible` makes the box one VoiceOver element, the one
        // focus lands on: a Text there is a container of elements, not one
        // itself. Only there: on Android it would make the box a focus stop
        // of its own (isFocusable), and nothing is moved to it.
        <View ref={lineRef} accessible={Platform.OS === 'ios'} style={boxStyle}>
          <Text
            testID={testID}
            style={[styles.text, { color: colors.expense }, style]}
          >
            {message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Full width even in a parent that centres its children (the sign-in form).
  region: { alignSelf: 'stretch' },
  text: { fontSize: 14 },
});

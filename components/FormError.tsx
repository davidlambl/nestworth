import React, { useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { announceFormError } from '@/lib/formError';

type Props = {
  /** The error, or null/'' for none. */
  message: string | null;
  /** Screen-prefixed, on the error's text (e.g. `new-txn-error`). */
  testID: string;
  /** The line's placement in its form (its margins). */
  style?: StyleProp<TextStyle>;
  /** A box drawn around the line (the sign-in screen's tinted box). */
  boxStyle?: StyleProp<ViewStyle>;
};

/**
 * A form's inline error: what the person must fix, on the form itself, on
 * every platform (#145, #164). Alert.alert is a no-op on web and in Electron
 * (react-native-web's Alert is an empty class), so a form that validated
 * through it said nothing there. Each screen places this where the line
 * stays in view when it appears: under the title of a bottom sheet, which the
 * iOS keyboard covers from below, and directly above the submit button of a
 * scrolling form.
 *
 * Screen readers hear it too. The View around the line is a polite live
 * region (react-native-web renders `aria-live` as the DOM attribute, React
 * Native maps it to Android's accessibilityLiveRegion), and it stays mounted
 * while the message comes and goes: a live region reliably announces only the
 * changes made after it exists, so one mounted together with its text could
 * go unread. iOS has no live regions, so a new message is announced there
 * through AccessibilityInfo (lib/formError.ts). The same message set again is
 * not a change, and is not read again.
 */
export default function FormError({ message, testID, style, boxStyle }: Props) {
  const colors = Colors[useColorScheme() ?? 'light'];

  useEffect(() => {
    if (message) {
      announceFormError(message);
    }
  }, [message]);

  return (
    <View aria-live="polite" style={styles.region}>
      {message ? (
        <View style={boxStyle}>
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

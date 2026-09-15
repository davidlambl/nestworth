import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

/**
 * Stands in for the native header back button on iOS.
 *
 * react-native-screens 4.16.0 — the version Expo SDK 54 pins — stops
 * delivering taps to the native back button on iOS 26 once a screen sitting
 * directly above a `headerShown: false` screen has been pushed a second time.
 * See software-mansion/react-native-screens#3294. Our root Stack hides the
 * header on `(tabs)`, so every screen pushed from a tab is exposed to it, and
 * the dead state survives until the app is force-quit.
 *
 * The rest of the navigation bar keeps receiving touches and `router.back()`
 * still navigates — only the native button is deaf — so rendering our own
 * button sidesteps it entirely. The back swipe is untouched either way.
 *
 * Android and web keep the platform's own affordance: the bug is iOS-only and
 * their defaults already look right. Remove this once the pinned
 * react-native-screens carries the upstream fix.
 */
export function HeaderBackButton({ label }: { label: string }) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <TouchableOpacity
      testID="header-back-btn"
      onPress={() => router.back()}
      hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.button}
    >
      <FontAwesome name="chevron-left" size={16} color={colors.tint} />
      <Text style={[styles.label, { color: colors.tint }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Screen options that swap in {@link HeaderBackButton} on iOS and change
 * nothing anywhere else. `headerBackTitle` is deliberately left in place on
 * the screens that use this: it is the label the native button would carry,
 * so it stays correct for the day the workaround comes back out.
 */
export function headerBackButtonOptions(label: string) {
  if (Platform.OS !== 'ios') {
    return {};
  }
  return { headerLeft: () => <HeaderBackButton label={label} /> };
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 12,
    paddingVertical: 8,
  },
  label: { fontSize: 17 },
});

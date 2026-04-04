import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';

interface LockScreenProps {
  onUnlock: () => void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FontAwesome name="lock" size={64} color={colors.tint} />
      <Text style={[styles.title, { color: colors.text }]}>Checkbook</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Tap to unlock with biometrics
      </Text>
      <TouchableOpacity
        style={[styles.unlockBtn, { backgroundColor: colors.tint }]}
        onPress={onUnlock}
      >
        <FontAwesome name="unlock-alt" size={20} color="#fff" />
        <Text style={styles.unlockBtnText}>Unlock</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginTop: 8,
  },
  subtitle: {
    fontSize: 15,
  },
  unlockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 24,
  },
  unlockBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});

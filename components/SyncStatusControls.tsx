import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useSyncStatus } from '@/lib/hooks/useSyncStatus';
import { statusDotColor, statusLabel } from '@/lib/syncStatusHelpers';

export function SyncStatusSidebarRow({ collapsed }: { collapsed: boolean }) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const snapshot = useSyncStatus();

  const onPress = () => {
    if (snapshot.userId && !snapshot.isSyncing) {
      void snapshot.syncNow();
    }
  };

  const dotColor = statusDotColor(snapshot, colors);

  return (
    <TouchableOpacity
      style={[styles.sidebarRow, collapsed && styles.sidebarRowCollapsed]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={!snapshot.userId || snapshot.isSyncing}
    >
      {snapshot.isSyncing ? (
        <ActivityIndicator size="small" color={colors.tint} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
      {!collapsed && (
        <Text
          style={[styles.sidebarLabel, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {statusLabel(snapshot)}
        </Text>
      )}
      {!collapsed && snapshot.userId && !snapshot.isSyncing && (
        <FontAwesome name="refresh" size={12} color={colors.placeholder} />
      )}
    </TouchableOpacity>
  );
}

export function SyncStatusHeaderButton() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const snapshot = useSyncStatus();

  const onPress = () => {
    if (snapshot.userId && !snapshot.isSyncing) {
      void snapshot.syncNow();
    }
  };

  const dotColor = statusDotColor(snapshot, colors);

  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.headerBtn}
      disabled={!snapshot.userId || snapshot.isSyncing}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      {/*
        Fixed-size slot so toggling between the spinner (~20×20 on iOS) and
        the dot (22×22) never re-measures the navigation header. Without
        this wrapper, a single mutation that flips isSyncing causes the
        header to re-layout and shifts the FlatList content area beneath.
      */}
      <View style={styles.headerIconSlot}>
        {snapshot.isSyncing ? (
          <ActivityIndicator size="small" color={colors.tint} />
        ) : (
          <View style={[styles.headerDot, { backgroundColor: dotColor }]} />
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  sidebarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginHorizontal: 10,
    borderRadius: 8,
  },
  sidebarRowCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    marginHorizontal: 0,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  sidebarLabel: {
    flex: 1,
    fontSize: 12,
  },
  headerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginRight: 4,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 36,
  },
  headerDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconSlot: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

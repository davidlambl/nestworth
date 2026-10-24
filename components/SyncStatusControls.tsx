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
import {
  statusDotColor,
  statusLabel,
  syncButtonLabel,
} from '@/lib/syncStatusHelpers';

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
      // Collapsed, the row is the dot alone: the label says what it shows,
      // then what pressing it does.
      accessibilityRole="button"
      accessibilityLabel={syncButtonLabel(snapshot)}
    >
      {snapshot.isSyncing ? (
        <ActivityIndicator size="small" color={colors.tint} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
      {!collapsed && (
        <Text
          // The only place the label text is rendered. Playwright's
          // `expectSynced` waits on this exact text to prove a spec's writes
          // were pushed before the browser context closes (issue #54). Two
          // lines: "N pending, M can't upload" (#194) is wider than the row,
          // and wraps after its comma.
          testID="sync-status-label"
          style={[styles.sidebarLabel, { color: colors.textSecondary }]}
          numberOfLines={2}
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
      // A dot alone: the label says what its colour shows, as the sidebar
      // row's text does on a wide screen, then what pressing it does.
      accessibilityRole="button"
      accessibilityLabel={syncButtonLabel(snapshot)}
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

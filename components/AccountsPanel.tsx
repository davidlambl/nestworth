import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency, balanceColor } from '@/lib/format';
import { useAccounts } from '@/lib/hooks/useAccounts';
import type { AccountType, AccountWithBalance } from '@/lib/types';

const DEFAULT_ICONS: Record<AccountType, string> = {
  checking: '🏦',
  savings: '🐷',
  credit_card: '💳',
  cash: '💵',
  other: '📁',
};

interface AccountsPanelProps {
  activeAccountId: string;
}

export function AccountsPanel({ activeAccountId }: AccountsPanelProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { data: accounts } = useAccounts();

  const [showArchived, setShowArchived] = useState(false);

  const activeAccounts: AccountWithBalance[] =
    accounts?.filter((a: AccountWithBalance) => !a.isArchived) ?? [];
  const archivedAccounts: AccountWithBalance[] =
    accounts?.filter((a: AccountWithBalance) => a.isArchived) ?? [];
  const totalBalance = activeAccounts
    .filter((a) => !a.excludeFromTotal)
    .reduce((s, a) => s + a.currentBalance, 0);

  const isAllActive = activeAccountId === '__all__';

  // Archived accounts are reachable from here (their register still works),
  // but they are dimmed, collapsed by default and carry no actions — archive
  // and unarchive live on the Accounts tab and the register banner.
  const renderRow = (item: AccountWithBalance, archived: boolean) => {
    const isActive = item.id === activeAccountId;
    return (
      <TouchableOpacity
        key={item.id}
        style={[
          styles.row,
          isActive && { backgroundColor: colors.tintLight },
          archived && styles.archivedRow,
        ]}
        onPress={() => router.replace(`/account/${item.id}` as any)}
        activeOpacity={0.7}
      >
        <View style={styles.accountInfo}>
          <Text style={styles.icon}>
            {item.icon ?? DEFAULT_ICONS[item.type]}
          </Text>
          <Text
            style={[styles.accountName, { color: colors.text }]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
        </View>
        <Text
          style={[
            styles.accountBalance,
            {
              color: balanceColor(item.currentBalance, colors),
            },
          ]}
        >
          {formatCurrency(item.currentBalance)}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderRightColor: colors.border },
      ]}
    >
      <TouchableOpacity
        style={[
          styles.row,
          isAllActive && { backgroundColor: colors.tintLight },
        ]}
        onPress={() => router.replace('/account/all' as any)}
        activeOpacity={0.7}
      >
        <Text style={[styles.allLabel, { color: colors.text }]}>
          All Accounts
        </Text>
        <Text
          style={[
            styles.allBalance,
            { color: balanceColor(totalBalance, colors) },
          ]}
        >
          {formatCurrency(totalBalance)}
        </Text>
      </TouchableOpacity>

      <View style={[styles.sep, { backgroundColor: colors.border }]} />

      <FlatList
        data={activeAccounts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => renderRow(item, false)}
        ListFooterComponent={
          archivedAccounts.length > 0 ? (
            <View>
              <TouchableOpacity
                testID="sidebar-archived-toggle"
                style={styles.archivedToggle}
                onPress={() => setShowArchived((v) => !v)}
                activeOpacity={0.6}
                accessibilityRole="button"
              >
                <FontAwesome
                  name={showArchived ? 'chevron-down' : 'chevron-right'}
                  size={10}
                  color={colors.textSecondary}
                />
                <Text
                  style={[
                    styles.archivedToggleText,
                    { color: colors.textSecondary },
                  ]}
                >
                  {`Archived (${archivedAccounts.length})`}
                </Text>
              </TouchableOpacity>
              {showArchived
                ? archivedAccounts.map((item) => renderRow(item, true))
                : null}
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 260,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  allLabel: { fontSize: 14, fontWeight: '600' },
  allBalance: { fontSize: 13, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth },
  accountInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  archivedRow: { opacity: 0.6 },
  archivedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  archivedToggleText: { fontSize: 12, fontWeight: '600' },
  icon: { fontSize: 18 },
  accountName: { fontSize: 13, fontWeight: '500', flex: 1 },
  accountBalance: { fontSize: 12, fontWeight: '600', marginLeft: 8 },
});

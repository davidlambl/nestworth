import React from 'react';
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
import { formatCurrency } from '@/lib/format';
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

  const activeAccounts: AccountWithBalance[] =
    accounts?.filter((a: AccountWithBalance) => !a.isArchived) ?? [];
  const totalBalance = activeAccounts
    .filter((a) => !a.excludeFromTotal)
    .reduce((s, a) => s + a.currentBalance, 0);

  const isAllActive = activeAccountId === '__all__';

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
            { color: totalBalance >= 0 ? colors.income : colors.expense },
          ]}
        >
          {formatCurrency(totalBalance)}
        </Text>
      </TouchableOpacity>

      <View style={[styles.sep, { backgroundColor: colors.border }]} />

      <FlatList
        data={activeAccounts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const isActive = item.id === activeAccountId;
          return (
            <TouchableOpacity
              style={[
                styles.row,
                isActive && { backgroundColor: colors.tintLight },
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
                    color:
                      item.currentBalance >= 0
                        ? colors.income
                        : colors.expense,
                  },
                ]}
              >
                {formatCurrency(item.currentBalance)}
              </Text>
            </TouchableOpacity>
          );
        }}
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
  icon: { fontSize: 18 },
  accountName: { fontSize: 13, fontWeight: '500', flex: 1 },
  accountBalance: { fontSize: 12, fontWeight: '600', marginLeft: 8 },
});

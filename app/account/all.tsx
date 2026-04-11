import React, { useMemo, useState, useLayoutEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { router, useNavigation } from 'expo-router';
import { AccountsPanel } from '@/components/AccountsPanel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import { useTheme } from '@/lib/theme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort, balanceColor } from '@/lib/format';
import { useAccounts } from '@/lib/hooks/useAccounts';
import {
  useAllTransactions,
  useUpdateTransaction,
  useDeleteTransaction,
} from '@/lib/hooks/useTransactions';
import type { TransactionWithSplits } from '@/lib/types';

export default function AllAccountsRegisterScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { fontScale } = useTheme();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  const { data: accounts } = useAccounts();
  const { data: transactions, isLoading } = useAllTransactions();
  const updateTxn = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'All Accounts' });
  }, [navigation]);

  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts ?? []) {
      map.set(a.id, a.name);
    }
    return map;
  }, [accounts]);

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] =
    useState<'all' | 'pending' | 'cleared'>('all');

  const filtered = useMemo(() => {
    if (!transactions) {
      return [];
    }
    let list = transactions;
    if (filterStatus === 'pending') {
      list = list.filter((t) => t.status === 'pending');
    } else if (filterStatus === 'cleared') {
      list = list.filter(
        (t) => t.status === 'cleared' || t.status === 'reconciled'
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.payee.toLowerCase().includes(q) ||
          (t.memo?.toLowerCase().includes(q) ?? false) ||
          (t.checkNumber?.includes(q) ?? false) ||
          (accountNames.get(t.accountId)?.toLowerCase().includes(q) ?? false)
      );
    }
    return list;
  }, [transactions, search, filterStatus, accountNames]);

  const toggleStatus = (txn: TransactionWithSplits) => {
    const next = txn.status === 'pending' ? 'cleared' : 'pending';
    updateTxn.mutate({
      id: txn.id,
      accountId: txn.accountId,
      status: next,
    });
  };

  const balanceSummary = useMemo(() => {
    if (!accounts || !transactions) {
      return { cleared: 0, outstanding: 0, balance: 0 };
    }
    let clearedSum = 0;
    for (const a of accounts.filter((a) => !a.isArchived)) {
      clearedSum += a.initialBalance;
    }
    let outstandingSum = 0;
    for (const t of transactions) {
      if (t.status === 'pending') {
        outstandingSum += t.amount;
      } else {
        clearedSum += t.amount;
      }
    }
    return {
      cleared: clearedSum,
      outstanding: outstandingSum,
      balance: clearedSum + outstandingSum,
    };
  }, [accounts, transactions]);

  const handleDelete = (txn: TransactionWithSplits) => {
    const msg = `Delete this ${txn.payee} transaction?`;
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        deleteTxn.mutate({ id: txn.id, accountId: txn.accountId });
      }
    } else {
      Alert.alert('Delete Transaction', msg, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            deleteTxn.mutate({ id: txn.id, accountId: txn.accountId }),
        },
      ]);
    }
  };

  const renderTransaction = ({ item }: { item: TransactionWithSplits }) => (
    <Pressable
      style={[styles.txnRow, { borderBottomColor: colors.separator }]}
      onPress={() =>
        router.push(`/transaction/${item.id}?accountId=${item.accountId}`)
      }
      onLongPress={() => handleDelete(item)}
    >
      <TouchableOpacity
        style={styles.statusBtn}
        onPress={(e) => {
          e.stopPropagation();
          toggleStatus(item);
        }}
        hitSlop={8}
      >
        <FontAwesome
          name={item.status === 'pending' ? 'square-o' : 'check-square-o'}
          size={20}
          color={item.status === 'pending' ? colors.placeholder : colors.income}
        />
      </TouchableOpacity>

      <View style={styles.txnCenter}>
        <Text style={[styles.txnPayee, {
          color: colors.text,
          fontSize: 15 * fontScale,
        }]} numberOfLines={1}>
          {item.payee || '(no payee)'}
        </Text>
        <View style={styles.txnMeta}>
          <Text style={[styles.txnDate, {
            color: colors.textSecondary,
            fontSize: 13 * fontScale,
          }]}>
            {formatDateShort(item.txnDate)}
          </Text>
          <Text
            style={[styles.txnAccount, {
              color: colors.tint,
              fontSize: 13 * fontScale,
            }]}
            numberOfLines={1}
          >
            {accountNames.get(item.accountId) ?? 'Unknown'}
          </Text>
          {item.memo ? (
            <Text
              style={[styles.txnMemo, {
                color: colors.textSecondary,
                fontSize: 13 * fontScale,
              }]}
              numberOfLines={1}
            >
              {item.memo}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.txnRight}>
        <Text
          style={[
            styles.txnAmount,
            {
              color: item.amount >= 0 ? colors.income : colors.expense,
              fontSize: 15 * fontScale,
            },
          ]}
        >
          {formatCurrency(item.amount)}
        </Text>
      </View>
    </Pressable>
  );

  if (isLoading) {
    const loading = (
      <View style={[styles.center, { flex: 1, backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
    if (!isWide) {
      return loading;
    }
    return (
      <View style={styles.wideRow}>
        <AccountsPanel activeAccountId="__all__" />
        {loading}
      </View>
    );
  }

  const register = (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.searchBar, { backgroundColor: colors.surface }]}>
        <FontAwesome name="search" size={16} color={colors.placeholder} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search transactions..."
          placeholderTextColor={colors.placeholder}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <View style={styles.filterRow}>
        {(['all', 'pending', 'cleared'] as const).map((s) => (
          <TouchableOpacity
            key={s}
            style={[
              styles.filterChip,
              {
                backgroundColor:
                  filterStatus === s ? colors.tint : colors.surface,
                borderColor:
                  filterStatus === s ? colors.tint : colors.border,
              },
            ]}
            onPress={() => setFilterStatus(s)}
          >
            <Text
              style={[
                styles.filterChipText,
                { color: filterStatus === s ? '#fff' : colors.text },
              ]}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <FontAwesome name="list-alt" size={48} color={colors.placeholder} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No transactions
            </Text>
          </View>
        }
      />

      <View
        style={[
          styles.balanceFooter,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
          },
        ]}
      >
        <View style={styles.balanceRow}>
          <Text style={[styles.balanceLabel, {
            color: colors.textSecondary,
            fontSize: 13 * fontScale,
          }]}>
            Cleared:
          </Text>
          <Text style={[styles.balanceValue, {
            color: colors.text,
            fontSize: 13 * fontScale,
          }]}>
            {formatCurrency(balanceSummary.cleared)}
          </Text>
        </View>
        <View style={styles.balanceRow}>
          <Text style={[styles.balanceLabel, {
            color: colors.textSecondary,
            fontSize: 13 * fontScale,
          }]}>
            Outstanding:
          </Text>
          <Text style={[styles.balanceValue, {
            color: colors.text,
            fontSize: 13 * fontScale,
          }]}>
            {formatCurrency(balanceSummary.outstanding)}
          </Text>
        </View>
        <View style={styles.balanceRow}>
          <Text style={[styles.balanceTotalLabel, {
            color: colors.text,
            fontSize: 14 * fontScale,
          }]}>
            Balance:
          </Text>
          <Text
            style={[
              styles.balanceTotalValue,
              {
                color: balanceColor(balanceSummary.balance, colors),
                fontSize: 14 * fontScale,
              },
            ]}
          >
            {formatCurrency(balanceSummary.balance)}
          </Text>
        </View>
      </View>
    </View>
  );

  if (!isWide) {
    return register;
  }

  return (
    <View style={styles.wideRow}>
      <AccountsPanel activeAccountId="__all__" />
      {register}
    </View>
  );
}

const styles = StyleSheet.create({
  wideRow: { flex: 1, flexDirection: 'row' },
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    height: 42,
    borderRadius: 10,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    height: 42,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterChipText: { fontSize: 13, fontWeight: '500' },
  list: { paddingBottom: 120 },
  txnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  statusBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  txnCenter: { flex: 1 },
  txnPayee: { fontSize: 15, fontWeight: '500' },
  txnMeta: { flexDirection: 'row', gap: 8, marginTop: 3 },
  txnDate: { fontSize: 13 },
  txnAccount: { fontSize: 13, fontWeight: '500' },
  txnMemo: { fontSize: 13, flex: 1 },
  txnRight: { alignItems: 'flex-end' },
  txnAmount: { fontSize: 15, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 18, fontWeight: '600' },
  balanceFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 36,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  balanceLabel: { fontSize: 13, fontWeight: '500' },
  balanceValue: { fontSize: 13, fontWeight: '600' },
  balanceTotalLabel: { fontSize: 15, fontWeight: '700' },
  balanceTotalValue: { fontSize: 15, fontWeight: '700' },
});

import React, { useMemo, useState, useLayoutEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { useLocalSearchParams, router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort } from '@/lib/format';
import { useAccount } from '@/lib/hooks/useAccounts';
import {
  useTransactions,
  useDeleteTransaction,
  useUpdateTransaction,
} from '@/lib/hooks/useTransactions';
import type { TransactionWithSplits, TransactionStatus } from '@/lib/types';

const STATUS_ICON: Record<TransactionStatus, string> = {
  pending: 'circle-o',
  cleared: 'check-circle-o',
  reconciled: 'lock',
};

export default function AccountRegisterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const navigation = useNavigation();
  const { data: account } = useAccount(id);
  const { data: transactions, isLoading } = useTransactions(id);
  const deleteTxn = useDeleteTransaction();
  const updateTxn = useUpdateTransaction();

  useLayoutEffect(() => {
    navigation.setOptions({
      title: account?.name ?? 'Register',
      headerRight: () => (
        <TouchableOpacity
          onPress={() => router.push(`/account/reconcile?accountId=${id}`)}
          style={{ marginRight: 8 }}
          hitSlop={8}
        >
          <FontAwesome name="check-square-o" size={22} color={colors.tint} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, account, colors]);

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<TransactionStatus | 'all'>('all');

  const filtered = useMemo(() => {
    if (!transactions) {
      return [];
    }
    let list = transactions;
    if (filterStatus !== 'all') {
      list = list.filter((t) => t.status === filterStatus);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.payee.toLowerCase().includes(q) ||
          (t.memo?.toLowerCase().includes(q) ?? false) ||
          (t.checkNumber?.includes(q) ?? false)
      );
    }
    return list;
  }, [transactions, search, filterStatus]);

  const runningBalances = useMemo(() => {
    if (!account || !filtered.length) {
      return new Map<string, number>();
    }
    const sorted = [...filtered].sort((a, b) => {
      const dc = a.txnDate.localeCompare(b.txnDate);
      return dc !== 0 ? dc : a.createdAt.localeCompare(b.createdAt);
    });
    const map = new Map<string, number>();
    let bal = account.initialBalance;
    if (transactions) {
      const earlier = transactions.filter(
        (t) => !filtered.includes(t)
      );
      for (const t of earlier.sort((a, b) =>
        a.txnDate.localeCompare(b.txnDate)
      )) {
        bal += t.amount;
      }
    }
    for (const t of sorted) {
      bal += t.amount;
      map.set(t.id, bal);
    }
    return map;
  }, [account, filtered, transactions]);

  const cycleStatus = (txn: TransactionWithSplits) => {
    if (txn.status === 'reconciled') {
      return;
    }
    const next: TransactionStatus = txn.status === 'pending' ? 'cleared' : 'reconciled';
    updateTxn.mutate({
      id: txn.id,
      accountId: id,
      status: next,
    });
  };

  const handleDelete = (txn: TransactionWithSplits) => {
    Alert.alert('Delete Transaction', `Delete this ${txn.payee} transaction?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteTxn.mutate({ id: txn.id, accountId: id }),
      },
    ]);
  };

  const renderTransaction = ({ item }: { item: TransactionWithSplits }) => {
    const balance = runningBalances.get(item.id);
    return (
      <TouchableOpacity
        style={[styles.txnRow, { borderBottomColor: colors.separator }]}
        onPress={() => router.push(`/transaction/${item.id}?accountId=${id}`)}
        onLongPress={() => handleDelete(item)}
        activeOpacity={0.7}
      >
        <TouchableOpacity
          style={styles.statusBtn}
          onPress={() => cycleStatus(item)}
          hitSlop={8}
        >
          <FontAwesome
            name={STATUS_ICON[item.status] as any}
            size={20}
            color={
              item.status === 'reconciled'
                ? colors.tint
                : item.status === 'cleared'
                  ? colors.income
                  : colors.placeholder
            }
          />
        </TouchableOpacity>

        <View style={styles.txnCenter}>
          <Text style={[styles.txnPayee, { color: colors.text }]} numberOfLines={1}>
            {item.payee || '(no payee)'}
          </Text>
          <View style={styles.txnMeta}>
            <Text style={[styles.txnDate, { color: colors.textSecondary }]}>
              {formatDateShort(item.txnDate)}
            </Text>
            {item.checkNumber ? (
              <Text style={[styles.txnCheck, { color: colors.textSecondary }]}>
                #{item.checkNumber}
              </Text>
            ) : null}
            {item.memo ? (
              <Text
                style={[styles.txnMemo, { color: colors.textSecondary }]}
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
              { color: item.amount >= 0 ? colors.income : colors.expense },
            ]}
          >
            {formatCurrency(item.amount)}
          </Text>
          {balance !== undefined && (
            <Text style={[styles.txnBalance, { color: colors.textSecondary }]}>
              {formatCurrency(balance)}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
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
        {(['all', 'pending', 'cleared', 'reconciled'] as const).map((s) => (
          <TouchableOpacity
            key={s}
            style={[
              styles.filterChip,
              {
                backgroundColor: filterStatus === s ? colors.tint : colors.surface,
                borderColor: filterStatus === s ? colors.tint : colors.border,
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

      <TouchableOpacity
        style={[styles.fabSecondary, { backgroundColor: colors.surface, borderColor: colors.border }]}
        onPress={() => router.push('/transaction/transfer')}
      >
        <FontAwesome name="exchange" size={18} color={colors.tint} />
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.tint }]}
        onPress={() => router.push(`/transaction/new?accountId=${id}`)}
      >
        <FontAwesome name="plus" size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
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
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterChipText: { fontSize: 13, fontWeight: '500' },
  list: { paddingBottom: 100 },
  txnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  statusBtn: { width: 28, alignItems: 'center' },
  txnCenter: { flex: 1 },
  txnPayee: { fontSize: 15, fontWeight: '500' },
  txnMeta: { flexDirection: 'row', gap: 8, marginTop: 3 },
  txnDate: { fontSize: 12 },
  txnCheck: { fontSize: 12 },
  txnMemo: { fontSize: 12, flex: 1 },
  txnRight: { alignItems: 'flex-end' },
  txnAmount: { fontSize: 15, fontWeight: '600' },
  txnBalance: { fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 18, fontWeight: '600' },
  fabSecondary: {
    position: 'absolute',
    bottom: 24,
    right: 92,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});

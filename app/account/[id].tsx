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
import { useLocalSearchParams, router, useNavigation } from 'expo-router';
import { AccountsPanel } from '@/components/AccountsPanel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import { useTheme } from '@/lib/theme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort, balanceColor } from '@/lib/format';
import { useAccount } from '@/lib/hooks/useAccounts';
import {
  useTransactions,
  useDeleteTransaction,
  useUpdateTransaction,
} from '@/lib/hooks/useTransactions';
import type { TransactionWithSplits } from '@/lib/types';
import {
  filterTransactions,
  computeRunningBalances,
  computeBalanceSummary,
} from '@/lib/register';

export default function AccountRegisterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { fontScale } = useTheme();
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  const navigation = useNavigation();
  const { data: account } = useAccount(id);
  const { data: transactions, isLoading } = useTransactions(id);
  const deleteTxn = useDeleteTransaction();
  const updateTxn = useUpdateTransaction();

  useLayoutEffect(() => {
    navigation.setOptions({
      title: account?.name ?? 'Register',
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingRight: 8 }}>
          <TouchableOpacity
            testID="register-transfer-btn"
            onPress={() => router.push(`/transaction/transfer?fromAccountId=${id}`)}
            hitSlop={8}
          >
            <FontAwesome name="exchange" size={16} color={colors.tint} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="register-add-btn"
            onPress={() => router.push(`/transaction/new?accountId=${id}`)}
            hitSlop={8}
          >
            <FontAwesome name="plus" size={20} color={colors.tint} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, account, colors, id]);

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'cleared'>('all');

  const filtered = useMemo(
    () => filterTransactions(transactions, filterStatus, search),
    [transactions, search, filterStatus],
  );

  const runningBalances = useMemo(
    () =>
      account
        ? computeRunningBalances(account.initialBalance, transactions ?? [], filtered)
        : new Map<string, number>(),
    [account, filtered, transactions],
  );

  const toggleStatus = (txn: TransactionWithSplits) => {
    const next = txn.status === 'pending' ? 'cleared' : 'pending';
    updateTxn.mutate({
      id: txn.id,
      accountId: id,
      status: next,
    });
  };

  const balanceSummary = useMemo(
    () => computeBalanceSummary(account?.initialBalance ?? 0, account ? transactions : undefined),
    [account, transactions],
  );

  const handleDelete = (txn: TransactionWithSplits) => {
    const msg = `Delete this ${txn.payee} transaction?`;
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        deleteTxn.mutate({ id: txn.id, accountId: id });
      }
    } else {
      Alert.alert('Delete Transaction', msg, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteTxn.mutate({ id: txn.id, accountId: id }),
        },
      ]);
    }
  };

  const renderTransaction = ({ item }: { item: TransactionWithSplits }) => {
    const balance = runningBalances.get(item.id);
    return (
      <Pressable
        style={[styles.txnRow, { borderBottomColor: colors.separator }]}
        onPress={() => router.push(`/transaction/${item.id}?accountId=${id}`)}
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
            {item.checkNumber ? (
              <Text style={[styles.txnCheck, {
                color: colors.textSecondary,
                fontSize: 13 * fontScale,
              }]}>
                #{item.checkNumber}
              </Text>
            ) : null}
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
          {balance !== undefined && (
            <Text style={[styles.txnBalance, {
              color: colors.textSecondary,
              fontSize: 12 * fontScale,
            }]}>
              {formatCurrency(balance)}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

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
        <AccountsPanel activeAccountId={id} />
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

      <View style={[styles.balanceFooter, {
        backgroundColor: colors.surface,
        borderTopColor: colors.border,
      }]}>
        <View style={styles.balanceRow}>
          <Text style={[styles.balanceLabel, {
            color: colors.textSecondary,
            fontSize: 13 * fontScale,
          }]}>Cleared:</Text>
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
          }]}>Outstanding:</Text>
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
          }]}>Balance:</Text>
          <Text style={[styles.balanceTotalValue, {
            color: balanceColor(balanceSummary.balance, colors),
            fontSize: 14 * fontScale,
          }]}>
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
      <AccountsPanel activeAccountId={id} />
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
  txnCheck: { fontSize: 13 },
  txnMemo: { fontSize: 13, flex: 1 },
  txnRight: { alignItems: 'flex-end' },
  txnAmount: { fontSize: 15, fontWeight: '600' },
  txnBalance: { fontSize: 13, marginTop: 2 },
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

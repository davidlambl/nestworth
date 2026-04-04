import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort } from '@/lib/format';
import { useAccount } from '@/lib/hooks/useAccounts';
import { useTransactions, useUpdateTransaction } from '@/lib/hooks/useTransactions';
import type { TransactionWithSplits } from '@/lib/types';

export default function ReconcileScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const { data: account } = useAccount(accountId);
  const { data: transactions, isLoading } = useTransactions(accountId);
  const updateTxn = useUpdateTransaction();

  const [statementBalance, setStatementBalance] = useState('');
  const [localCleared, setLocalCleared] = useState<Set<string>>(new Set());

  const unreconciledTxns = useMemo(() => {
    if (!transactions) {
      return [];
    }
    return transactions.filter((t) => t.status !== 'reconciled');
  }, [transactions]);

  const isTxnCleared = (txn: TransactionWithSplits) =>
    txn.status === 'cleared' || localCleared.has(txn.id);

  const clearedTotal = useMemo(() => {
    if (!account || !transactions) {
      return 0;
    }
    let bal = account.initialBalance;
    for (const t of transactions) {
      if (t.status === 'reconciled' || isTxnCleared(t)) {
        bal += t.amount;
      }
    }
    return bal;
  }, [account, transactions, localCleared]);

  const targetBal = parseFloat(statementBalance) || 0;
  const difference = targetBal - clearedTotal;

  const toggleCleared = (txn: TransactionWithSplits) => {
    setLocalCleared((prev) => {
      const next = new Set(prev);
      if (next.has(txn.id)) {
        next.delete(txn.id);
      } else {
        next.add(txn.id);
      }
      return next;
    });
  };

  const handleReconcile = async () => {
    if (Math.abs(difference) > 0.01) {
      Alert.alert(
        'Balance mismatch',
        `The difference is ${formatCurrency(difference)}. Cleared total must match statement balance.`
      );
      return;
    }

    for (const txn of unreconciledTxns) {
      if (isTxnCleared(txn)) {
        await updateTxn.mutateAsync({
          id: txn.id,
          accountId,
          status: 'reconciled',
        });
      }
    }

    Alert.alert('Reconciled', 'All cleared transactions have been reconciled.', [
      { text: 'OK', onPress: () => router.back() },
    ]);
  };

  const renderTransaction = ({ item }: { item: TransactionWithSplits }) => {
    const cleared = isTxnCleared(item);
    return (
      <TouchableOpacity
        style={[styles.txnRow, { borderBottomColor: colors.separator }]}
        onPress={() => toggleCleared(item)}
        activeOpacity={0.7}
      >
        <FontAwesome
          name={cleared ? 'check-square-o' : 'square-o'}
          size={22}
          color={cleared ? colors.income : colors.placeholder}
        />
        <View style={styles.txnCenter}>
          <Text style={[styles.txnPayee, { color: colors.text }]} numberOfLines={1}>
            {item.payee || '(no payee)'}
          </Text>
          <Text style={[styles.txnDate, { color: colors.textSecondary }]}>
            {formatDateShort(item.txnDate)}
          </Text>
        </View>
        <Text
          style={[
            styles.txnAmount,
            { color: item.amount >= 0 ? colors.income : colors.expense },
          ]}
        >
          {formatCurrency(item.amount)}
        </Text>
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
      <View style={[styles.header, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerLabel, { color: colors.textSecondary }]}>
            Statement Balance
          </Text>
          <TextInput
            style={[styles.balanceInput, {
              color: colors.text,
              borderColor: colors.border,
              backgroundColor: colors.background,
            }]}
            value={statementBalance}
            onChangeText={setStatementBalance}
            placeholder="0.00"
            placeholderTextColor={colors.placeholder}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={styles.headerRow}>
          <Text style={[styles.headerLabel, { color: colors.textSecondary }]}>
            Cleared Total
          </Text>
          <Text style={[styles.headerValue, { color: colors.text }]}>
            {formatCurrency(clearedTotal)}
          </Text>
        </View>
        <View style={styles.headerRow}>
          <Text style={[styles.headerLabel, { color: colors.textSecondary }]}>
            Difference
          </Text>
          <Text style={[styles.headerValue, {
            color: Math.abs(difference) < 0.01 ? colors.income : colors.expense,
            fontWeight: '700',
          }]}>
            {formatCurrency(difference)}
          </Text>
        </View>
      </View>

      <Text style={[styles.sectionTitle, { color: colors.text }]}>
        Unreconciled Transactions ({unreconciledTxns.length})
      </Text>

      <FlatList
        data={unreconciledTxns}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        contentContainerStyle={styles.list}
      />

      <View style={[styles.footer, { backgroundColor: colors.surface }]}>
        <TouchableOpacity
          style={[styles.reconcileBtn, {
            backgroundColor: Math.abs(difference) < 0.01 ? colors.tint : colors.placeholder,
          }]}
          onPress={handleReconcile}
          disabled={Math.abs(difference) >= 0.01 || updateTxn.isPending}
        >
          {updateTxn.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.reconcileBtnText}>Reconcile</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLabel: { fontSize: 14 },
  headerValue: { fontSize: 16, fontWeight: '600' },
  balanceInput: {
    width: 140,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'right',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  list: { paddingBottom: 100 },
  txnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  txnCenter: { flex: 1 },
  txnPayee: { fontSize: 15, fontWeight: '500' },
  txnDate: { fontSize: 12, marginTop: 2 },
  txnAmount: { fontSize: 15, fontWeight: '600' },
  footer: {
    padding: 16,
    paddingBottom: 32,
  },
  reconcileBtn: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reconcileBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});

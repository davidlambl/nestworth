import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import {
  useTransaction,
  useUpdateTransaction,
  useDeleteTransaction,
} from '@/lib/hooks/useTransactions';
import { useCategories } from '@/lib/hooks/useCategories';
import type { TransactionStatus } from '@/lib/types';

export default function EditTransactionScreen() {
  const { id, accountId } = useLocalSearchParams<{ id: string; accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const { data: txn, isLoading } = useTransaction(id);
  const updateTxn = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();
  const { data: categories } = useCategories();

  const [date, setDate] = useState('');
  const [payee, setPayee] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState<TransactionStatus>('pending');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  useEffect(() => {
    if (txn) {
      setDate(txn.txnDate);
      setPayee(txn.payee);
      setAmountStr(String(Math.abs(txn.amount)));
      setIsExpense(txn.amount < 0);
      setCheckNumber(txn.checkNumber ?? '');
      setMemo(txn.memo ?? '');
      setStatus(txn.status);
      setCategoryId(txn.splits[0]?.categoryId ?? null);
    }
  }, [txn]);

  const acctId = accountId || txn?.accountId || '';

  const handleSave = () => {
    const amt = parseFloat(amountStr);
    if (isNaN(amt) || amt === 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount.');
      return;
    }

    const finalAmount = isExpense ? -Math.abs(amt) : Math.abs(amt);

    updateTxn.mutate(
      {
        id,
        accountId: acctId,
        txnDate: date,
        payee: payee.trim(),
        amount: finalAmount,
        checkNumber: checkNumber || null,
        memo: memo || null,
        status,
        splits: categoryId
          ? [{ categoryId, amount: finalAmount, memo: null }]
          : [],
      },
      {
        onSuccess: () => router.back(),
      }
    );
  };

  const handleDelete = () => {
    Alert.alert('Delete Transaction', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteTxn.mutate(
            { id, accountId: acctId },
            { onSuccess: () => router.back() }
          );
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.form}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Date</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Payee</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={payee}
          onChangeText={setPayee}
          placeholder="Payee"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Amount</Text>
        <View style={styles.amountRow}>
          <TouchableOpacity
            style={[
              styles.typeToggle,
              {
                backgroundColor: isExpense ? colors.expenseLight : colors.incomeLight,
                borderColor: isExpense ? colors.expense : colors.income,
              },
            ]}
            onPress={() => setIsExpense(!isExpense)}
          >
            <FontAwesome
              name={isExpense ? 'minus' : 'plus'}
              size={14}
              color={isExpense ? colors.expense : colors.income}
            />
            <Text style={{ color: isExpense ? colors.expense : colors.income, fontWeight: '600' }}>
              {isExpense ? 'Expense' : 'Income'}
            </Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.amountInput, {
              backgroundColor: colors.surface,
              color: colors.text,
              borderColor: colors.border,
            }]}
            value={amountStr}
            onChangeText={setAmountStr}
            placeholder="0.00"
            placeholderTextColor={colors.placeholder}
            keyboardType="decimal-pad"
          />
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Check #</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={checkNumber}
          onChangeText={setCheckNumber}
          placeholder="Optional"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Category</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll}>
          <TouchableOpacity
            style={[
              styles.catChip,
              {
                backgroundColor: categoryId === null ? colors.tint : colors.surface,
                borderColor: categoryId === null ? colors.tint : colors.border,
              },
            ]}
            onPress={() => setCategoryId(null)}
          >
            <Text style={{
              color: categoryId === null ? '#fff' : colors.text,
              fontSize: 13,
              fontWeight: '500',
            }}>
              None
            </Text>
          </TouchableOpacity>
          {(categories ?? [])
            .filter((c) => (isExpense ? c.type === 'expense' : c.type === 'income'))
            .map((c) => (
              <TouchableOpacity
                key={c.id}
                style={[
                  styles.catChip,
                  {
                    backgroundColor: categoryId === c.id ? colors.tint : colors.surface,
                    borderColor: categoryId === c.id ? colors.tint : colors.border,
                  },
                ]}
                onPress={() => setCategoryId(c.id)}
              >
                <Text style={{
                  color: categoryId === c.id ? '#fff' : colors.text,
                  fontSize: 13,
                  fontWeight: '500',
                }}>
                  {c.name}
                </Text>
              </TouchableOpacity>
            ))}
        </ScrollView>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Memo</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={memo}
          onChangeText={setMemo}
          placeholder="Optional note"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Status</Text>
        <View style={styles.statusRow}>
          {(['pending', 'cleared', 'reconciled'] as TransactionStatus[]).map((s) => (
            <TouchableOpacity
              key={s}
              style={[
                styles.statusChip,
                {
                  backgroundColor: status === s ? colors.tint : colors.surface,
                  borderColor: status === s ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setStatus(s)}
            >
              <Text
                style={{
                  color: status === s ? '#fff' : colors.text,
                  fontSize: 13,
                  fontWeight: '500',
                }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: colors.tint }]}
          onPress={handleSave}
          disabled={updateTxn.isPending}
        >
          {updateTxn.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.deleteBtn, { borderColor: colors.destructive }]}
          onPress={handleDelete}
        >
          <Text style={[styles.deleteBtnText, { color: colors.destructive }]}>
            Delete Transaction
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  form: { padding: 20 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 16 },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  amountRow: { flexDirection: 'row', gap: 10 },
  typeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
  },
  amountInput: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 20,
    fontWeight: '600',
  },
  catScroll: { marginBottom: 4 },
  catChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
  },
  statusRow: { flexDirection: 'row', gap: 8 },
  statusChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
  },
  saveBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  deleteBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    borderWidth: 1,
  },
  deleteBtnText: { fontSize: 16, fontWeight: '600' },
});

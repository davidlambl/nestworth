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
  KeyboardAvoidingView,
  Platform,
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

export default function EditTransactionScreen() {
  const { id, accountId } = useLocalSearchParams<{ id: string; accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const { data: txn, isLoading } = useTransaction(id);
  const updateTxn = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();

  const [date, setDate] = useState('');
  const [payee, setPayee] = useState('');
  const [amountCents, setAmountCents] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');

  const displayAmount = useMemo(() => {
    const cents = parseInt(amountCents || '0', 10);
    return (cents / 100).toFixed(2);
  }, [amountCents]);

  const handleAmountChange = (text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    setAmountCents(digits.replace(/^0+/, '') || '');
  };

  useEffect(() => {
    if (txn) {
      setDate(txn.txnDate);
      setPayee(txn.payee);
      setAmountCents(String(Math.round(Math.abs(txn.amount) * 100)));
      setIsExpense(txn.amount < 0);
      setCheckNumber(txn.checkNumber ?? '');
      setMemo(txn.memo ?? '');
    }
  }, [txn]);

  const acctId = accountId || txn?.accountId || '';

  const handleSave = () => {
    const amt = parseInt(amountCents || '0', 10) / 100;
    if (amt === 0) {
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <ScrollView
      style={{ backgroundColor: colors.background }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
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
            value={displayAmount}
            onChangeText={handleAmountChange}
            placeholder="0.00"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            selection={{ start: displayAmount.length, end: displayAmount.length }}
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

        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
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

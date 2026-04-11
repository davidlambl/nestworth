import React, { useState, useEffect, useMemo, useLayoutEffect } from 'react';
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
import { useLocalSearchParams, router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import {
  useTransaction,
  useUpdateTransaction,
  useDeleteTransaction,
} from '@/lib/hooks/useTransactions';
import { useAccount } from '@/lib/hooks/useAccounts';
import { useReceiptPhoto } from '@/lib/hooks/useReceiptPhoto';
import { useTheme } from '@/lib/theme';

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function EditTransactionScreen() {
  const { id, accountId } = useLocalSearchParams<{ id: string; accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

  const { data: txn, isLoading } = useTransaction(id);
  const acctIdForQuery = accountId || txn?.accountId || '';
  const { data: accountData } = useAccount(acctIdForQuery);
  const updateTxn = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();
  const { pickPhoto, takePhoto, uploadPhoto, uploading, photoUri, clearPhoto } =
    useReceiptPhoto();
  const { fontScale } = useTheme();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ paddingLeft: 16 }}
        >
          <Text style={{ color: colors.tint, fontSize: 16 }}>Cancel</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const [date, setDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
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

  const acctId = acctIdForQuery;

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
        onSuccess: async () => {
          if (photoUri) {
            await uploadPhoto(photoUri, id);
          }
          router.back();
        },
      }
    );
  };

  const handleDelete = () => {
    const msg = 'Delete this transaction?';
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        deleteTxn.mutate(
          { id, accountId: acctId },
          { onSuccess: () => router.back() }
        );
      }
    } else {
      Alert.alert('Delete Transaction', msg, [
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
    }
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
        {accountData && (
          <View style={[styles.accountBadge, { backgroundColor: colors.surface }]}>
            <FontAwesome name="bank" size={12} color={colors.tint} />
            <Text style={[styles.accountBadgeText, {
              color: colors.text,
              fontSize: 13 * fontScale,
            }]}>
              {accountData.name}
            </Text>
          </View>
        )}

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Date
        </Text>
        {Platform.OS === 'web' ? (
          <TextInput
            style={[styles.input, {
              backgroundColor: colors.surface,
              color: colors.text,
              borderColor: colors.border,
              fontSize: 16 * fontScale,
            }]}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.placeholder}
          />
        ) : date ? (
          <>
            {Platform.OS === 'android' && (
              <TouchableOpacity
                style={[styles.dateBtn, {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                }]}
                onPress={() => setShowDatePicker(true)}
              >
                <FontAwesome name="calendar" size={16} color={colors.tint} />
                <Text style={[styles.dateBtnText, { color: colors.text }]}>
                  {date}
                </Text>
              </TouchableOpacity>
            )}
            {showDatePicker && (
              <DateTimePicker
                value={parseDateStr(date)}
                mode="date"
                display={Platform.OS === 'ios' ? 'compact' : 'default'}
                onChange={(_e, selected) => {
                  if (Platform.OS === 'android') {
                    setShowDatePicker(false);
                  }
                  if (selected) {
                    setDate(formatDateStr(selected));
                  }
                }}
                themeVariant={colorScheme}
              />
            )}
          </>
        ) : null}

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Payee
        </Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
            fontSize: 16 * fontScale,
          }]}
          value={payee}
          onChangeText={setPayee}
          placeholder="Payee"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Amount
        </Text>
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
              fontSize: 20 * fontScale,
            }]}
            value={displayAmount}
            onChangeText={handleAmountChange}
            placeholder="0.00"
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            selection={{ start: displayAmount.length, end: displayAmount.length }}
          />
        </View>

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Check #
        </Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
            fontSize: 16 * fontScale,
          }]}
          value={checkNumber}
          onChangeText={setCheckNumber}
          placeholder="Optional"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
        />

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Memo
        </Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
            fontSize: 16 * fontScale,
          }]}
          value={memo}
          onChangeText={setMemo}
          placeholder="Optional note"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={[styles.label, { color: colors.textSecondary, fontSize: 13 * fontScale }]}>
          Receipt
        </Text>
        <View style={styles.receiptRow}>
          <TouchableOpacity
            style={[styles.receiptBtn, { borderColor: colors.border }]}
            onPress={takePhoto}
          >
            <FontAwesome name="camera" size={18} color={colors.tint} />
            <Text style={[styles.receiptBtnText, { color: colors.tint, fontSize: 13 * fontScale }]}>
              Camera
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.receiptBtn, { borderColor: colors.border }]}
            onPress={pickPhoto}
          >
            <FontAwesome name="image" size={18} color={colors.tint} />
            <Text style={[styles.receiptBtnText, { color: colors.tint, fontSize: 13 * fontScale }]}>
              Gallery
            </Text>
          </TouchableOpacity>
          {photoUri && (
            <View style={styles.receiptAttached}>
              <FontAwesome name="check-circle" size={16} color={colors.income} />
              <Text style={[styles.receiptAttachedText, { color: colors.income }]}>
                Attached
              </Text>
              <TouchableOpacity onPress={clearPhoto} hitSlop={8}>
                <FontAwesome name="times" size={14} color={colors.placeholder} />
              </TouchableOpacity>
            </View>
          )}
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: colors.tint }]}
          onPress={handleSave}
          disabled={updateTxn.isPending || uploading}
        >
          {updateTxn.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={[styles.saveBtnText, { fontSize: 17 * fontScale }]}>Save Changes</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.deleteBtn, { borderColor: colors.destructive }]}
          onPress={handleDelete}
        >
          <Text style={[styles.deleteBtnText, { color: colors.destructive, fontSize: 16 * fontScale }]}>
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
  form: { padding: 20, maxWidth: 600, alignSelf: 'center' as const, width: '100%' },
  accountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 4,
  },
  accountBadgeText: { fontSize: 13, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 16 },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  dateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
  },
  dateBtnText: { fontSize: 16 },
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
  receiptRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  receiptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  receiptBtnText: { fontSize: 13, fontWeight: '500' },
  receiptAttached: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 4,
  },
  receiptAttachedText: { fontSize: 13, fontWeight: '500' },
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

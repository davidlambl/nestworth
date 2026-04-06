import React, { useState, useMemo, useLayoutEffect } from 'react';
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
import { todayString } from '@/lib/format';
import { useCreateTransaction, useTransactions } from '@/lib/hooks/useTransactions';
import { useReceiptPhoto } from '@/lib/hooks/useReceiptPhoto';

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

export default function NewTransactionScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

  const createTxn = useCreateTransaction();
  const { data: existingTxns } = useTransactions(accountId);
  const { pickPhoto, takePhoto, uploadPhoto, uploading, photoUri, clearPhoto } =
    useReceiptPhoto();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity onPress={() => router.back()} style={{ paddingLeft: 16 }}>
          <Text style={{ color: colors.tint, fontSize: 16 }}>Cancel</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const [date, setDate] = useState(todayString());
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  const [payee, setPayee] = useState('');
  const [amountCents, setAmountCents] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false);

  const displayAmount = useMemo(() => {
    const cents = parseInt(amountCents || '0', 10);
    return (cents / 100).toFixed(2);
  }, [amountCents]);

  const handleAmountChange = (text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    setAmountCents(digits.replace(/^0+/, '') || '');
  };

  const nextCheckNumber = useMemo(() => {
    if (!existingTxns) {
      return '';
    }
    const nums = existingTxns
      .map((t) => parseInt(t.checkNumber ?? '', 10))
      .filter((n) => !isNaN(n));
    if (nums.length === 0) {
      return '';
    }
    return String(Math.max(...nums) + 1);
  }, [existingTxns]);

  const pastPayees = useMemo(() => {
    if (!existingTxns) {
      return [];
    }
    const seen = new Set<string>();
    return existingTxns
      .filter((t) => {
        if (!t.payee || seen.has(t.payee.toLowerCase())) {
          return false;
        }
        seen.add(t.payee.toLowerCase());
        return true;
      })
      .map((t) => t.payee);
  }, [existingTxns]);

  const payeeSuggestions = useMemo(() => {
    if (!payee.trim()) {
      return [];
    }
    const q = payee.toLowerCase();
    return pastPayees.filter((p) => p.toLowerCase().includes(q)).slice(0, 5);
  }, [payee, pastPayees]);

  const handleSave = () => {
    const amt = parseInt(amountCents || '0', 10) / 100;
    if (amt === 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount.');
      return;
    }
    if (!payee.trim()) {
      Alert.alert('Payee required', 'Please enter a payee name.');
      return;
    }

    const finalAmount = isExpense ? -Math.abs(amt) : Math.abs(amt);

    createTxn.mutate(
      {
        accountId,
        txnDate: date,
        payee: payee.trim(),
        amount: finalAmount,
        checkNumber: checkNumber || null,
        memo: memo || null,
        status: 'pending',
      },
      {
        onSuccess: async (txn) => {
          if (photoUri && txn) {
            await uploadPhoto(photoUri, txn.id);
          }
          router.back();
        },
      }
    );
  };

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
        {Platform.OS === 'web' ? (
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
        ) : (
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
        )}

        <Text style={[styles.label, { color: colors.textSecondary }]}>Payee</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={payee}
          onChangeText={(text) => {
            setPayee(text);
            setShowPayeeSuggestions(true);
          }}
          placeholder="Who was this payment to/from?"
          placeholderTextColor={colors.placeholder}
          onBlur={() => setTimeout(() => setShowPayeeSuggestions(false), 200)}
        />
        {showPayeeSuggestions && payeeSuggestions.length > 0 && (
          <View style={[styles.suggestions, {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          }]}>
            {payeeSuggestions.map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.suggestionItem, { borderBottomColor: colors.separator }]}
                onPress={() => {
                  setPayee(p);
                  setShowPayeeSuggestions(false);
                }}
              >
                <Text style={[styles.suggestionText, { color: colors.text }]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

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
        <View style={styles.checkRow}>
          <TextInput
            style={[styles.input, styles.checkInput, {
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
          {nextCheckNumber ? (
            <TouchableOpacity
              style={[styles.autoBtn, { borderColor: colors.border }]}
              onPress={() => setCheckNumber(nextCheckNumber)}
            >
              <Text style={[styles.autoBtnText, { color: colors.tint }]}>
                Next: {nextCheckNumber}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

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

        <Text style={[styles.label, { color: colors.textSecondary }]}>Receipt</Text>
        <View style={styles.receiptRow}>
          <TouchableOpacity
            style={[styles.receiptBtn, { borderColor: colors.border }]}
            onPress={takePhoto}
          >
            <FontAwesome name="camera" size={18} color={colors.tint} />
            <Text style={[styles.receiptBtnText, { color: colors.tint }]}>Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.receiptBtn, { borderColor: colors.border }]}
            onPress={pickPhoto}
          >
            <FontAwesome name="image" size={18} color={colors.tint} />
            <Text style={[styles.receiptBtnText, { color: colors.tint }]}>Gallery</Text>
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
          disabled={createTxn.isPending}
        >
          {createTxn.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save Transaction</Text>
          )}
        </TouchableOpacity>
        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  form: { padding: 20 },
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
  checkRow: { flexDirection: 'row', gap: 10 },
  checkInput: { flex: 1 },
  autoBtn: {
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
  },
  autoBtnText: { fontSize: 14, fontWeight: '500' },
  suggestions: {
    borderWidth: 1,
    borderRadius: 10,
    marginTop: -4,
    marginBottom: 8,
    overflow: 'hidden',
  },
  suggestionItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  suggestionText: { fontSize: 15 },
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
});

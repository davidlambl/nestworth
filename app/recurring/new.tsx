import React, { useState, useLayoutEffect } from 'react';
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
import { router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { todayString } from '@/lib/format';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useCreateRecurringRule } from '@/lib/hooks/useRecurringRules';
import type { RecurringFrequency } from '@/lib/types';

const FREQUENCIES: { value: RecurringFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'semimonthly', label: '2x/mo' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'biannually', label: '6 months' },
  { value: 'yearly', label: 'Yearly' },
];

export default function NewRecurringScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

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

  const { data: accounts } = useAccounts();
  const createRule = useCreateRecurringRule();

  const [accountId, setAccountId] = useState('');
  const [payee, setPayee] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly');
  const [nextDate, setNextDate] = useState(todayString());
  const [memo, setMemo] = useState('');

  const handleSave = () => {
    if (!accountId) {
      Alert.alert('Account required', 'Please select an account.');
      return;
    }
    if (!payee.trim()) {
      Alert.alert('Payee required', 'Please enter a payee.');
      return;
    }
    const amt = parseFloat(amountStr);
    if (isNaN(amt) || amt === 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount.');
      return;
    }

    const finalAmount = isExpense ? -Math.abs(amt) : Math.abs(amt);

    createRule.mutate(
      {
        accountId,
        frequency,
        nextDate,
        template: {
          payee: payee.trim(),
          amount: finalAmount,
          checkNumber: null,
          memo: memo || null,
          splits: [],
        },
      },
      {
        onSuccess: () => router.back(),
      }
    );
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.form}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {(accounts ?? [])
            .filter((a) => !a.isArchived)
            .map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[
                  styles.chip,
                  {
                    backgroundColor: accountId === a.id ? colors.tint : colors.surface,
                    borderColor: accountId === a.id ? colors.tint : colors.border,
                  },
                ]}
                onPress={() => setAccountId(a.id)}
              >
                <Text style={{
                  color: accountId === a.id ? '#fff' : colors.text,
                  fontSize: 13,
                  fontWeight: '500',
                }}>
                  {a.name}
                </Text>
              </TouchableOpacity>
            ))}
        </ScrollView>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Payee</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={payee}
          onChangeText={setPayee}
          placeholder="Payee name"
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

        <Text style={[styles.label, { color: colors.textSecondary }]}>Frequency</Text>
        <View style={styles.freqRow}>
          {FREQUENCIES.map((f) => (
            <TouchableOpacity
              key={f.value}
              style={[
                styles.chip,
                {
                  backgroundColor: frequency === f.value ? colors.tint : colors.surface,
                  borderColor: frequency === f.value ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setFrequency(f.value)}
            >
              <Text style={{
                color: frequency === f.value ? '#fff' : colors.text,
                fontSize: 12,
                fontWeight: '500',
              }}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>First Date</Text>
        <TextInput
          style={[styles.input, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={nextDate}
          onChangeText={setNextDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.placeholder}
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
          disabled={createRule.isPending}
        >
          {createRule.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Create Rule</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
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
  freqRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
  },
  saveBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});

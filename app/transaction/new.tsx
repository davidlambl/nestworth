import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { todayString } from '@/lib/format';
import { useCreateTransaction, useTransactions } from '@/lib/hooks/useTransactions';
import { useCategories } from '@/lib/hooks/useCategories';
import { useReceiptPhoto } from '@/lib/hooks/useReceiptPhoto';
import { SplitEditor, SplitRow } from '@/components/SplitEditor';
import type { TransactionStatus } from '@/lib/types';

export default function NewTransactionScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const createTxn = useCreateTransaction();
  const { data: existingTxns } = useTransactions(accountId);
  const { data: categories } = useCategories();
  const { pickPhoto, takePhoto, uploadPhoto, uploading, photoUri, clearPhoto } =
    useReceiptPhoto();

  const [date, setDate] = useState(todayString());
  const [payee, setPayee] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState<TransactionStatus>('pending');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [useSplits, setUseSplits] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [showPayeeSuggestions, setShowPayeeSuggestions] = useState(false);

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
    const amt = parseFloat(amountStr);
    if (isNaN(amt) || amt === 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount.');
      return;
    }
    if (!payee.trim()) {
      Alert.alert('Payee required', 'Please enter a payee name.');
      return;
    }

    const finalAmount = isExpense ? -Math.abs(amt) : Math.abs(amt);

    let txnSplits: { categoryId: string | null; amount: number; memo: string | null }[];
    if (useSplits && splits.length > 0) {
      txnSplits = splits.map((s) => ({
        categoryId: s.categoryId,
        amount: isExpense
          ? -Math.abs(parseFloat(s.amount) || 0)
          : Math.abs(parseFloat(s.amount) || 0),
        memo: s.memo || null,
      }));
    } else if (categoryId) {
      txnSplits = [{ categoryId, amount: finalAmount, memo: null }];
    } else {
      txnSplits = [];
    }

    createTxn.mutate(
      {
        accountId,
        txnDate: date,
        payee: payee.trim(),
        amount: finalAmount,
        checkNumber: checkNumber || null,
        memo: memo || null,
        status,
        splits: txnSplits,
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
                  const lastTxn = existingTxns?.find(
                    (t) => t.payee === p
                  );
                  if (lastTxn?.splits[0]?.categoryId) {
                    setCategoryId(lastTxn.splits[0].categoryId);
                  }
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
            value={amountStr}
            onChangeText={setAmountStr}
            placeholder="0.00"
            placeholderTextColor={colors.placeholder}
            keyboardType="decimal-pad"
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

        <View style={styles.splitToggleRow}>
          <Text style={[styles.label, { color: colors.textSecondary, marginTop: 0 }]}>
            Category
          </Text>
          <View style={styles.splitToggle}>
            <Text style={[styles.splitToggleLabel, { color: colors.textSecondary }]}>
              Split
            </Text>
            <Switch
              value={useSplits}
              onValueChange={setUseSplits}
              trackColor={{ true: colors.tint }}
            />
          </View>
        </View>

        {useSplits ? (
          <SplitEditor
            splits={splits}
            onChange={setSplits}
            categories={categories ?? []}
            totalAmount={parseFloat(amountStr) || 0}
            isExpense={isExpense}
          />
        ) : (
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
        )}

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
          disabled={createTxn.isPending}
        >
          {createTxn.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save Transaction</Text>
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
  splitToggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 6,
  },
  splitToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  splitToggleLabel: { fontSize: 13 },
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

import React, { useState, useMemo, useLayoutEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColorScheme } from '@/components/useColorScheme';
import WebDateInput from '@/components/WebDateInput';
import FormError from '@/components/FormError';
import Colors from '@/constants/Colors';
import { formatDateStr, parseDateStr, todayString } from '@/lib/format';
import {
  useCreateTransaction,
  useTransactions,
} from '@/lib/hooks/useTransactions';
import { useReceiptPhoto } from '@/lib/hooks/useReceiptPhoto';
import { ReceiptPreview } from '@/components/ReceiptPreview';
import { useTheme } from '@/lib/theme';
import {
  centsToDisplay,
  sanitizeCentsInput,
  nextCheckNumber as computeNextCheckNumber,
  uniquePayees,
  filterPayeeSuggestions,
} from '@/lib/register';

export default function NewTransactionScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

  const createTxn = useCreateTransaction();
  const { data: existingTxns } = useTransactions(accountId);
  const { pickPhoto, takePhoto, uploadPhoto, photo, clearPhoto } =
    useReceiptPhoto();
  const { fontScale } = useTheme();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ paddingLeft: 16, paddingRight: 12, paddingVertical: 8 }}
        >
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
  // Shown above Save on every platform: Alert.alert is a no-op on web and in
  // Electron (#164). A refused save lands here too (#163): an account deleted
  // while this form was open is refused, and the mutation cache's "Save
  // failed" line is on no screen this form sits over.
  const [formError, setFormError] = useState<string | null>(null);

  const displayAmount = useMemo(
    () => centsToDisplay(amountCents),
    [amountCents]
  );

  const handleAmountChange = (text: string) => {
    setAmountCents(sanitizeCentsInput(text));
  };

  const nextCheckNumber = useMemo(
    () => computeNextCheckNumber(existingTxns),
    [existingTxns]
  );

  const pastPayees = useMemo(() => uniquePayees(existingTxns), [existingTxns]);

  const payeeSuggestions = useMemo(
    () => filterPayeeSuggestions(pastPayees, payee),
    [payee, pastPayees]
  );

  const handleSave = () => {
    const amt = parseInt(amountCents || '0', 10) / 100;
    if (amt === 0) {
      setFormError('Please enter a valid amount.');
      return;
    }
    if (!payee.trim()) {
      setFormError('Please enter a payee name.');
      return;
    }
    setFormError(null);

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
          if (photo && txn) {
            await uploadPhoto(photo, txn.id);
          }
          router.back();
        },
        onError: (e) =>
          setFormError(e instanceof Error ? e.message : String(e)),
      }
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={{ backgroundColor: colors.background }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // iOS (#39): insets the content by what the keyboard covers and
        // scrolls the focused field above it. Save is reached by a drag, which
        // also puts the keyboard away (on-drag, above). The
        // KeyboardAvoidingView this form had fell short in this page-sheet
        // modal: see "The iOS keyboard" in CONTRIBUTING.md. Web and Android
        // ignore it.
        automaticallyAdjustKeyboardInsets
      >
        <View style={styles.form}>
          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Date
          </Text>
          {Platform.OS === 'web' ? (
            <WebDateInput
              value={date}
              onChange={setDate}
              colorScheme={colorScheme}
              style={{
                backgroundColor: colors.surface,
                color: colors.text,
                borderColor: colors.border,
                fontSize: 16 * fontScale,
              }}
            />
          ) : (
            <>
              {Platform.OS === 'android' && (
                <TouchableOpacity
                  style={[
                    styles.dateBtn,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                    },
                  ]}
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

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Payee
          </Text>
          <TextInput
            testID="new-txn-payee"
            style={[
              styles.input,
              {
                backgroundColor: colors.surface,
                color: colors.text,
                borderColor: colors.border,
                fontSize: 16 * fontScale,
              },
            ]}
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
            <View
              style={[
                styles.suggestions,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                },
              ]}
            >
              {payeeSuggestions.map((p, i) => (
                <TouchableOpacity
                  key={p}
                  testID={`payee-suggestion-${i}`}
                  style={[
                    styles.suggestionItem,
                    { borderBottomColor: colors.separator },
                  ]}
                  onPress={() => {
                    setPayee(p);
                    setShowPayeeSuggestions(false);
                  }}
                >
                  <Text style={[styles.suggestionText, { color: colors.text }]}>
                    {p}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Amount
          </Text>
          <View style={styles.amountRow}>
            <TouchableOpacity
              style={[
                styles.typeToggle,
                {
                  backgroundColor: isExpense
                    ? colors.expenseLight
                    : colors.incomeLight,
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
              <Text
                style={{
                  color: isExpense ? colors.expense : colors.income,
                  fontWeight: '600',
                }}
              >
                {isExpense ? 'Expense' : 'Income'}
              </Text>
            </TouchableOpacity>
            <TextInput
              testID="new-txn-amount"
              style={[
                styles.amountInput,
                {
                  backgroundColor: colors.surface,
                  color: colors.text,
                  borderColor: colors.border,
                  fontSize: 20 * fontScale,
                },
              ]}
              value={displayAmount}
              onChangeText={handleAmountChange}
              placeholder="0.00"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              selection={{
                start: displayAmount.length,
                end: displayAmount.length,
              }}
            />
          </View>

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Check #
          </Text>
          <View style={styles.checkRow}>
            <TextInput
              testID="new-txn-check"
              style={[
                styles.input,
                styles.checkInput,
                {
                  backgroundColor: colors.surface,
                  color: colors.text,
                  borderColor: colors.border,
                  fontSize: 16 * fontScale,
                },
              ]}
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

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Memo
          </Text>
          <TextInput
            testID="new-txn-memo"
            style={[
              styles.input,
              {
                backgroundColor: colors.surface,
                color: colors.text,
                borderColor: colors.border,
                fontSize: 16 * fontScale,
              },
            ]}
            value={memo}
            onChangeText={setMemo}
            placeholder="Optional note"
            placeholderTextColor={colors.placeholder}
          />

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Receipt
          </Text>
          <ReceiptPreview
            localUri={photo?.uri ?? null}
            storedPath={null}
            testIDPrefix="new-txn"
            colors={colors}
            fontScale={fontScale}
          />
          <View style={styles.receiptRow}>
            <TouchableOpacity
              style={[styles.receiptBtn, { borderColor: colors.border }]}
              onPress={takePhoto}
            >
              <FontAwesome name="camera" size={18} color={colors.tint} />
              <Text
                style={[
                  styles.receiptBtnText,
                  { color: colors.tint, fontSize: 13 * fontScale },
                ]}
              >
                Camera
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.receiptBtn, { borderColor: colors.border }]}
              onPress={pickPhoto}
            >
              <FontAwesome name="image" size={18} color={colors.tint} />
              <Text
                style={[
                  styles.receiptBtnText,
                  { color: colors.tint, fontSize: 13 * fontScale },
                ]}
              >
                Gallery
              </Text>
            </TouchableOpacity>
            {photo && (
              <View style={styles.receiptAttached}>
                <FontAwesome
                  name="check-circle"
                  size={16}
                  color={colors.income}
                />
                <Text
                  style={[styles.receiptAttachedText, { color: colors.income }]}
                >
                  Attached
                </Text>
                <TouchableOpacity
                  onPress={clearPhoto}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Discard picked photo"
                >
                  <FontAwesome
                    name="times"
                    size={14}
                    color={colors.placeholder}
                  />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Directly above Save: the form scrolls, and Save is where the
              person is looking when the line appears. */}
          <FormError
            message={formError}
            testID="new-txn-error"
            style={styles.formError}
          />

          <TouchableOpacity
            testID="new-txn-save"
            style={[styles.saveBtn, { backgroundColor: colors.tint }]}
            onPress={handleSave}
            disabled={createTxn.isPending}
          >
            {createTxn.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.saveBtnText, { fontSize: 17 * fontScale }]}>
                Save Transaction
              </Text>
            )}
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  form: {
    padding: 20,
    maxWidth: 600,
    alignSelf: 'center' as const,
    width: '100%',
  },
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
  formError: { marginTop: 24 },
  saveBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});

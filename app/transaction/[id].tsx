import React, {
  useState,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
} from 'react';
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
import {
  DATE_MISSING_MESSAGE,
  formatDateStr,
  isDateStr,
  parseDateStr,
} from '@/lib/format';
import {
  useTransaction,
  useTransactionGone,
  useUpdateTransaction,
  useDeleteTransaction,
} from '@/lib/hooks/useTransactions';
import { TRANSACTION_GONE_MESSAGE } from '@/lib/transactionUpdate';
import { useAccount } from '@/lib/hooks/useAccounts';
import { useReceiptPhoto } from '@/lib/hooks/useReceiptPhoto';
import { useRemoveReceipt } from '@/lib/hooks/useRemoveReceipt';
import { ReceiptPreview } from '@/components/ReceiptPreview';
import { useTheme } from '@/lib/theme';
import { confirm } from '@/lib/confirm';
import {
  AMOUNT_TOO_LARGE_MESSAGE,
  centsInputToAmount,
  centsToDisplay,
  sanitizeCentsInput,
} from '@/lib/register';

export default function EditTransactionScreen() {
  const { id, accountId } = useLocalSearchParams<{
    id: string;
    accountId: string;
  }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

  const txnQuery = useTransaction(id);
  const txn = txnQuery.data;
  const txnGone = useTransactionGone(id, txnQuery);
  const acctIdForQuery = accountId || txn?.accountId || '';
  const { data: accountData } = useAccount(acctIdForQuery);
  const updateTxn = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();
  const { pickPhoto, takePhoto, uploadPhoto, uploading, photo, clearPhoto } =
    useReceiptPhoto();
  const removeReceipt = useRemoveReceipt();
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

  const [date, setDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  const [payee, setPayee] = useState('');
  const [amountCents, setAmountCents] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [checkNumber, setCheckNumber] = useState('');
  const [memo, setMemo] = useState('');
  // Shown above Save on every platform: Alert.alert is a no-op on web and in
  // Electron (#164).
  const [formError, setFormError] = useState<string | null>(null);

  const displayAmount = useMemo(
    () => centsToDisplay(amountCents),
    [amountCents]
  );

  const handleAmountChange = (text: string) => {
    setAmountCents(sanitizeCentsInput(text));
  };

  // Seed the form once per loaded transaction, never on a refetch of the same
  // one. `['transaction', id]` is invalidated by ordinary sync activity while
  // this screen is open -- the realtime echo of our own push
  // (lib/hooks/useRealtimeSync.ts:71) and the blanket
  // `queryClient.invalidateQueries()` every sync ends with (lib/query.tsx:102)
  // -- and the refetched object is never reference-equal after a push, because
  // the push adopts the server's `updated_at` (lib/sync.ts:864) and
  // `mapTransaction` carries it. Keyed on `[txn]` alone, this effect re-ran
  // mid-edit and put the server's values back over whatever had been typed;
  // a Save taken in that moment wrote the pre-edit row (#85). The user's
  // typing wins until the screen is opened again.
  const seededTxnId = useRef<string | null>(null);

  useEffect(() => {
    if (!txn || seededTxnId.current === txn.id) {
      return;
    }
    seededTxnId.current = txn.id;
    setDate(txn.txnDate);
    setPayee(txn.payee);
    setAmountCents(String(Math.round(Math.abs(txn.amount) * 100)));
    setIsExpense(txn.amount < 0);
    setCheckNumber(txn.checkNumber ?? '');
    setMemo(txn.memo ?? '');
  }, [txn]);

  const acctId = acctIdForQuery;

  const handleSave = () => {
    // The field caps what is typed, but it is seeded from the stored row, and
    // one saved before the cap can hold more than the server stores (it is
    // still pending here): refuse it rather than queue it again (#165).
    const amt = centsInputToAmount(amountCents);
    if (amt === null) {
      setFormError(AMOUNT_TOO_LARGE_MESSAGE);
      return;
    }
    if (amt === 0) {
      setFormError('Please enter a valid amount.');
      return;
    }
    // The web and desktop date field reads '' once emptied, or while a date
    // is only partly typed, and a row an older build saved can hold '' or a
    // date the server refuses (#192).
    if (!isDateStr(date)) {
      setFormError(DATE_MISSING_MESSAGE);
      return;
    }
    setFormError(null);

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
          if (photo) {
            await uploadPhoto(photo, id);
          }
          router.back();
        },
      }
    );
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete Transaction',
      message: 'Delete this transaction?',
      confirmText: 'Delete',
      destructive: true,
    });
    if (ok) {
      deleteTxn.mutate(
        { id, accountId: acctId },
        { onSuccess: () => router.back() }
      );
    }
  };

  // The receipt this transaction names (#23). Removing it deletes its photo
  // from Storage, so it is confirmed first, the way a delete is (`confirm`:
  // window.confirm on web and in Electron, where Alert.alert does nothing). A
  // photo Storage has already said is missing is not deleted again, and the
  // words say so.
  const storedReceipt = txn?.receiptPath ?? null;
  const handleRemoveReceipt = async (photoMissing: boolean) => {
    if (!storedReceipt) {
      return;
    }
    const ok = await confirm({
      title: 'Remove Receipt',
      message: photoMissing
        ? 'Remove this receipt? Its photo is already gone.'
        : 'Remove this receipt? Its photo is deleted from the cloud.',
      confirmText: 'Remove',
      destructive: true,
    });
    if (ok) {
      removeReceipt.mutate({ transactionId: id, path: storedReceipt });
    }
  };

  // The form only over a row this screen has loaded (#177): its Save and
  // Delete write by id, into whatever row has it, and it used to open empty
  // over a row it could not read. A transaction that is not the signed-in
  // user's here -- deleted elsewhere or by a reset (#127), or another
  // account's, reached by its id from the browser's history or a stale link
  // -- is said to be gone, in #127's words, which say nothing of another
  // account. Any other failed read keeps the spinner, as loading does, until
  // a refetch reads the row. A row that goes while the form is open keeps
  // the form (TanStack keeps the last data), and its Save is refused in the
  // same words.
  //
  // The line goes through FormError, as a status line that appears on its
  // own does (#38, #195): its polite live region is mounted with the spinner,
  // before the line takes the spinner's place, so web and Android read the
  // line out, and on iOS VoiceOver is moved to it, the screen's whole content.
  // A refetch leaves the line in place (useTransactionGone): every sync
  // refetches the read, and a line that went away for the refetch and came
  // back was read out again, and VoiceOver was moved to it again.
  if (!txn) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <FormError
          message={txnGone ? TRANSACTION_GONE_MESSAGE : null}
          testID="edit-txn-gone"
          boxStyle={styles.goneBox}
          style={[
            styles.goneText,
            { color: colors.textSecondary, fontSize: 15 * fontScale },
          ]}
        />
        {txnGone ? null : (
          <ActivityIndicator size="large" color={colors.tint} />
        )}
      </View>
    );
  }

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
          {accountData && (
            <View
              style={[styles.accountBadge, { backgroundColor: colors.surface }]}
            >
              <FontAwesome name="bank" size={12} color={colors.tint} />
              <Text
                style={[
                  styles.accountBadgeText,
                  {
                    color: colors.text,
                    fontSize: 13 * fontScale,
                  },
                ]}
              >
                {accountData.name}
              </Text>
            </View>
          )}

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
          ) : date ? (
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
          ) : null}

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Payee
          </Text>
          <TextInput
            testID="edit-txn-payee"
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
            onChangeText={setPayee}
            placeholder="Payee"
            placeholderTextColor={colors.placeholder}
          />

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
          <TextInput
            style={[
              styles.input,
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

          <Text
            style={[
              styles.label,
              { color: colors.textSecondary, fontSize: 13 * fontScale },
            ]}
          >
            Memo
          </Text>
          <TextInput
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
            storedPath={storedReceipt}
            testIDPrefix="edit-txn"
            colors={colors}
            fontScale={fontScale}
            onRemove={handleRemoveReceipt}
            removing={removeReceipt.isPending}
            removeError={photo ? null : (removeReceipt.error?.message ?? null)}
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
            testID="edit-txn-error"
            style={styles.formError}
          />

          <TouchableOpacity
            testID="edit-txn-save"
            style={[styles.saveBtn, { backgroundColor: colors.tint }]}
            onPress={handleSave}
            disabled={updateTxn.isPending || uploading}
          >
            {updateTxn.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.saveBtnText, { fontSize: 17 * fontScale }]}>
                Save Changes
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            testID="edit-txn-delete"
            style={[styles.deleteBtn, { borderColor: colors.destructive }]}
            onPress={handleDelete}
          >
            <Text
              style={[
                styles.deleteBtnText,
                { color: colors.destructive, fontSize: 16 * fontScale },
              ]}
            >
              Delete Transaction
            </Text>
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // FormError's region spans the screen: the line is centred inside it.
  goneBox: { alignItems: 'center' },
  goneText: { textAlign: 'center', paddingHorizontal: 24, maxWidth: 480 },
  form: {
    padding: 20,
    maxWidth: 600,
    alignSelf: 'center' as const,
    width: '100%',
  },
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
  formError: { marginTop: 24 },
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

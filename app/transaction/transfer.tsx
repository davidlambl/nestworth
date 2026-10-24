import React, { useState, useMemo, useLayoutEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ScrollView,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { router, useNavigation, useLocalSearchParams } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColorScheme } from '@/components/useColorScheme';
import WebDateInput from '@/components/WebDateInput';
import FormError from '@/components/FormError';
import Colors from '@/constants/Colors';
import {
  todayString,
  formatCurrency,
  balanceColor,
  formatDateStr,
  parseDateStr,
  isDateStr,
  DATE_MISSING_MESSAGE,
} from '@/lib/format';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useCreateTransfer } from '@/lib/hooks/useTransactions';
import { useTheme } from '@/lib/theme';
import type { AccountType, AccountWithBalance } from '@/lib/types';
import { centsToDisplay, sanitizeCentsInput } from '@/lib/register';

const DEFAULT_ICONS: Record<AccountType, string> = {
  checking: '🏦',
  savings: '🐷',
  credit_card: '💳',
  cash: '💵',
  other: '📁',
};

export default function TransferScreen() {
  const { fromAccountId } = useLocalSearchParams<{ fromAccountId?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();
  const { data: accounts } = useAccounts();
  const createTransfer = useCreateTransfer();
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

  const [fromId, setFromId] = useState(fromAccountId ?? '');
  const [toId, setToId] = useState('');
  const [amountCents, setAmountCents] = useState('');
  const [date, setDate] = useState(todayString());
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<'from' | 'to' | null>(null);
  // Shown above Transfer on every platform: Alert.alert is a no-op on web and
  // in Electron (#164).
  const [formError, setFormError] = useState<string | null>(null);

  const displayAmount = useMemo(
    () => centsToDisplay(amountCents),
    [amountCents]
  );

  const handleAmountChange = (text: string) => {
    setAmountCents(sanitizeCentsInput(text));
  };

  const activeAccounts = (accounts ?? []).filter(
    (a: AccountWithBalance) => !a.isArchived
  );
  const fromAccount = activeAccounts.find((a) => a.id === fromId);
  const toAccount = activeAccounts.find((a) => a.id === toId);
  const hasFixedFrom = !!fromAccountId;

  const handleTransfer = async () => {
    if (!fromId || !toId) {
      setFormError('Please select both a source and destination account.');
      return;
    }
    if (fromId === toId) {
      setFormError('Source and destination must be different.');
      return;
    }
    const amt = parseInt(amountCents || '0', 10) / 100;
    if (amt <= 0) {
      setFormError('Please enter a positive amount.');
      return;
    }
    // The web and desktop date field reads '' once emptied, or while a date
    // is only partly typed (#192).
    if (!isDateStr(date)) {
      setFormError(DATE_MISSING_MESSAGE);
      return;
    }
    setFormError(null);

    setLoading(true);
    try {
      await createTransfer.mutateAsync({
        fromAccountId: fromId,
        toAccountId: toId,
        fromAccountName: fromAccount?.name ?? '',
        toAccountName: toAccount?.name ?? '',
        amount: amt,
        txnDate: date,
        memo,
      });
      router.back();
    } catch (e) {
      // The mutation cache puts this on the sync indicator as well ("Save
      // failed: ..."); the form says it where the person is looking.
      setFormError(
        `Transfer failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setLoading(false);
    }
  };

  const renderAccountOption = (
    account: AccountWithBalance,
    selectedId: string,
    onSelect: (id: string) => void
  ) => (
    <TouchableOpacity
      key={account.id}
      testID={`picker-${account.name.replace(/\s+/g, '-').toLowerCase()}`}
      style={[
        styles.pickerRow,
        account.id === selectedId && { backgroundColor: colors.tintLight },
      ]}
      onPress={() => onSelect(account.id)}
    >
      <Text style={styles.pickerIcon}>
        {account.icon ?? DEFAULT_ICONS[account.type]}
      </Text>
      <View style={styles.pickerInfo}>
        <Text
          style={[styles.pickerName, { color: colors.text }]}
          numberOfLines={1}
        >
          {account.name}
        </Text>
        <Text
          style={[
            styles.pickerBalance,
            {
              color: balanceColor(account.currentBalance, colors),
            },
          ]}
        >
          {formatCurrency(account.currentBalance)}
        </Text>
      </View>
      {account.id === selectedId && (
        <FontAwesome name="check" size={14} color={colors.tint} />
      )}
    </TouchableOpacity>
  );

  const pickerAccounts =
    pickerTarget === 'to'
      ? activeAccounts.filter((a) => a.id !== fromId)
      : activeAccounts;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
      // iOS (#39): insets the content by what the keyboard covers and scrolls
      // the focused field above it, so Transfer can be reached with the
      // keyboard up. A KeyboardAvoidingView falls short in this page-sheet
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
          From Account
        </Text>
        {hasFixedFrom ? (
          <View
            style={[
              styles.selector,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            {fromAccount && (
              <>
                <Text style={styles.selectorIcon}>
                  {fromAccount.icon ?? DEFAULT_ICONS[fromAccount.type]}
                </Text>
                <Text
                  style={[
                    styles.selectorText,
                    { color: colors.text, fontSize: 15 * fontScale },
                  ]}
                  numberOfLines={1}
                >
                  {fromAccount.name}
                </Text>
              </>
            )}
          </View>
        ) : (
          <TouchableOpacity
            testID="transfer-from-picker"
            style={[
              styles.selector,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
            onPress={() => setPickerTarget('from')}
          >
            {fromAccount ? (
              <>
                <Text style={styles.selectorIcon}>
                  {fromAccount.icon ?? DEFAULT_ICONS[fromAccount.type]}
                </Text>
                <Text
                  style={[
                    styles.selectorText,
                    { color: colors.text, fontSize: 15 * fontScale },
                  ]}
                  numberOfLines={1}
                >
                  {fromAccount.name}
                </Text>
              </>
            ) : (
              <Text
                style={[
                  styles.selectorText,
                  { color: colors.placeholder, fontSize: 15 * fontScale },
                ]}
              >
                Select account...
              </Text>
            )}
            <FontAwesome
              name="chevron-down"
              size={12}
              color={colors.placeholder}
            />
          </TouchableOpacity>
        )}
        {fromAccount && (
          <Text
            testID="transfer-from-balance"
            style={[
              styles.balanceLine,
              {
                color: balanceColor(fromAccount.currentBalance, colors),
                fontSize: 13 * fontScale,
              },
            ]}
          >
            Balance: {formatCurrency(fromAccount.currentBalance)}
          </Text>
        )}

        <View style={styles.arrowRow}>
          <FontAwesome name="arrow-down" size={24} color={colors.placeholder} />
        </View>

        <Text
          style={[
            styles.label,
            { color: colors.textSecondary, fontSize: 13 * fontScale },
          ]}
        >
          To Account
        </Text>
        <TouchableOpacity
          testID="transfer-to-picker"
          style={[
            styles.selector,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
          onPress={() => setPickerTarget('to')}
        >
          {toAccount ? (
            <>
              <Text style={styles.selectorIcon}>
                {toAccount.icon ?? DEFAULT_ICONS[toAccount.type]}
              </Text>
              <Text
                style={[
                  styles.selectorText,
                  { color: colors.text, fontSize: 15 * fontScale },
                ]}
                numberOfLines={1}
              >
                {toAccount.name}
              </Text>
            </>
          ) : (
            <Text
              style={[
                styles.selectorText,
                { color: colors.placeholder, fontSize: 15 * fontScale },
              ]}
            >
              Select account...
            </Text>
          )}
          <FontAwesome
            name="chevron-down"
            size={12}
            color={colors.placeholder}
          />
        </TouchableOpacity>

        <Text
          style={[
            styles.label,
            { color: colors.textSecondary, fontSize: 13 * fontScale },
          ]}
        >
          Amount
        </Text>
        <TextInput
          testID="transfer-amount"
          style={[
            styles.amountInput,
            {
              backgroundColor: colors.surface,
              color: colors.text,
              borderColor: colors.border,
              fontSize: 24 * fontScale,
            },
          ]}
          value={displayAmount}
          onChangeText={handleAmountChange}
          placeholder="0.00"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
          selection={{ start: displayAmount.length, end: displayAmount.length }}
        />

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
                <Text
                  style={[
                    styles.dateBtnText,
                    { color: colors.text, fontSize: 16 * fontScale },
                  ]}
                >
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

        {/* Directly above Transfer: the form scrolls, and Transfer is where
            the person is looking when the line appears. */}
        <FormError
          message={formError}
          testID="transfer-error"
          style={styles.formError}
        />

        <TouchableOpacity
          testID="transfer-save"
          style={[styles.saveBtn, { backgroundColor: colors.tint }]}
          onPress={handleTransfer}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={[styles.saveBtnText, { fontSize: 17 * fontScale }]}>
              Transfer
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <Modal visible={pickerTarget !== null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View
            style={[styles.modalContent, { backgroundColor: colors.surface }]}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                {pickerTarget === 'from' ? 'From Account' : 'To Account'}
              </Text>
              <TouchableOpacity
                onPress={() => setPickerTarget(null)}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <FontAwesome
                  name="times"
                  size={20}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
            <FlatList
              data={pickerAccounts}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) =>
                renderAccountOption(
                  item,
                  pickerTarget === 'from' ? fromId : toId,
                  (id) => {
                    if (pickerTarget === 'from') {
                      setFromId(id);
                    } else {
                      setToId(id);
                    }
                    setPickerTarget(null);
                  }
                )
              }
            />
          </View>
        </View>
      </Modal>
    </ScrollView>
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
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  selectorIcon: { fontSize: 24 },
  selectorText: { flex: 1, fontSize: 16, fontWeight: '500' },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  amountInput: {
    height: 56,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  arrowRow: { alignItems: 'center', paddingVertical: 8 },
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
  formError: { marginTop: 24 },
  saveBtn: {
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  saveBtnText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 40,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    paddingBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    gap: 12,
  },
  pickerIcon: { fontSize: 22 },
  pickerInfo: { flex: 1 },
  pickerName: { fontSize: 15, fontWeight: '500' },
  pickerBalance: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  balanceLine: { fontSize: 13, fontWeight: '600', marginTop: 6 },
});

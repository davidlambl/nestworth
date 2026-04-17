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
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { router, useNavigation, useLocalSearchParams } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColorScheme } from '@/components/useColorScheme';
import WebDateInput from '@/components/WebDateInput';
import Colors from '@/constants/Colors';
import { todayString, formatCurrency, balanceColor } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { getDb } from '@/lib/db';
import { requestPush } from '@/lib/sync';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
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

export default function TransferScreen() {
  const { fromAccountId } = useLocalSearchParams<{ fromAccountId?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();
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

  const displayAmount = useMemo(
    () => centsToDisplay(amountCents),
    [amountCents],
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
      Alert.alert('Select accounts', 'Please select both a source and destination account.');
      return;
    }
    if (fromId === toId) {
      Alert.alert('Same account', 'Source and destination must be different.');
      return;
    }
    const amt = parseInt(amountCents || '0', 10) / 100;
    if (amt <= 0) {
      Alert.alert('Invalid amount', 'Please enter a positive amount.');
      return;
    }

    setLoading(true);
    try {
      const db = await getDb();
      const linkId = Crypto.randomUUID();
      const transferMemo = memo || 'Transfer';
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT INTO transactions
           (id, user_id, account_id, txn_date, payee, amount, memo,
            status, transfer_link_id, created_at, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, 'pending')`,
        [
          Crypto.randomUUID(), user!.id, fromId, date,
          `Transfer to ${toAccount?.name ?? ''}`, -Math.abs(amt),
          transferMemo, linkId, now, now,
        ]
      );

      await db.runAsync(
        `INSERT INTO transactions
           (id, user_id, account_id, txn_date, payee, amount, memo,
            status, transfer_link_id, created_at, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, 'pending')`,
        [
          Crypto.randomUUID(), user!.id, toId, date,
          `Transfer from ${fromAccount?.name ?? ''}`, Math.abs(amt),
          transferMemo, linkId, now, now,
        ]
      );

      requestPush(user!.id);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      router.back();
    } catch (e: any) {
      Alert.alert('Transfer failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const renderAccountOption = (
    account: AccountWithBalance,
    selectedId: string,
    onSelect: (id: string) => void,
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
                {pickerTarget === 'from'
                  ? 'From Account'
                  : 'To Account'}
              </Text>
              <TouchableOpacity onPress={() => setPickerTarget(null)}>
                <FontAwesome name="times" size={20} color={colors.textSecondary} />
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
});

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
  Platform,
} from 'react-native';
import { router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { todayString } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';

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
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={{ color: colors.tint, fontSize: 16 }}>Cancel</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [date, setDate] = useState(todayString());
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);

  const activeAccounts = (accounts ?? []).filter((a) => !a.isArchived);

  const handleTransfer = async () => {
    if (!fromId || !toId) {
      Alert.alert('Select accounts', 'Please select both a source and destination account.');
      return;
    }
    if (fromId === toId) {
      Alert.alert('Same account', 'Source and destination must be different.');
      return;
    }
    const amt = parseFloat(amountStr);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Invalid amount', 'Please enter a positive amount.');
      return;
    }

    setLoading(true);
    try {
      const linkId = Crypto.randomUUID();
      const transferMemo = memo || 'Transfer';

      const { error: err1 } = await supabase.from('transactions').insert({
        user_id: user!.id,
        account_id: fromId,
        txn_date: date,
        payee: `Transfer to ${activeAccounts.find((a) => a.id === toId)?.name ?? ''}`,
        amount: -Math.abs(amt),
        memo: transferMemo,
        status: 'cleared',
        transfer_link_id: linkId,
      });
      if (err1) {
        throw err1;
      }

      const { error: err2 } = await supabase.from('transactions').insert({
        user_id: user!.id,
        account_id: toId,
        txn_date: date,
        payee: `Transfer from ${activeAccounts.find((a) => a.id === fromId)?.name ?? ''}`,
        amount: Math.abs(amt),
        memo: transferMemo,
        status: 'cleared',
        transfer_link_id: linkId,
      });
      if (err2) {
        throw err2;
      }

      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      router.back();
    } catch (e: any) {
      Alert.alert('Transfer failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.form}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>From Account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {activeAccounts.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={[
                styles.chip,
                {
                  backgroundColor: fromId === a.id ? colors.expense : colors.surface,
                  borderColor: fromId === a.id ? colors.expense : colors.border,
                },
              ]}
              onPress={() => setFromId(a.id)}
            >
              <Text style={{
                color: fromId === a.id ? '#fff' : colors.text,
                fontSize: 13,
                fontWeight: '500',
              }}>
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.arrowRow}>
          <FontAwesome name="arrow-down" size={24} color={colors.placeholder} />
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>To Account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {activeAccounts.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={[
                styles.chip,
                {
                  backgroundColor: toId === a.id ? colors.income : colors.surface,
                  borderColor: toId === a.id ? colors.income : colors.border,
                },
              ]}
              onPress={() => setToId(a.id)}
            >
              <Text style={{
                color: toId === a.id ? '#fff' : colors.text,
                fontSize: 13,
                fontWeight: '500',
              }}>
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Amount</Text>
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
          onPress={handleTransfer}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Transfer</Text>
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
  amountInput: {
    height: 56,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  arrowRow: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
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
  saveBtn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  saveBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});

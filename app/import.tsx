import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort } from '@/lib/format';
import { parseCSV, ParsedTransaction } from '@/lib/csvImport';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';

type Step = 'input' | 'preview' | 'done';

export default function ImportScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>('input');
  const [csvText, setCsvText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [parsed, setParsed] = useState<ParsedTransaction[]>([]);
  const [importing, setImporting] = useState(false);
  const [importCount, setImportCount] = useState(0);

  const activeAccounts = (accounts ?? []).filter((a) => !a.isArchived);

  const handleParse = () => {
    if (!csvText.trim()) {
      Alert.alert('No data', 'Please paste CSV data to import.');
      return;
    }
    if (!accountId) {
      Alert.alert('Select account', 'Please choose which account to import into.');
      return;
    }
    const results = parseCSV(csvText);
    if (results.length === 0) {
      Alert.alert('No transactions found', 'Could not parse any transactions from the CSV data.');
      return;
    }
    setParsed(results);
    setStep('preview');
  };

  const toggleRow = (index: number) => {
    setParsed((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, selected: !row.selected } : row
      )
    );
  };

  const toggleAll = () => {
    const allSelected = parsed.every((r) => r.selected);
    setParsed((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));
  };

  const selectedCount = parsed.filter((r) => r.selected).length;
  const selectedTotal = parsed
    .filter((r) => r.selected)
    .reduce((sum, r) => sum + r.amount, 0);

  const handleImport = async () => {
    const toImport = parsed.filter((r) => r.selected);
    if (toImport.length === 0) {
      Alert.alert('Nothing selected', 'Please select at least one transaction to import.');
      return;
    }

    setImporting(true);
    try {
      const txnRows = toImport.map((r) => ({
        user_id: user!.id,
        account_id: accountId,
        txn_date: r.date,
        payee: r.payee || '(imported)',
        amount: r.amount,
        memo: r.memo || null,
        status: 'cleared',
      }));

      const { data: inserted, error } = await supabase
        .from('transactions')
        .insert(txnRows)
        .select('id');

      if (error) {
        throw error;
      }

      setImportCount(inserted.length);
      setStep('done');
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['transactions', accountId] });
    } catch (e: any) {
      Alert.alert('Import failed', e.message);
    } finally {
      setImporting(false);
    }
  };

  if (step === 'done') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.doneContent}>
          <View style={[styles.doneIcon, { backgroundColor: colors.incomeLight }]}>
            <FontAwesome name="check" size={48} color={colors.income} />
          </View>
          <Text style={[styles.doneTitle, { color: colors.text }]}>Import Complete</Text>
          <Text style={[styles.doneSubtitle, { color: colors.textSecondary }]}>
            {importCount} transaction{importCount !== 1 ? 's' : ''} imported successfully.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: colors.tint, alignSelf: 'stretch' }]}
            onPress={() => router.back()}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (step === 'preview') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.previewHeader, { backgroundColor: colors.surface }]}>
          <View style={styles.previewHeaderRow}>
            <TouchableOpacity onPress={toggleAll} style={styles.selectAllBtn}>
              <FontAwesome
                name={parsed.every((r) => r.selected) ? 'check-square-o' : 'square-o'}
                size={20}
                color={colors.tint}
              />
              <Text style={[styles.selectAllText, { color: colors.tint }]}>
                {parsed.every((r) => r.selected) ? 'Deselect All' : 'Select All'}
              </Text>
            </TouchableOpacity>
            <Text style={[styles.previewSummary, { color: colors.textSecondary }]}>
              {selectedCount} of {parsed.length} selected
            </Text>
          </View>
          <Text style={[styles.previewTotal, {
            color: selectedTotal >= 0 ? colors.income : colors.expense,
          }]}>
            Net: {formatCurrency(selectedTotal)}
          </Text>
        </View>

        <FlatList
          data={parsed}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item, index }) => (
            <TouchableOpacity
              style={[styles.txnRow, {
                borderBottomColor: colors.separator,
                opacity: item.selected ? 1 : 0.4,
              }]}
              onPress={() => toggleRow(index)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={item.selected ? 'check-square-o' : 'square-o'}
                size={20}
                color={item.selected ? colors.tint : colors.placeholder}
              />
              <View style={styles.txnCenter}>
                <Text style={[styles.txnPayee, { color: colors.text }]} numberOfLines={1}>
                  {item.payee || '(no payee)'}
                </Text>
                <View style={styles.txnMeta}>
                  <Text style={[styles.txnDate, { color: colors.textSecondary }]}>
                    {formatDateShort(item.date)}
                  </Text>
                  {item.category ? (
                    <Text style={[styles.txnDate, { color: colors.textSecondary }]}>
                      {item.category}
                    </Text>
                  ) : null}
                </View>
              </View>
              <Text
                style={[
                  styles.txnAmount,
                  { color: item.amount >= 0 ? colors.income : colors.expense },
                ]}
              >
                {formatCurrency(item.amount)}
              </Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={styles.list}
        />

        <View style={[styles.footer, { backgroundColor: colors.surface }]}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.border }]}
            onPress={() => setStep('input')}
          >
            <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, {
              backgroundColor: importing ? colors.placeholder : colors.tint,
              flex: 2,
            }]}
            onPress={handleImport}
            disabled={importing || selectedCount === 0}
          >
            {importing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>
                Import {selectedCount} Transaction{selectedCount !== 1 ? 's' : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.form}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Import Into</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
          {activeAccounts.map((a) => (
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
                fontSize: 14,
                fontWeight: '500',
              }}>
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 24 }]}>
          Paste CSV Data
        </Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Supports GreenBooks, bank exports, and other CSV formats with Date, Payee/Title, and Amount columns.
        </Text>

        <TextInput
          style={[styles.csvInput, {
            backgroundColor: colors.surface,
            color: colors.text,
            borderColor: colors.border,
          }]}
          value={csvText}
          onChangeText={setCsvText}
          placeholder={'Date,Title,Category,Note,Amount\n04/02/2026,"Coffee Shop",,,-5.50'}
          placeholderTextColor={colors.placeholder}
          multiline
          textAlignVertical="top"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TouchableOpacity
          style={[styles.primaryBtn, {
            backgroundColor: !csvText.trim() || !accountId ? colors.placeholder : colors.tint,
            marginTop: 20,
          }]}
          onPress={handleParse}
          disabled={!csvText.trim() || !accountId}
        >
          <FontAwesome name="search" size={16} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.primaryBtnText}>Preview Transactions</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  form: { padding: 20 },
  sectionTitle: { fontSize: 17, fontWeight: '700', marginBottom: 10 },
  hint: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  chipScroll: { marginBottom: 4 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  csvInput: {
    minHeight: 200,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 13,
    fontFamily: 'SpaceMono',
    lineHeight: 20,
  },
  primaryBtn: {
    height: 50,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    flex: 1,
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { fontSize: 16, fontWeight: '600' },
  previewHeader: {
    padding: 16,
    gap: 8,
  },
  previewHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  selectAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectAllText: { fontSize: 14, fontWeight: '500' },
  previewSummary: { fontSize: 13 },
  previewTotal: { fontSize: 16, fontWeight: '700' },
  list: { paddingBottom: 120 },
  txnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  txnCenter: { flex: 1 },
  txnPayee: { fontSize: 15, fontWeight: '500' },
  txnMeta: { flexDirection: 'row', gap: 8, marginTop: 3, alignItems: 'center' },
  txnDate: { fontSize: 12 },
  txnAmount: { fontSize: 15, fontWeight: '600' },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    padding: 16,
    paddingBottom: 32,
    gap: 12,
  },
  doneContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  doneIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  doneTitle: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  doneSubtitle: { fontSize: 16, marginBottom: 32 },
});

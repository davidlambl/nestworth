import React, { useState, useLayoutEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { router, useNavigation } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import FormError from '@/components/FormError';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDateShort, balanceColor } from '@/lib/format';
import { parseCSV, ParsedTransaction, RefusedCSVRow } from '@/lib/csvImport';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requestPush } from '@/lib/sync';
import { setLastError } from '@/lib/syncStatus';
import { applyTransactionImport } from '@/lib/transactionImport';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';

type Step = 'input' | 'preview' | 'done';

// The preview lists refused lines in its list's header, which is not
// virtualized: past this many they are counted, not listed. A file in another
// number format (1.234,56) has every line refused (#165).
const REFUSED_LISTED = 100;

export default function ImportScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();
  const { user } = useAuth();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();

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

  const [step, setStep] = useState<Step>('input');
  const [csvText, setCsvText] = useState('');
  const [accountId, setAccountId] = useState('');
  const [parsed, setParsed] = useState<ParsedTransaction[]>([]);
  const [refused, setRefused] = useState<RefusedCSVRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  // Shown on the screen itself, above the button just pressed: Alert.alert is
  // a no-op on web and in Electron, where this screen said nothing (#164).
  const [formError, setFormError] = useState<string | null>(null);

  const activeAccounts = (accounts ?? []).filter((a) => !a.isArchived);

  const handleParse = () => {
    if (!csvText.trim()) {
      setFormError('Please paste CSV data to import.');
      return;
    }
    if (!accountId) {
      setFormError('Please choose which account to import into.');
      return;
    }
    const { rows, refused: refusedRows } = parseCSV(csvText);
    // A file whose every line was refused still opens the preview, which says
    // why (#165); only one with no transaction lines at all stops here.
    if (rows.length === 0 && refusedRows.length === 0) {
      setFormError('Could not parse any transactions from the CSV data.');
      return;
    }
    setFormError(null);
    setParsed(rows);
    setRefused(refusedRows);
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
      setFormError('Please select at least one transaction to import.');
      return;
    }
    setFormError(null);

    setImporting(true);
    try {
      const db = await getDb();
      // One transaction, all rows or none, and only into a live account
      // (#163): see lib/transactionImport.ts, which also skips duplicates.
      const { imported, skipped } = await applyTransactionImport(
        db,
        { userId: user!.id, accountId, rows: toImport },
        {
          now: new Date().toISOString(),
          newId: () => Crypto.randomUUID(),
        }
      );

      requestPush(user!.id);
      setImportCount(imported);
      setSkippedCount(skipped);
      setStep('done');
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['transactions', accountId] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFormError(`Import failed: ${message}`);
      // Not a mutation, so the mutation cache never sees the failure: report
      // it on the sync indicator by hand too, as useReceiptPhoto does. The
      // next sync to start clears it. A refused import (an account no longer
      // live here) also refetches the account list, which still showed it.
      setLastError(`Save failed: ${message}`);
      qc.invalidateQueries({ queryKey: ['accounts'] });
    } finally {
      setImporting(false);
    }
  };

  if (step === 'done') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.doneContent}>
          <View
            style={[styles.doneIcon, { backgroundColor: colors.incomeLight }]}
          >
            <FontAwesome name="check" size={48} color={colors.income} />
          </View>
          <Text style={[styles.doneTitle, { color: colors.text }]}>
            Import Complete
          </Text>
          <Text style={[styles.doneSubtitle, { color: colors.textSecondary }]}>
            {importCount} transaction{importCount !== 1 ? 's' : ''} imported
            successfully.
            {skippedCount > 0
              ? ` ${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''} skipped.`
              : ''}
          </Text>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              { backgroundColor: colors.tint, alignSelf: 'stretch' },
            ]}
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
        <View
          style={[styles.previewHeader, { backgroundColor: colors.surface }]}
        >
          <View style={styles.previewHeaderRow}>
            {/* A file whose every line was refused has no row to select:
                no checked "Deselect All" over nothing (#165). */}
            {parsed.length > 0 ? (
              <TouchableOpacity onPress={toggleAll} style={styles.selectAllBtn}>
                <FontAwesome
                  name={
                    parsed.every((r) => r.selected)
                      ? 'check-square-o'
                      : 'square-o'
                  }
                  size={20}
                  color={colors.tint}
                />
                <Text style={[styles.selectAllText, { color: colors.tint }]}>
                  {parsed.every((r) => r.selected)
                    ? 'Deselect All'
                    : 'Select All'}
                </Text>
              </TouchableOpacity>
            ) : null}
            <Text
              style={[styles.previewSummary, { color: colors.textSecondary }]}
            >
              {selectedCount} of {parsed.length} selected
            </Text>
          </View>
          <Text
            style={[
              styles.previewTotal,
              {
                color: balanceColor(selectedTotal, colors),
              },
            ]}
          >
            Net: {formatCurrency(selectedTotal)}
          </Text>
        </View>

        <FlatList
          data={parsed}
          keyExtractor={(_, i) => String(i)}
          // The lines that will not be imported, and why, at the top of the
          // list: seen before Import on every platform, and above anything the
          // footer covers (#165).
          ListHeaderComponent={
            refused.length > 0 ? (
              <View
                testID="import-refused"
                style={[
                  styles.refused,
                  {
                    backgroundColor: colors.expenseLight,
                    borderColor: colors.expense,
                  },
                ]}
              >
                <Text style={[styles.refusedTitle, { color: colors.expense }]}>
                  {refused.length} line{refused.length !== 1 ? 's' : ''}{' '}
                  can&apos;t be imported
                </Text>
                <Text style={[styles.refusedHint, { color: colors.text }]}>
                  Dates must read like 01/15/2026 (month first) or 2026-01-15,
                  and amounts like 1,234.56, -5.00 or (5.00). Fix these lines
                  and import the file again: rows already imported into this
                  account are skipped as duplicates.
                </Text>
                {/* A date that can only be day first is the one sign a file
                    writes the day first: its other dates, up to the 12th,
                    imported month first without a word (#36). */}
                {refused.some((r) => r.dayFirst) ? (
                  <Text
                    testID="import-day-first"
                    style={[styles.refusedWarning, { color: colors.text }]}
                  >
                    If this file writes the day first, its dates up to the 12th
                    were read month first, the wrong way round (05/01/2026 as
                    May 1): before importing, write the file&apos;s dates year
                    first, like 2026-01-05, and paste it again.
                  </Text>
                ) : null}
                {/* Four lines: a bank-length payee and both reasons take
                    three on a phone (#36). */}
                {refused.slice(0, REFUSED_LISTED).map((r) => (
                  <Text
                    key={r.line}
                    style={[styles.refusedLine, { color: colors.text }]}
                    numberOfLines={4}
                  >
                    Line {r.line}
                    {r.payee ? ` · ${r.payee}` : ''}: {r.reason}
                  </Text>
                ))}
                {refused.length > REFUSED_LISTED ? (
                  <Text
                    style={[
                      styles.refusedLine,
                      { color: colors.textSecondary },
                    ]}
                  >
                    …and {refused.length - REFUSED_LISTED} more.
                  </Text>
                ) : null}
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <TouchableOpacity
              style={[
                styles.txnRow,
                {
                  borderBottomColor: colors.separator,
                  opacity: item.selected ? 1 : 0.4,
                },
              ]}
              onPress={() => toggleRow(index)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={item.selected ? 'check-square-o' : 'square-o'}
                size={20}
                color={item.selected ? colors.tint : colors.placeholder}
              />
              <View style={styles.txnCenter}>
                <Text
                  style={[styles.txnPayee, { color: colors.text }]}
                  numberOfLines={1}
                >
                  {item.payee || '(no payee)'}
                </Text>
                <View style={styles.txnMeta}>
                  <Text
                    style={[styles.txnDate, { color: colors.textSecondary }]}
                  >
                    {formatDateShort(item.date)}
                  </Text>
                  {item.category ? (
                    <Text
                      style={[styles.txnDate, { color: colors.textSecondary }]}
                    >
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
          contentContainerStyle={[
            styles.list,
            // The footer floats over the list and grows by the error's lines.
            formError ? styles.listUnderError : null,
          ]}
        />

        <View style={[styles.footer, { backgroundColor: colors.surface }]}>
          <FormError
            message={formError}
            testID="import-preview-error"
            style={styles.footerError}
          />
          <View style={styles.footerButtons}>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={() => {
                setFormError(null);
                setStep('input');
              }}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                Back
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {
                  backgroundColor: importing ? colors.placeholder : colors.tint,
                  flex: 2,
                },
              ]}
              onPress={handleImport}
              disabled={importing || selectedCount === 0}
            >
              {importing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  Import {selectedCount} Transaction
                  {selectedCount !== 1 ? 's' : ''}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
      // iOS (#39): insets the content by what the keyboard covers and scrolls
      // the focused field above it, so Preview can be reached with the
      // keyboard up. A KeyboardAvoidingView falls short in this page-sheet
      // modal: see "The iOS keyboard" in CONTRIBUTING.md. Web and Android
      // ignore it.
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.form}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Import Into
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
        >
          {activeAccounts.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={[
                styles.chip,
                {
                  backgroundColor:
                    accountId === a.id ? colors.tint : colors.surface,
                  borderColor: accountId === a.id ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setAccountId(a.id)}
            >
              <Text
                style={{
                  color: accountId === a.id ? '#fff' : colors.text,
                  fontSize: 14,
                  fontWeight: '500',
                }}
              >
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text
          style={[styles.sectionTitle, { color: colors.text, marginTop: 24 }]}
        >
          Paste CSV Data
        </Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Supports GreenBooks, bank exports, and other CSV formats with Date,
          Payee/Title, and Amount columns.
        </Text>

        <TextInput
          testID="import-csv-input"
          style={[
            styles.csvInput,
            {
              backgroundColor: colors.surface,
              color: colors.text,
              borderColor: colors.border,
            },
          ]}
          value={csvText}
          onChangeText={setCsvText}
          placeholder={
            'Date,Title,Category,Note,Amount\n04/02/2026,"Coffee Shop",,,-5.50'
          }
          placeholderTextColor={colors.placeholder}
          multiline
          textAlignVertical="top"
          autoCapitalize="none"
          autoCorrect={false}
        />

        <FormError
          message={formError}
          testID="import-error"
          style={styles.inputError}
        />

        <TouchableOpacity
          testID="import-preview-btn"
          style={[
            styles.primaryBtn,
            {
              backgroundColor:
                !csvText.trim() || !accountId
                  ? colors.placeholder
                  : colors.tint,
              marginTop: 20,
            },
          ]}
          onPress={handleParse}
          disabled={!csvText.trim() || !accountId}
        >
          <FontAwesome
            name="search"
            size={16}
            color="#fff"
            style={{ marginRight: 8 }}
          />
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
  listUnderError: { paddingBottom: 200 },
  refused: {
    margin: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 6,
  },
  refusedTitle: { fontSize: 15, fontWeight: '700' },
  refusedHint: { fontSize: 13, lineHeight: 18 },
  refusedWarning: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  refusedLine: { fontSize: 13 },
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
    padding: 16,
    paddingBottom: 32,
  },
  footerError: { marginBottom: 12 },
  footerButtons: { flexDirection: 'row', gap: 12 },
  inputError: { marginTop: 16 },
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

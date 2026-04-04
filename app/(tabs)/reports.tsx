import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/lib/supabaseHelpers';
import type { DbTransaction } from '@/lib/types';

type Period = '1m' | '3m' | '6m' | '1y' | 'all';

function getStartDate(period: Period): string | null {
  if (period === 'all') {
    return null;
  }
  const d = new Date();
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 };
  d.setMonth(d.getMonth() - months[period]);
  return d.toISOString().split('T')[0];
}

export default function ReportsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>('1m');

  const startDate = getStartDate(period);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['reports', user?.id, period],
    queryFn: async () => {
      const txns = await fetchAll<DbTransaction>(
        'transactions',
        (b) => {
          let q = b.select('*').eq('user_id', user!.id);
          if (startDate) {
            q = q.gte('txn_date', startDate);
          }
          return q;
        }
      );

      let totalIncome = 0;
      let totalExpense = 0;
      for (const t of txns) {
        if (t.amount >= 0) {
          totalIncome += t.amount;
        } else {
          totalExpense += Math.abs(t.amount);
        }
      }

      return { totalIncome, totalExpense, txnCount: txns.length };
    },
    enabled: !!user,
  });

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.periodRow}>
        {(['1m', '3m', '6m', '1y', 'all'] as Period[]).map((p) => (
          <TouchableOpacity
            key={p}
            style={[
              styles.periodChip,
              {
                backgroundColor: period === p ? colors.tint : colors.surface,
                borderColor: period === p ? colors.tint : colors.border,
              },
            ]}
            onPress={() => setPeriod(p)}
          >
            <Text style={{
              color: period === p ? '#fff' : colors.text,
              fontSize: 13,
              fontWeight: '600',
            }}>
              {p === 'all' ? 'All' : p.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: colors.incomeLight }]}>
          <Text style={[styles.summaryLabel, { color: colors.income }]}>Income</Text>
          <Text style={[styles.summaryAmount, { color: colors.income }]}>
            {formatCurrency(reportData?.totalIncome ?? 0)}
          </Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: colors.expenseLight }]}>
          <Text style={[styles.summaryLabel, { color: colors.expense }]}>Expense</Text>
          <Text style={[styles.summaryAmount, { color: colors.expense }]}>
            {formatCurrency(reportData?.totalExpense ?? 0)}
          </Text>
        </View>
      </View>

      <View style={[styles.netCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.netLabel, { color: colors.textSecondary }]}>Net</Text>
        <Text style={[styles.netAmount, {
          color: (reportData?.totalIncome ?? 0) - (reportData?.totalExpense ?? 0) >= 0
            ? colors.income
            : colors.expense,
        }]}>
          {formatCurrency(
            (reportData?.totalIncome ?? 0) - (reportData?.totalExpense ?? 0)
          )}
        </Text>
        <Text style={[styles.txnCount, { color: colors.textSecondary }]}>
          {reportData?.txnCount ?? 0} transactions
        </Text>
      </View>

      {(reportData?.txnCount ?? 0) === 0 && (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          No data for this period
        </Text>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  periodRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 16,
  },
  periodChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  summaryCard: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  summaryLabel: { fontSize: 13, fontWeight: '600', marginBottom: 4 },
  summaryAmount: { fontSize: 20, fontWeight: '700' },
  netCard: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  netLabel: { fontSize: 13, fontWeight: '500' },
  netAmount: { fontSize: 24, fontWeight: '700', marginTop: 4 },
  txnCount: { fontSize: 12, marginTop: 4 },
  emptyText: { textAlign: 'center', paddingTop: 20, fontSize: 15 },
});

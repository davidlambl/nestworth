import React, { useMemo, useState } from 'react';
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
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useCategories } from '@/lib/hooks/useCategories';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import type { DbTransaction, DbTransactionSplit } from '@/lib/types';

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
  const { data: categories } = useCategories();
  const [period, setPeriod] = useState<Period>('1m');

  const startDate = getStartDate(period);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['reports', user?.id, period],
    queryFn: async () => {
      let query = supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user!.id);
      if (startDate) {
        query = query.gte('txn_date', startDate);
      }
      const { data: txns, error } = await query;
      if (error) {
        throw error;
      }

      const txnIds = (txns as DbTransaction[]).map((t) => t.id);
      let splits: DbTransactionSplit[] = [];
      if (txnIds.length > 0) {
        const { data: s, error: se } = await supabase
          .from('transaction_splits')
          .select('*')
          .in('transaction_id', txnIds);
        if (se) {
          throw se;
        }
        splits = s as DbTransactionSplit[];
      }

      let totalIncome = 0;
      let totalExpense = 0;
      for (const t of txns as DbTransaction[]) {
        if (t.amount >= 0) {
          totalIncome += t.amount;
        } else {
          totalExpense += Math.abs(t.amount);
        }
      }

      const byCat = new Map<string | null, number>();
      for (const s of splits) {
        const prev = byCat.get(s.category_id) ?? 0;
        byCat.set(s.category_id, prev + Math.abs(s.amount));
      }

      const uncategorized = (txns as DbTransaction[])
        .filter((t) => !splits.some((s) => s.transaction_id === t.id))
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);
      if (uncategorized > 0) {
        byCat.set(null, (byCat.get(null) ?? 0) + uncategorized);
      }

      const categoryBreakdown = Array.from(byCat.entries())
        .map(([catId, amount]) => ({
          categoryId: catId,
          amount,
        }))
        .sort((a, b) => b.amount - a.amount);

      return { totalIncome, totalExpense, categoryBreakdown, txnCount: txns.length };
    },
    enabled: !!user,
  });

  const catMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) {
      m.set(c.id, c.name);
    }
    return m;
  }, [categories]);

  const maxCatAmount = reportData?.categoryBreakdown[0]?.amount ?? 1;

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

      <Text style={[styles.sectionTitle, { color: colors.text }]}>Spending by Category</Text>
      {(reportData?.categoryBreakdown ?? []).map((item) => {
        const pct = maxCatAmount > 0 ? (item.amount / maxCatAmount) * 100 : 0;
        return (
          <View key={item.categoryId ?? 'uncategorized'} style={styles.barRow}>
            <Text style={[styles.barLabel, { color: colors.text }]} numberOfLines={1}>
              {item.categoryId ? catMap.get(item.categoryId) ?? 'Unknown' : 'Uncategorized'}
            </Text>
            <View style={styles.barTrack}>
              <View
                style={[styles.barFill, {
                  width: `${Math.max(pct, 2)}%`,
                  backgroundColor: colors.tint,
                }]}
              />
            </View>
            <Text style={[styles.barAmount, { color: colors.textSecondary }]}>
              {formatCurrency(item.amount)}
            </Text>
          </View>
        );
      })}

      {(reportData?.categoryBreakdown ?? []).length === 0 && (
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 12,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  barLabel: { width: 100, fontSize: 13 },
  barTrack: {
    flex: 1,
    height: 20,
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  barFill: {
    height: 20,
    borderRadius: 10,
  },
  barAmount: { width: 80, textAlign: 'right', fontSize: 13 },
  emptyText: { textAlign: 'center', paddingTop: 20, fontSize: 15 },
});

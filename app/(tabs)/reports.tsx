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
import { useTheme } from '@/lib/theme';
import Colors from '@/constants/Colors';
import { formatCurrency } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { getDb } from '@/lib/db';
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
  const { fontScale } = useTheme();
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>('1m');

  const startDate = getStartDate(period);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['reports', user?.id, period],
    queryFn: async () => {
      const db = await getDb();
      const params: any[] = [user!.id];
      let sql = `SELECT * FROM transactions WHERE user_id = ? AND _sync_status != 'deleted'`;
      if (startDate) {
        sql += ' AND txn_date >= ?';
        params.push(startDate);
      }
      const txns = await db.getAllAsync<DbTransaction>(sql, params);

      let totalIncome = 0;
      let totalExpense = 0;
      for (const t of txns) {
        if (t.amount >= 0) {
          totalIncome += t.amount;
        } else {
          totalExpense += Math.abs(t.amount);
        }
      }

      return { totalIncome, totalExpense, txnCount: txns.length, txns };
    },
    enabled: !!user,
  });

  const topPayees = useMemo(() => {
    if (!reportData?.txns) {
      return [];
    }
    const map = new Map<string, { total: number; count: number }>();
    for (const t of reportData.txns) {
      if (t.amount >= 0) {
        continue;
      }
      const key = t.payee;
      const cur = map.get(key) ?? { total: 0, count: 0 };
      cur.total += Math.abs(t.amount);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([payee, data]) => ({ payee, ...data }));
  }, [reportData?.txns]);

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
              fontSize: 13 * fontScale,
              fontWeight: '600',
            }}>
              {p === 'all' ? 'All' : p.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: colors.incomeLight }]}>
          <Text style={[styles.summaryLabel, {
            color: colors.income,
            fontSize: 13 * fontScale,
          }]}>Income</Text>
          <Text style={[styles.summaryAmount, {
            color: colors.income,
            fontSize: 20 * fontScale,
          }]}>
            {formatCurrency(reportData?.totalIncome ?? 0)}
          </Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: colors.expenseLight }]}>
          <Text style={[styles.summaryLabel, {
            color: colors.expense,
            fontSize: 13 * fontScale,
          }]}>Expense</Text>
          <Text style={[styles.summaryAmount, {
            color: colors.expense,
            fontSize: 20 * fontScale,
          }]}>
            {formatCurrency(reportData?.totalExpense ?? 0)}
          </Text>
        </View>
      </View>

      <View style={[styles.netCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.netLabel, {
          color: colors.textSecondary,
          fontSize: 13 * fontScale,
        }]}>Net</Text>
        <Text style={[styles.netAmount, {
          color: (reportData?.totalIncome ?? 0) - (reportData?.totalExpense ?? 0) >= 0
            ? colors.income
            : colors.expense,
          fontSize: 24 * fontScale,
        }]}>
          {formatCurrency(
            (reportData?.totalIncome ?? 0) - (reportData?.totalExpense ?? 0)
          )}
        </Text>
        <Text style={[styles.txnCount, {
          color: colors.textSecondary,
          fontSize: 12 * fontScale,
        }]}>
          {reportData?.txnCount ?? 0} transactions
        </Text>
      </View>

      {topPayees.length > 0 && (
        <View style={styles.topPayeesSection}>
          <Text style={[styles.sectionTitle, {
            color: colors.text,
            fontSize: 15 * fontScale,
          }]}>
            Top Spending
          </Text>
          <View style={[styles.payeesList, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {topPayees.map((item, idx) => (
              <View
                key={item.payee}
                style={[
                  styles.payeeRow,
                  idx < topPayees.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
                ]}
              >
                <Text style={[styles.payeeRank, {
                  color: colors.textSecondary,
                  fontSize: 13 * fontScale,
                }]}>
                  {idx + 1}
                </Text>
                <View style={styles.payeeCenter}>
                  <Text style={[styles.payeeName, {
                    color: colors.text,
                    fontSize: 15 * fontScale,
                  }]} numberOfLines={1}>
                    {item.payee}
                  </Text>
                  <Text style={[styles.payeeTxnCount, {
                    color: colors.textSecondary,
                    fontSize: 12 * fontScale,
                  }]}>
                    {item.count} transaction{item.count !== 1 ? 's' : ''}
                  </Text>
                </View>
                <Text style={[styles.payeeTotal, {
                  color: colors.expense,
                  fontSize: 15 * fontScale,
                }]}>
                  {formatCurrency(-item.total)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {(reportData?.txnCount ?? 0) === 0 && (
        <Text style={[styles.emptyText, {
          color: colors.textSecondary,
          fontSize: 15 * fontScale,
        }]}>
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
    fontSize: 15,
    fontWeight: '700',
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 10,
  },
  topPayeesSection: {},
  payeesList: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  payeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  payeeRank: {
    fontSize: 13,
    fontWeight: '600',
    width: 20,
    textAlign: 'center',
  },
  payeeCenter: { flex: 1 },
  payeeName: { fontSize: 15, fontWeight: '500' },
  payeeTxnCount: { fontSize: 12, marginTop: 2 },
  payeeTotal: { fontSize: 15, fontWeight: '600' },
  emptyText: { textAlign: 'center', paddingTop: 20, fontSize: 15 },
});

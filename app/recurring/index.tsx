import React from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency, formatDate, balanceColor } from '@/lib/format';
import { confirm } from '@/lib/confirm';
import { useAccounts } from '@/lib/hooks/useAccounts';
import {
  useRecurringRules,
  useDeleteRecurringRule,
  usePostRecurringTransaction,
} from '@/lib/hooks/useRecurringRules';
import type { RecurringRule } from '@/lib/types';
import { rightOffset, sidePadding } from '@/lib/layout';
import { useScreenInsets } from '@/lib/hooks/useScreenInsets';

const FrequencyLabels: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  semimonthly: 'Twice a month',
  quarterly: 'Quarterly',
  biannually: 'Every 6 months',
  yearly: 'Yearly',
};

export default function RecurringScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const insets = useScreenInsets();

  const { data: rules, isLoading } = useRecurringRules();
  const { data: accounts } = useAccounts();
  const deleteRule = useDeleteRecurringRule();
  const postTxn = usePostRecurringTransaction();

  const accountName = (id: string) =>
    accounts?.find((a) => a.id === id)?.name ?? 'Unknown';

  const today = new Date().toISOString().split('T')[0];

  const handlePost = async (rule: RecurringRule) => {
    const ok = await confirm({
      title: 'Post Transaction',
      message: `Post ${rule.template.payee} for ${formatCurrency(rule.template.amount)} on ${formatDate(rule.nextDate)}?`,
      confirmText: 'Post',
    });
    if (ok) {
      postTxn.mutate(rule);
    }
  };

  const handleDelete = async (rule: RecurringRule) => {
    const ok = await confirm({
      title: 'Delete Rule',
      message: 'Delete this recurring transaction rule?',
      confirmText: 'Delete',
      destructive: true,
    });
    if (ok) {
      deleteRule.mutate(rule.id);
    }
  };

  const renderRule = ({ item }: { item: RecurringRule }) => {
    const isDue = item.nextDate <= today;
    const acctObj = accounts?.find((a) => a.id === item.accountId);
    const acctArchived = acctObj?.isArchived ?? false;
    return (
      <TouchableOpacity
        style={[
          styles.ruleCard,
          {
            backgroundColor: colors.surface,
            borderColor: isDue ? colors.tint : colors.border,
            borderWidth: isDue ? 2 : 1,
          },
        ]}
        onLongPress={() => handleDelete(item)}
        activeOpacity={0.8}
      >
        <View style={styles.ruleHeader}>
          <Text style={[styles.rulePayee, { color: colors.text }]}>
            {item.template.payee}
          </Text>
          <Text
            style={[
              styles.ruleAmount,
              { color: balanceColor(item.template.amount, colors) },
            ]}
          >
            {formatCurrency(item.template.amount)}
          </Text>
        </View>
        <View style={styles.ruleMeta}>
          <Text style={[styles.ruleFreq, { color: colors.textSecondary }]}>
            {FrequencyLabels[item.frequency] ?? item.frequency}
          </Text>
          <Text
            style={[
              styles.ruleAcct,
              {
                color: colors.textSecondary,
                opacity: acctArchived ? 0.5 : 1,
              },
            ]}
          >
            {accountName(item.accountId)}
            {acctArchived ? ' (archived)' : ''}
          </Text>
        </View>
        <View style={styles.ruleFooter}>
          <Text
            style={[
              styles.ruleNext,
              {
                color: isDue ? colors.tint : colors.textSecondary,
                fontWeight: isDue ? '600' : '400',
              },
            ]}
          >
            {isDue ? 'Due: ' : 'Next: '}
            {formatDate(item.nextDate)}
          </Text>
          {isDue && !acctArchived && (
            <TouchableOpacity
              style={[styles.postBtn, { backgroundColor: colors.tint }]}
              onPress={() => handlePost(item)}
            >
              <Text style={styles.postBtnText}>Post Now</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background },
        sidePadding(insets),
      ]}
    >
      <FlatList
        data={rules ?? []}
        keyExtractor={(item) => item.id}
        renderItem={renderRule}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <FontAwesome name="repeat" size={48} color={colors.placeholder} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No recurring transactions
            </Text>
            <Text style={[styles.emptySubtext, { color: colors.placeholder }]}>
              Tap + to set up a repeating transaction
            </Text>
          </View>
        }
      />

      <TouchableOpacity
        testID="recurring-add-btn"
        style={[
          styles.fab,
          { backgroundColor: colors.tint },
          rightOffset(insets, FAB_OFFSET),
        ]}
        onPress={() => router.push('/recurring/new')}
        accessibilityRole="button"
        accessibilityLabel="New recurring rule"
      >
        <FontAwesome name="plus" size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// The "+" floats this far from the right edge, plus the right inset.
const FAB_OFFSET = 24;

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: 16, paddingBottom: 100 },
  ruleCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  ruleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  rulePayee: { fontSize: 16, fontWeight: '600', flex: 1 },
  ruleAmount: { fontSize: 16, fontWeight: '700' },
  ruleMeta: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
  },
  ruleFreq: { fontSize: 13 },
  ruleAcct: { fontSize: 13 },
  ruleFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  ruleNext: { fontSize: 13 },
  postBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  postBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 18, fontWeight: '600' },
  emptySubtext: { fontSize: 14 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: FAB_OFFSET,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 4px 8px rgba(0,0,0,0.2)',
  },
});

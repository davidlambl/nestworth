import React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import type { Category } from '@/lib/types';
import { formatCurrency } from '@/lib/format';

export interface SplitRow {
  categoryId: string | null;
  amount: string;
  memo: string;
}

interface SplitEditorProps {
  splits: SplitRow[];
  onChange: (splits: SplitRow[]) => void;
  categories: Category[];
  totalAmount: number;
  isExpense: boolean;
}

export function SplitEditor({
  splits,
  onChange,
  categories,
  totalAmount,
  isExpense,
}: SplitEditorProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];

  const filteredCats = categories.filter(
    (c) => (isExpense ? c.type === 'expense' : c.type === 'income')
  );

  const allocated = splits.reduce(
    (sum, s) => sum + (parseFloat(s.amount) || 0),
    0
  );
  const remaining = Math.abs(totalAmount) - allocated;

  const addSplit = () => {
    onChange([...splits, { categoryId: null, amount: '', memo: '' }]);
  };

  const removeSplit = (index: number) => {
    onChange(splits.filter((_, i) => i !== index));
  };

  const updateSplit = (index: number, field: keyof SplitRow, value: string) => {
    const updated = splits.map((s, i) =>
      i === index ? { ...s, [field]: value } : s
    );
    onChange(updated);
  };

  const setCategoryForSplit = (index: number, catId: string | null) => {
    const updated = splits.map((s, i) =>
      i === index ? { ...s, categoryId: catId } : s
    );
    onChange(updated);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.headerText, { color: colors.text }]}>Split Transaction</Text>
        <Text style={[styles.remaining, {
          color: Math.abs(remaining) < 0.01 ? colors.income : colors.expense,
        }]}>
          {Math.abs(remaining) < 0.01
            ? 'Fully allocated'
            : `${formatCurrency(remaining)} remaining`}
        </Text>
      </View>

      {splits.map((split, index) => (
        <View
          key={index}
          style={[styles.splitRow, {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          }]}
        >
          <View style={styles.splitHeader}>
            <Text style={[styles.splitLabel, { color: colors.textSecondary }]}>
              Split {index + 1}
            </Text>
            <TouchableOpacity onPress={() => removeSplit(index)} hitSlop={8}>
              <FontAwesome name="times-circle" size={20} color={colors.placeholder} />
            </TouchableOpacity>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catRow}>
            <TouchableOpacity
              style={[
                styles.catChip,
                {
                  backgroundColor: split.categoryId === null ? colors.tint : 'transparent',
                  borderColor: split.categoryId === null ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setCategoryForSplit(index, null)}
            >
              <Text style={{
                color: split.categoryId === null ? '#fff' : colors.text,
                fontSize: 12,
              }}>
                None
              </Text>
            </TouchableOpacity>
            {filteredCats.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={[
                  styles.catChip,
                  {
                    backgroundColor: split.categoryId === c.id ? colors.tint : 'transparent',
                    borderColor: split.categoryId === c.id ? colors.tint : colors.border,
                  },
                ]}
                onPress={() => setCategoryForSplit(index, c.id)}
              >
                <Text style={{
                  color: split.categoryId === c.id ? '#fff' : colors.text,
                  fontSize: 12,
                }}>
                  {c.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={styles.splitInputRow}>
            <TextInput
              style={[styles.splitAmount, {
                backgroundColor: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }]}
              value={split.amount}
              onChangeText={(v) => updateSplit(index, 'amount', v)}
              placeholder="0.00"
              placeholderTextColor={colors.placeholder}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.splitMemo, {
                backgroundColor: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }]}
              value={split.memo}
              onChangeText={(v) => updateSplit(index, 'memo', v)}
              placeholder="Memo"
              placeholderTextColor={colors.placeholder}
            />
          </View>
        </View>
      ))}

      <TouchableOpacity
        style={[styles.addBtn, { borderColor: colors.border }]}
        onPress={addSplit}
      >
        <FontAwesome name="plus" size={14} color={colors.tint} />
        <Text style={[styles.addBtnText, { color: colors.tint }]}>Add Split</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 8 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerText: { fontSize: 15, fontWeight: '600' },
  remaining: { fontSize: 13 },
  splitRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  splitHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  splitLabel: { fontSize: 12, fontWeight: '600' },
  catRow: { marginBottom: 8 },
  catChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
    marginRight: 6,
  },
  splitInputRow: { flexDirection: 'row', gap: 8 },
  splitAmount: {
    width: 100,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 15,
    fontWeight: '600',
  },
  splitMemo: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  addBtnText: { fontSize: 14, fontWeight: '500' },
});

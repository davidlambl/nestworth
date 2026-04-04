import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { formatCurrency } from '@/lib/format';
import {
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useReorderAccounts,
} from '@/lib/hooks/useAccounts';
import type { AccountType, AccountWithBalance } from '@/lib/types';
import { AccountTypeLabels } from '@/lib/types';

const ACCOUNT_TYPES: AccountType[] = [
  'checking', 'savings', 'credit_card', 'cash', 'other',
];

const ACCOUNT_ICONS: Record<AccountType, React.ComponentProps<typeof FontAwesome>['name']> = {
  checking: 'university',
  savings: 'piggy-bank' as any,
  credit_card: 'credit-card',
  cash: 'money',
  other: 'folder-o',
};

export default function AccountsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { data: accounts, isLoading } = useAccounts();
  const createAccount = useCreateAccount();
  const deleteAccount = useDeleteAccount();
  const reorderAccounts = useReorderAccounts();

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('checking');
  const [newBalance, setNewBalance] = useState('');

  const activeAccounts = accounts?.filter((a) => !a.isArchived) ?? [];
  const totalBalance = activeAccounts.reduce((s, a) => s + a.currentBalance, 0);

  const handleMove = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= activeAccounts.length) {
      return;
    }
    const reordered = [...activeAccounts];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reorderAccounts.mutate(reordered);
  };

  const handleCreate = () => {
    if (!newName.trim()) {
      Alert.alert('Name required', 'Please enter an account name.');
      return;
    }
    createAccount.mutate(
      {
        name: newName.trim(),
        type: newType,
        initialBalance: parseFloat(newBalance) || 0,
      },
      {
        onSuccess: () => {
          setShowModal(false);
          setNewName('');
          setNewType('checking');
          setNewBalance('');
        },
      }
    );
  };

  const handleDelete = (acct: AccountWithBalance) => {
    const msg = `Delete "${acct.name}" and all its transactions? This cannot be undone.`;
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        deleteAccount.mutate(acct.id);
      }
    } else {
      Alert.alert('Delete Account', msg, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteAccount.mutate(acct.id),
        },
      ]);
    }
  };

  const renderAccount = ({ item, index }: { item: AccountWithBalance; index: number }) => (
    <View
      style={[styles.accountCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {editing && (
        <View style={styles.moveButtons}>
          <TouchableOpacity
            onPress={() => handleMove(index, -1)}
            disabled={index === 0}
            style={styles.moveBtn}
            accessibilityRole="button"
            accessibilityLabel="Move up"
          >
            <FontAwesome
              name="chevron-up"
              size={14}
              color={index === 0 ? colors.border : colors.tint}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleMove(index, 1)}
            disabled={index === activeAccounts.length - 1}
            style={styles.moveBtn}
            accessibilityRole="button"
            accessibilityLabel="Move down"
          >
            <FontAwesome
              name="chevron-down"
              size={14}
              color={index === activeAccounts.length - 1 ? colors.border : colors.tint}
            />
          </TouchableOpacity>
        </View>
      )}
      <TouchableOpacity
        style={styles.accountTouchable}
        onPress={() => {
          if (!editing) {
            router.push(`/account/${item.id}`);
          }
        }}
        activeOpacity={editing ? 1 : 0.7}
      >
        <View style={styles.accountLeft}>
          <View style={[styles.iconCircle, { backgroundColor: colors.tintLight }]}>
            <FontAwesome
              name={ACCOUNT_ICONS[item.type] ?? 'folder-o'}
              size={18}
              color={colors.tint}
            />
          </View>
          <View>
            <Text style={[styles.accountName, { color: colors.text }]}>{item.name}</Text>
            <Text style={[styles.accountType, { color: colors.textSecondary }]}>
              {AccountTypeLabels[item.type]}
            </Text>
          </View>
        </View>
        <Text
          style={[
            styles.accountBalance,
            { color: item.currentBalance >= 0 ? colors.income : colors.expense },
          ]}
        >
          {formatCurrency(item.currentBalance)}
        </Text>
      </TouchableOpacity>
      {editing && (
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item)}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${item.name}`}
        >
          <FontAwesome name="trash-o" size={16} color={colors.expense} />
        </TouchableOpacity>
      )}
    </View>
  );

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.totalCard, { backgroundColor: colors.tint }]}>
        <Text style={styles.totalLabel}>Net Balance</Text>
        <Text style={styles.totalAmount}>{formatCurrency(totalBalance)}</Text>
      </View>

      {activeAccounts.length > 1 && (
        <TouchableOpacity
          style={styles.editToggle}
          onPress={() => setEditing((v) => !v)}
        >
          <Text style={[styles.editToggleText, { color: colors.tint }]}>
            {editing ? 'Done' : 'Edit'}
          </Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={activeAccounts}
        keyExtractor={(item) => item.id}
        renderItem={renderAccount}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <FontAwesome name="bank" size={48} color={colors.placeholder} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No accounts yet
            </Text>
            <Text style={[styles.emptySubtext, { color: colors.placeholder }]}>
              Tap the + button to add your first account
            </Text>
          </View>
        }
      />

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.tint }]}
        onPress={() => setShowModal(true)}
      >
        <FontAwesome name="plus" size={22} color="#fff" />
      </TouchableOpacity>

      <Modal visible={showModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Account</Text>

            <TextInput
              style={[styles.input, {
                backgroundColor: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }]}
              placeholder="Account Name"
              placeholderTextColor={colors.placeholder}
              value={newName}
              onChangeText={setNewName}
            />

            <View style={styles.typeRow}>
              {ACCOUNT_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[
                    styles.typeChip,
                    {
                      backgroundColor: newType === t ? colors.tint : colors.background,
                      borderColor: newType === t ? colors.tint : colors.border,
                    },
                  ]}
                  onPress={() => setNewType(t)}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      { color: newType === t ? '#fff' : colors.text },
                    ]}
                  >
                    {AccountTypeLabels[t]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={[styles.input, {
                backgroundColor: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }]}
              placeholder="Starting Balance (0.00)"
              placeholderTextColor={colors.placeholder}
              value={newBalance}
              onChangeText={setNewBalance}
              keyboardType="decimal-pad"
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: colors.border }]}
                onPress={() => setShowModal(false)}
              >
                <Text style={[styles.modalBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.tint }]}
                onPress={handleCreate}
                disabled={createAccount.isPending}
              >
                {createAccount.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: '#fff' }]}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  totalCard: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },
  totalLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  totalAmount: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  list: { padding: 16, paddingBottom: 100 },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    overflow: 'hidden',
  },
  editToggle: {
    alignSelf: 'flex-end',
    marginRight: 20,
    marginBottom: 2,
  },
  editToggleText: {
    fontSize: 15,
    fontWeight: '600',
  },
  moveButtons: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 10,
    gap: 6,
  },
  moveBtn: {
    padding: 4,
  },
  accountTouchable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  deleteBtn: {
    paddingHorizontal: 14,
    paddingVertical: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountName: { fontSize: 16, fontWeight: '600' },
  accountType: { fontSize: 13, marginTop: 2 },
  accountBalance: { fontSize: 17, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 18, fontWeight: '600' },
  emptySubtext: { fontSize: 14 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 4px 8px rgba(0,0,0,0.2)',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: { fontSize: 22, fontWeight: '700', marginBottom: 20 },
  input: {
    height: 50,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  typeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  typeChipText: { fontSize: 13, fontWeight: '500' },
  modalButtons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  modalBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modalBtnText: { fontSize: 16, fontWeight: '600' },
});

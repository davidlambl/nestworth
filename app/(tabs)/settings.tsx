import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Switch,
  Platform,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAuth } from '@/lib/auth';
import { useBiometricLock } from '@/lib/hooks/useBiometricLock';
import { supabase } from '@/lib/supabase';

export default function SettingsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user, signOut } = useAuth();
  const biometric = useBiometricLock();

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/sign-in');
        },
      },
    ]);
  };

  const handleExport = async () => {
    try {
      const { data: txns, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user!.id)
        .order('txn_date', { ascending: true });

      if (error) {
        throw error;
      }

      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, name')
        .eq('user_id', user!.id);

      const acctMap = new Map<string, string>();
      for (const a of accounts ?? []) {
        acctMap.set(a.id, a.name);
      }

      const header = 'Date,Account,Payee,Amount,Check #,Memo,Status\n';
      const rows = (txns ?? [])
        .map(
          (t: any) =>
            `${t.txn_date},"${acctMap.get(t.account_id) ?? ''}","${t.payee}",${t.amount},"${t.check_number ?? ''}","${t.memo ?? ''}",${t.status}`
        )
        .join('\n');

      const csv = header + rows;

      Alert.alert(
        'Export Ready',
        `${txns?.length ?? 0} transactions exported as CSV. Copy the data from the console or share via your platform's sharing mechanism.`
      );

      console.log(csv);
    } catch (e: any) {
      Alert.alert('Export failed', e.message);
    }
  };

  const SettingsRow = ({
    icon,
    label,
    onPress,
    destructive,
  }: {
    icon: string;
    label: string;
    onPress: () => void;
    destructive?: boolean;
  }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.separator }]}
      onPress={onPress}
    >
      <FontAwesome
        name={icon as any}
        size={18}
        color={destructive ? colors.destructive : colors.tint}
        style={styles.rowIcon}
      />
      <Text
        style={[
          styles.rowLabel,
          { color: destructive ? colors.destructive : colors.text },
        ]}
      >
        {label}
      </Text>
      <FontAwesome name="chevron-right" size={14} color={colors.placeholder} />
    </TouchableOpacity>
  );

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <View style={styles.userInfo}>
          <View style={[styles.avatar, { backgroundColor: colors.tintLight }]}>
            <FontAwesome name="user" size={24} color={colors.tint} />
          </View>
          <Text style={[styles.email, { color: colors.text }]}>
            {user?.email ?? 'Not signed in'}
          </Text>
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <SettingsRow
          icon="repeat"
          label="Recurring Transactions"
          onPress={() => router.push('/recurring')}
        />
        <SettingsRow
          icon="upload"
          label="Import Transactions (CSV)"
          onPress={() => router.push('/import' as any)}
        />
        <SettingsRow
          icon="download"
          label="Export Transactions (CSV)"
          onPress={handleExport}
        />
      </View>

      {biometric.isAvailable && Platform.OS !== 'web' && (
        <View style={[styles.section, { backgroundColor: colors.surface }]}>
          <View style={[styles.row, { borderBottomColor: colors.separator }]}>
            <FontAwesome
              name="lock"
              size={18}
              color={colors.tint}
              style={styles.rowIcon}
            />
            <Text style={[styles.rowLabel, { color: colors.text }]}>
              Biometric Lock
            </Text>
            <Switch
              value={biometric.isEnabled}
              onValueChange={biometric.toggle}
              trackColor={{ true: colors.tint }}
            />
          </View>
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <SettingsRow
          icon="sign-out"
          label="Sign Out"
          onPress={handleSignOut}
          destructive
        />
      </View>

      <Text style={[styles.version, { color: colors.placeholder }]}>
        Checkbook v1.0.0
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 14,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  email: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: { width: 28 },
  rowLabel: { flex: 1, fontSize: 16 },
  version: {
    textAlign: 'center',
    fontSize: 13,
    marginTop: 32,
    marginBottom: 20,
  },
});

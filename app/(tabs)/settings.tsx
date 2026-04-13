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
  ActivityIndicator,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { useBiometricLock } from '@/lib/hooks/useBiometricLock';
import { getDb } from '@/lib/db';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { formatRelativeSyncedTime } from '@/lib/format';
import { useSyncStatus } from '@/lib/hooks/useSyncStatus';
import { promptSignOut } from '@/lib/promptSignOut';

export default function SettingsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { themePref, setThemePref, fontSizePref, setFontSizePref, fontScale } = useTheme();
  const { user, signOut } = useAuth();
  const biometric = useBiometricLock();
  const syncStatus = useSyncStatus();

  const handleSignOut = () => {
    if (!user?.id) {
      return;
    }
    void promptSignOut(user.id, {
      signOut,
      onNavigateToSignIn: () => router.replace('/(auth)/sign-in'),
    });
  };

  const syncStatusLine = () => {
    if (syncStatus.isSyncing) {
      return 'Syncing with cloud…';
    }
    if (syncStatus.lastError) {
      return `Sync issue: ${syncStatus.lastError}`;
    }
    if (!syncStatus.isOnline) {
      if (syncStatus.pendingCount > 0) {
        return `Offline — ${syncStatus.pendingCount} change(s) not uploaded`;
      }
      return 'Offline — changes will sync when connected';
    }
    if (syncStatus.pendingCount > 0) {
      return `${syncStatus.pendingCount} change(s) waiting to upload`;
    }
    return 'All changes synced with cloud';
  };

  const parts: string[] = [];
  if (syncStatus.pendingAccounts > 0) {
    const n = syncStatus.pendingAccounts;
    parts.push(`${n} account${n === 1 ? '' : 's'}`);
  }
  if (syncStatus.pendingTransactions > 0) {
    const n = syncStatus.pendingTransactions;
    parts.push(`${n} transaction${n === 1 ? '' : 's'}`);
  }
  if (syncStatus.pendingSplits > 0) {
    const n = syncStatus.pendingSplits;
    parts.push(`${n} split line${n === 1 ? '' : 's'}`);
  }
  if (syncStatus.pendingRules > 0) {
    const n = syncStatus.pendingRules;
    parts.push(`${n} recurring rule${n === 1 ? '' : 's'}`);
  }
  const syncBreakdownText = parts.join(', ');

  const handleExport = async () => {
    try {
      const db = await getDb();
      const txns = await db.getAllAsync<any>(
        `SELECT * FROM transactions
         WHERE user_id = ? AND _sync_status != 'deleted'
         ORDER BY txn_date`,
        [user!.id]
      );

      const accounts = await db.getAllAsync<{ id: string; name: string }>(
        "SELECT id, name FROM accounts WHERE user_id = ? AND _sync_status != 'deleted'",
        [user!.id]
      );

      const acctMap = new Map<string, string>();
      for (const a of accounts) {
        acctMap.set(a.id, a.name);
      }

      const header = 'Date,Account,Payee,Amount,Check #,Memo,Status\n';
      const rows = txns
        .map(
          (t: any) =>
            `${t.txn_date},"${acctMap.get(t.account_id) ?? ''}","${t.payee}",${t.amount},"${t.check_number ?? ''}","${t.memo ?? ''}",${t.status}`
        )
        .join('\n');

      const csv = header + rows;

      if (Platform.OS === 'web') {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const name = `transactions-${Date.now()}.csv`;
        const file = FileSystem.Paths.cache.createFile(name, 'text/csv');
        file.write(csv);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, {
            mimeType: 'text/csv',
            dialogTitle: 'Export transactions',
          });
        }
      }
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
          { color: destructive ? colors.destructive : colors.text, fontSize: 16 * fontScale },
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
          <Text style={[styles.email, { color: colors.text, fontSize: 16 * fontScale }]}>
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

      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <View style={[styles.row, { borderBottomColor: colors.separator }]}>
          <FontAwesome
            name="cloud"
            size={18}
            color={colors.tint}
            style={styles.rowIcon}
          />
          <View style={styles.syncTextCol}>
            <Text style={[styles.rowLabel, { color: colors.text, fontSize: 16 * fontScale }]}>
              Cloud sync
            </Text>
            <Text
              style={[
                styles.syncSub,
                { color: colors.textSecondary, fontSize: 13 * fontScale },
              ]}
            >
              {syncStatusLine()}
            </Text>
            {syncStatus.pendingCount > 0 && syncBreakdownText.length > 0 ? (
              <Text
                style={[
                  styles.syncSub,
                  { color: colors.placeholder, fontSize: 12 * fontScale, marginTop: 4 },
                ]}
              >
                {syncBreakdownText}
              </Text>
            ) : null}
            <Text
              style={[
                styles.syncSub,
                { color: colors.textSecondary, fontSize: 12 * fontScale, marginTop: 6 },
              ]}
            >
              Last synced: {formatRelativeSyncedTime(syncStatus.lastSyncedAt)}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.syncNowRow, { borderTopColor: colors.separator }]}
          onPress={() => void syncStatus.syncNow()}
          disabled={!syncStatus.userId || syncStatus.isSyncing || !syncStatus.isOnline}
        >
          {syncStatus.isSyncing ? (
            <View style={styles.syncNowIconWrap}>
              <ActivityIndicator size="small" color={colors.tint} />
            </View>
          ) : (
            <FontAwesome name="refresh" size={18} color={colors.tint} style={styles.rowIcon} />
          )}
          <Text style={[styles.rowLabel, { color: colors.text, fontSize: 16 * fontScale }]}>
            Sync now
          </Text>
        </TouchableOpacity>
        {!syncStatus.isOnline ? (
          <Text
            style={[
              styles.syncHint,
              { color: colors.placeholder, fontSize: 12 * fontScale },
            ]}
          >
            Connect to the internet to upload pending changes.
          </Text>
        ) : null}
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
            <Text style={[styles.rowLabel, { color: colors.text, fontSize: 16 * fontScale }]}>
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
        <View style={[styles.row, { borderBottomColor: colors.separator }]}>
          <FontAwesome
            name="adjust"
            size={18}
            color={colors.tint}
            style={styles.rowIcon}
          />
          <Text style={[styles.rowLabel, { color: colors.text, fontSize: 16 * fontScale }]}>
            Appearance
          </Text>
        </View>
        <View style={styles.chipRow}>
          {(['system', 'light', 'dark'] as const).map((t) => (
            <TouchableOpacity
              key={t}
              style={[
                styles.chip,
                {
                  backgroundColor: themePref === t ? colors.tint : colors.background,
                  borderColor: themePref === t ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setThemePref(t)}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: themePref === t ? '#fff' : colors.text, fontSize: 13 * fontScale },
                ]}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <View style={[styles.row, { borderBottomColor: colors.separator }]}>
          <FontAwesome
            name="font"
            size={18}
            color={colors.tint}
            style={styles.rowIcon}
          />
          <Text style={[styles.rowLabel, { color: colors.text, fontSize: 16 * fontScale }]}>
            Font Size
          </Text>
        </View>
        <View style={styles.chipRow}>
          {(['small', 'medium', 'large'] as const).map((f) => (
            <TouchableOpacity
              key={f}
              style={[
                styles.chip,
                {
                  backgroundColor: fontSizePref === f ? colors.tint : colors.background,
                  borderColor: fontSizePref === f ? colors.tint : colors.border,
                },
              ]}
              onPress={() => setFontSizePref(f)}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: fontSizePref === f ? '#fff' : colors.text, fontSize: 13 * fontScale },
                ]}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.surface }]}>
        <SettingsRow
          icon="sign-out"
          label="Sign Out"
          onPress={handleSignOut}
          destructive
        />
      </View>

      <Text style={[styles.version, { color: colors.placeholder, fontSize: 13 * fontScale }]}>
        Nestworth v1.0.0
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
  syncTextCol: { flex: 1, paddingVertical: 2 },
  syncSub: { marginTop: 4 },
  syncNowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  syncNowIconWrap: { width: 28, alignItems: 'center', justifyContent: 'center' },
  syncHint: { paddingHorizontal: 16, paddingBottom: 12 },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  chip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  version: {
    textAlign: 'center',
    fontSize: 13,
    marginTop: 32,
    marginBottom: 20,
  },
});

import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useColorScheme } from '@/components/useColorScheme';
import FormError from '@/components/FormError';
import Colors from '@/constants/Colors';
import { useTheme } from '@/lib/theme';
import { formatCurrency, formatDate } from '@/lib/format';
import { confirm } from '@/lib/confirm';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useSyncStatus } from '@/lib/hooks/useSyncStatus';
import {
  useDiscardRefusedRow,
  useMoveRefusedRow,
} from '@/lib/hooks/useRefusedRows';
import {
  describeRefusal,
  discardConfirmation,
  moveConfirmation,
  moveTargets,
  refusedRowActions,
  type RefusedRow,
} from '@/lib/syncRefusals';

// The rows the push can never upload as they are (#115), from Settings. A row
// whose account another device deleted is in no register once that delete
// reaches this device: this list is the only place it can be seen. Nothing
// here is a component test's to pin; verified in a browser and on a device.

const FREQUENCY: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  semimonthly: 'Twice a month',
  quarterly: 'Quarterly',
  biannually: 'Every 6 months',
  yearly: 'Yearly',
};

/** A stored date as the registers show it, or as stored when it is not one. */
function showDate(value: string | null): string {
  if (!value) return 'No date';
  const shown = formatDate(value);
  return shown === 'Invalid Date' ? value : shown;
}

function title(row: RefusedRow): string {
  const amount = row.amount == null ? '' : ` · ${formatCurrency(row.amount)}`;
  if (row.table === 'transactions') {
    return `${showDate(row.txnDate)} · ${row.payee || 'No payee'}${amount}`;
  }
  const every = FREQUENCY[row.frequency ?? ''] ?? 'Recurring';
  return `${every} · ${row.payee ?? 'Unreadable rule'}${amount}`;
}

/** Where the row is, while its account is live here: the register it shows in. */
function home(row: RefusedRow): string {
  return row.accountLive && row.accountName ? ` in ${row.accountName}` : '';
}

function detail(row: RefusedRow): string | null {
  if (row.table === 'recurring_rules') {
    return row.nextDate
      ? `Recurring rule${home(row)}, next ${showDate(row.nextDate)}`
      : `Recurring rule${home(row)}`;
  }
  if (row.transferLinkId && row.partnerAccountName) {
    return `One side of a transfer${home(row)}; the other side is in ${row.partnerAccountName}.`;
  }
  return row.accountLive && row.accountName ? `In ${row.accountName}` : null;
}

/** The row as a screen reader says it, for the labels of its buttons. */
function spoken(row: RefusedRow): string {
  const what =
    row.table === 'transactions'
      ? row.payee || 'transaction with no payee'
      : (row.payee ?? 'unreadable rule');
  const amount = row.amount == null ? '' : `, ${formatCurrency(row.amount)}`;
  const date = row.table === 'transactions' ? row.txnDate : row.nextDate;
  return `${what}${amount}, ${showDate(date)}`;
}

export default function UnsyncedScreen() {
  const colors = Colors[useColorScheme() ?? 'light'];
  const { fontScale } = useTheme();
  const syncStatus = useSyncStatus();
  const { data: accounts } = useAccounts();
  const move = useMoveRefusedRow();
  const discard = useDiscardRefusedRow();
  const [picking, setPicking] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // The signed-in user's only (useSyncStatus).
  const rows = syncStatus.refusedRows;

  // Keyed by the version the list showed: a row that leaves the list and comes
  // back (edited, then refused again) does not bring an old error with it.
  const errorKey = (row: RefusedRow) => `${row.id}@${row.updatedAt ?? ''}`;
  const setError = (row: RefusedRow, message: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (message) next[errorKey(row)] = message;
      else delete next[errorKey(row)];
      return next;
    });

  const targets = (row: RefusedRow) => moveTargets(accounts, row);

  // The iOS Alert's heading, in title case as the house's ("Delete
  // Transaction", "Delete Rule").
  const heading = (verb: string, row: RefusedRow) =>
    `${verb} ${row.table === 'transactions' ? 'Transaction' : 'Rule'}`;

  // The confirms' words are lib/syncRefusals.ts's: where the row goes or what
  // a discard deletes, and how to keep a row whose date or amount is refused.
  const onMove = async (row: RefusedRow, accountId: string, name: string) => {
    const ok = await confirm({
      title: heading('Move', row),
      message: moveConfirmation(row, name),
      confirmText: 'Move',
    });
    if (ok) {
      setError(row, null);
      move.mutate(
        { row, accountId },
        {
          onSuccess: () => setPicking(null),
          onError: (e) =>
            setError(row, e instanceof Error ? e.message : String(e)),
        }
      );
    }
  };

  const onDiscard = async (row: RefusedRow) => {
    const ok = await confirm({
      title: heading('Discard', row),
      message: discardConfirmation(row),
      confirmText: 'Discard',
      destructive: true,
    });
    if (ok) {
      setError(row, null);
      discard.mutate(row, {
        onError: (e) =>
          setError(row, e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const text = (size: number) => ({ fontSize: size * fontScale });

  const renderRow = ({ item: row }: { item: RefusedRow }) => {
    const open = picking === row.id;
    const choices = targets(row);
    const extra = detail(row);
    const can = refusedRowActions(row);
    return (
      <View
        testID={`unsynced-row-${row.id}`}
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.cardTitle, text(16), { color: colors.text }]}>
          {title(row)}
        </Text>
        {extra ? (
          <Text
            style={[styles.cardLine, text(13), { color: colors.textSecondary }]}
          >
            {extra}
          </Text>
        ) : null}
        <Text
          style={[styles.cardLine, text(13), { color: colors.textSecondary }]}
        >
          {describeRefusal(row)}
        </Text>
        <View style={styles.actions}>
          {can.move ? (
            <TouchableOpacity
              testID={`unsynced-move-${row.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Move ${spoken(row)} to another account`}
              aria-expanded={open}
              style={[styles.button, { borderColor: colors.tint }]}
              onPress={() => setPicking(open ? null : row.id)}
            >
              <Text
                style={[styles.buttonText, text(14), { color: colors.tint }]}
              >
                {open ? 'Close' : 'Move to…'}
              </Text>
            </TouchableOpacity>
          ) : null}
          {can.edit ? (
            // The register's edit screen: a row the cloud refuses for one of
            // its own fields is kept by fixing that field, not by Discard.
            <TouchableOpacity
              testID={`unsynced-edit-${row.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${spoken(row)}`}
              style={[styles.button, { borderColor: colors.tint }]}
              onPress={() =>
                router.push(
                  `/transaction/${row.id}?accountId=${row.accountId ?? ''}`
                )
              }
            >
              <Text
                style={[styles.buttonText, text(14), { color: colors.tint }]}
              >
                Edit
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            testID={`unsynced-discard-${row.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Discard ${spoken(row)}`}
            style={[styles.button, { borderColor: colors.destructive }]}
            onPress={() => onDiscard(row)}
          >
            <Text
              style={[
                styles.buttonText,
                text(14),
                { color: colors.destructive },
              ]}
            >
              Discard
            </Text>
          </TouchableOpacity>
        </View>
        {open ? (
          <View style={[styles.picker, { borderTopColor: colors.separator }]}>
            {choices.length === 0 ? (
              <Text
                style={[
                  styles.cardLine,
                  text(13),
                  { color: colors.textSecondary },
                ]}
              >
                There is no other account to move it to.
              </Text>
            ) : (
              choices.map((a) => (
                <TouchableOpacity
                  key={a.id}
                  testID={`unsynced-target-${row.id}-${a.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Move to ${a.name}`}
                  style={[
                    styles.choice,
                    { borderBottomColor: colors.separator },
                  ]}
                  onPress={() => onMove(row, a.id, a.name)}
                >
                  <Text style={[text(15), { color: colors.text }]}>
                    {a.name}
                  </Text>
                  <FontAwesome
                    name="chevron-right"
                    size={12}
                    color={colors.placeholder}
                  />
                </TouchableOpacity>
              ))
            )}
          </View>
        ) : null}
        <FormError
          message={errors[errorKey(row)] ?? null}
          testID={`unsynced-error-${row.id}`}
          style={[styles.error, text(13)]}
        />
      </View>
    );
  };

  return (
    <FlatList
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(row) => `${row.table}:${row.id}`}
      renderItem={renderRow}
      // The open picker, the errors and the accounts are not in `rows`.
      extraData={{ picking, errors, accounts }}
      ListHeaderComponent={
        <Text style={[styles.intro, text(14), { color: colors.textSecondary }]}>
          These changes are saved on this device, but the cloud can&apos;t take
          them as they are, so they will never upload on their own. Move a
          change to another account, edit it, or discard it.
        </Text>
      }
      ListEmptyComponent={
        // Not "every change can be uploaded" before this user's refusals have
        // been read (a fresh load, an account switch): nothing is known yet.
        syncStatus.refusedKnown ? (
          <Text
            testID="unsynced-empty"
            style={[styles.empty, text(15), { color: colors.textSecondary }]}
          >
            Every change on this device can be uploaded.
          </Text>
        ) : (
          <ActivityIndicator
            testID="unsynced-loading"
            style={styles.empty}
            color={colors.tint}
          />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  intro: { marginBottom: 16, lineHeight: 20 },
  empty: { textAlign: 'center', marginTop: 24 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTitle: { fontWeight: '600' },
  cardLine: { marginTop: 4 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: {
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  buttonText: { fontWeight: '500' },
  picker: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  error: { marginTop: 8 },
});

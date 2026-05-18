import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getDb } from '@/lib/db';

export async function exportTransactionsToCsv(userId: string): Promise<void> {
  const db = await getDb();
  const txns = await db.getAllAsync<any>(
    `SELECT * FROM transactions
     WHERE user_id = ? AND _sync_status != 'deleted'
     ORDER BY txn_date`,
    [userId]
  );

  const accounts = await db.getAllAsync<{ id: string; name: string }>(
    "SELECT id, name FROM accounts WHERE user_id = ? AND _sync_status != 'deleted'",
    [userId]
  );

  const acctMap = new Map<string, string>();
  for (const a of accounts) acctMap.set(a.id, a.name);

  const header = 'Date,Account,Payee,Amount,Check #,Memo,Status\n';
  const rows = txns
    .map(
      (t: any) =>
        `${t.txn_date},"${acctMap.get(t.account_id) ?? ''}","${t.payee}",${t.amount},"${t.check_number ?? ''}","${t.memo ?? ''}",${t.status}`
    )
    .join('\n');

  const csv = header + rows;

  if (Platform.OS === 'web') {
    const filename = `transactions-${Date.now()}.csv`;
    const electronAPI = (globalThis as any).electronAPI;
    if (electronAPI?.saveCsv) {
      await electronAPI.saveCsv(filename, csv);
      return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return;
  }

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

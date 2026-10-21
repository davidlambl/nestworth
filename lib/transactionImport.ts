import {
  accountRefusalMessage,
  readAccountRefusal,
  type AccountRefusal,
} from './accountWriteGuard';

// The slice of the expo-sqlite API this module needs. Deliberately
// non-generic, as transferCreate's TransferDb, so the shared test fixture's
// better-sqlite3 adapter satisfies it as-is; the real SQLiteDatabase does too.
export interface TransactionImportDb {
  runAsync: (sql: string, params: any[]) => Promise<unknown>;
  getAllAsync: (sql: string, params: any[]) => Promise<unknown[]>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}

/** One row the import screen's preview has selected (lib/csvImport.ts). */
export interface ImportRow {
  date: string;
  /**
   * The date as the file wrote it ("2026-01-15T08:10:00"), of which `date`
   * keeps the day: two rows of one day are one transaction only when they
   * wrote it the same (#36).
   */
  rawDate: string;
  payee: string;
  amount: number;
  memo?: string | null;
}

export interface TransactionImportInput {
  userId: string;
  accountId: string;
  rows: ImportRow[];
}

/** The INSERT of one imported row: cleared, and pending upload. */
export const IMPORT_INSERT_SQL = `INSERT INTO transactions
     (id, user_id, account_id, txn_date, payee, amount, memo,
      status, created_at, updated_at, _sync_status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, 'pending')`;

/**
 * Writes the CSV import's selected rows into one account, all or none (#163).
 *
 * The screen used to run this loop itself, one plain INSERT per row, without
 * looking at the account. An account deleted while the import screen was
 * open -- on another device, its tombstone pulled here; the screen keeps the
 * account it was given in its own state -- still received every row,
 * 'pending', and the server refuses a NEW child of a tombstoned account
 * (23503, 005's inherit_account_tombstone), so each row stayed pending on
 * this device forever, counted by the reset guard. Now the account read is
 * the first statement of one transaction: a dead account refuses, and
 * nothing is imported. The task RETURNS on a refusal and the refusal is
 * thrown once the transaction is over (#127, #154), so a plain statement
 * that joined it is not rolled back. One transaction also makes the batch
 * all or none: an interruption used to leave the rows before it imported
 * and the rest not (a second import of the same file then skipped the
 * first part as duplicates).
 *
 * Dedup: a row matching a non-deleted transaction of the account on (date,
 * payee, amount) is skipped, each stored transaction covering one row, and
 * so is a repeat within the batch, a row with the same date as the file
 * wrote it, payee and amount -- each INSERT gets a fresh id, so no id
 * collision would catch it. The import keeps only a date's day (#36): a
 * payment app's two subway fares of one day, at 08:10 and 18:40, share a
 * date, and their times keep them two rows; a later export that adds the
 * evening fare to a morning one already stored imports the evening one
 * alone. Matched on the day alone, the second fare was "a duplicate". The
 * read is now inside the transaction, with the INSERTs it guards. A blank
 * payee is written as '(imported)'.
 *
 * What the account read cannot stop is a plain statement landing between it
 * and the INSERTs (a tombstone pulled from another device): those rows meet
 * the server's refusal, as any write into an account deleted elsewhere and
 * not yet pulled, which Settings lists since #115.
 */
export async function applyTransactionImport(
  db: TransactionImportDb,
  input: TransactionImportInput,
  opts: { now: string; newId: () => string }
): Promise<{ imported: number; skipped: number }> {
  const { now, newId } = opts;
  let refused: AccountRefusal | null = null;
  let imported = 0;
  let skipped = 0;

  await db.withTransactionAsync(async () => {
    [refused] = await readAccountRefusal(db, input.userId, [input.accountId]);
    if (refused) {
      return;
    }
    const existing = (await db.getAllAsync(
      `SELECT txn_date, payee, amount FROM transactions
       WHERE account_id = ? AND _sync_status != 'deleted'`,
      [input.accountId]
    )) as { txn_date: string; payee: string; amount: number }[];
    // How many stored rows each (date, payee, amount) has left to cover.
    const stored = new Map<string, number>();
    for (const e of existing) {
      const key = `${e.txn_date}|${e.payee}|${e.amount}`;
      stored.set(key, (stored.get(key) ?? 0) + 1);
    }
    // The rows of the batch already read, by the date as the file wrote it.
    const read = new Set<string>();
    for (const r of input.rows) {
      const payee = r.payee || '(imported)';
      const written = `${r.rawDate}|${payee}|${r.amount}`;
      if (read.has(written)) {
        skipped++;
        continue;
      }
      read.add(written);
      const key = `${r.date}|${payee}|${r.amount}`;
      const left = stored.get(key) ?? 0;
      if (left > 0) {
        stored.set(key, left - 1);
        skipped++;
        continue;
      }
      await db.runAsync(IMPORT_INSERT_SQL, [
        newId(),
        input.userId,
        input.accountId,
        r.date,
        payee,
        r.amount,
        r.memo || null,
        now,
        now,
      ]);
      imported++;
    }
  });

  // Assigned inside the task, where TypeScript does not look: without the
  // cast it takes `refused` for null here.
  const refusal = refused as AccountRefusal | null;
  if (refusal) {
    throw new Error(
      accountRefusalMessage(refusal, 'This account', 'nothing was imported')
    );
  }
  return { imported, skipped };
}

// The slice of the expo-sqlite API this module needs, as transactionUpdate's
// TxnDb has it: runAsync resolves the statement's `changes` (expo-sqlite's
// SQLiteRunResult, better-sqlite3's RunResult), which says whether the rule is
// still here. The shared test fixture's adapter satisfies it as-is; the real
// SQLiteDatabase does too.
export interface RecurringRuleDeleteDb {
  runAsync: (sql: string, params: any[]) => Promise<{ changes: number }>;
}

/**
 * Marks a recurring rule deleted; the push then tombstones it on the server
 * and removes it here. No status filter: a second delete of a rule already
 * marked, before its push, matches it again and succeeds, as it always has.
 * usePostRecurringTransaction runs the same statement for an expired rule,
 * inside its own transaction and without the check below: a throw there
 * would roll back the posted transaction, and a zero match there is benign
 * (the rule comes back due, and the post's duplicate guard makes the next
 * post an advance only).
 */
export const RULE_DELETE_SQL =
  "UPDATE recurring_rules SET _sync_status = 'deleted', updated_at = ? WHERE id = ?";

/**
 * Deletes a recurring rule, or fails readably when this device no longer has
 * it (#138).
 *
 * The rule can be gone by the time the UPDATE runs: a pulled tombstone removed
 * it, so it was already deleted on the server, or the reset's wipe did, and
 * the re-download will bring it back live for the user to delete again. The
 * statement cannot tell the two apart, and the message covers both. It used to
 * report success either way, and the delete was silently lost after a reset.
 *
 * db.runAsync is called before anything is awaited, so the UPDATE is issued
 * within this call even when the caller does not await it:
 * syncWipeSurvivors.test.ts's last test relies on that to land the delete in
 * the wipe's transaction, right after the rules DELETE. Keep it so.
 */
export async function applyRecurringRuleDelete(
  db: RecurringRuleDeleteDb,
  id: string,
  opts: { now: string }
): Promise<void> {
  const { changes } = await db.runAsync(RULE_DELETE_SQL, [opts.now, id]);
  if (changes === 0) {
    throw new Error(
      'This recurring rule no longer exists on this device. It may have been deleted elsewhere or by a reset.'
    );
  }
}

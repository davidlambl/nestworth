import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapRecurringRule } from '../mappers';
import {
  applyRecurringRuleDelete,
  RULE_DELETE_SQL,
  RULE_GONE_MESSAGE,
} from '../recurringRuleDelete';
import type {
  RecurringRule,
  RecurringFrequency,
  DbRecurringRule,
} from '../types';

const RULES_KEY = ['recurring_rules'];

export function useRecurringRules() {
  const { user } = useAuth();

  return useQuery({
    queryKey: RULES_KEY,
    queryFn: async (): Promise<RecurringRule[]> => {
      const db = await getDb();
      const rows = await db.getAllAsync<DbRecurringRule>(
        `SELECT * FROM recurring_rules
         WHERE user_id = ? AND _sync_status != 'deleted'
         ORDER BY next_date`,
        [user!.id]
      );
      return rows.map(mapRecurringRule);
    },
    enabled: !!user,
  });
}

interface CreateRuleInput {
  accountId: string;
  frequency: RecurringFrequency;
  nextDate: string;
  endDate?: string | null;
  template: RecurringRule['template'];
}

export function useCreateRecurringRule() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateRuleInput) => {
      const db = await getDb();
      const id = Crypto.randomUUID();
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT INTO recurring_rules
           (id, user_id, account_id, frequency, next_date, end_date, template,
            created_at, updated_at, _sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          id,
          user!.id,
          input.accountId,
          input.frequency,
          input.nextDate,
          input.endDate ?? null,
          JSON.stringify(input.template),
          now,
          now,
        ]
      );

      const row = await db.getFirstAsync<DbRecurringRule>(
        'SELECT * FROM recurring_rules WHERE id = ?',
        [id]
      );
      requestPush(user!.id);
      return mapRecurringRule(row!);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
    },
  });
}

export function useDeleteRecurringRule() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    // One scope for the rule delete and the post (#154): TanStack runs
    // mutations of one scope one at a time, in the order they were made, so
    // a Delete and a Post of a rule made offline resume as they were tapped.
    scope: { id: 'recurring-rules' },
    mutationFn: async (id: string) => {
      const db = await getDb();
      // Throws, with nothing written and no push requested, when the rule is
      // no longer on this device (#138); the mutation cache shows the message.
      await applyRecurringRuleDelete(db, id, { now: new Date().toISOString() });
      requestPush(user!.id);
    },
    // Settled, not only succeeded: a refused delete must refetch the list too,
    // or the rule's card stays on screen (requestPush refetches nothing).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
    },
  });
}

function advanceDate(date: string, frequency: RecurringFrequency): string {
  const d = new Date(date + 'T00:00:00');
  switch (frequency) {
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'semimonthly':
      if (d.getDate() <= 15) {
        d.setDate(d.getDate() + 15);
      } else {
        d.setMonth(d.getMonth() + 1);
        d.setDate(1);
      }
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3);
      break;
    case 'biannually':
      d.setMonth(d.getMonth() + 6);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.toISOString().split('T')[0];
}

export function usePostRecurringTransaction() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    // The rule delete's scope (see useDeleteRecurringRule).
    scope: { id: 'recurring-rules' },
    mutationFn: async (rule: RecurringRule) => {
      const db = await getDb();

      const acct = await db.getFirstAsync<{ is_archived: number }>(
        `SELECT is_archived FROM accounts WHERE id = ? AND _sync_status != 'deleted'`,
        [rule.accountId]
      );
      if (!acct || acct.is_archived) {
        throw new Error('Cannot post into an archived account');
      }

      const txnId = Crypto.randomUUID();
      const now = new Date().toISOString();
      const newNextDate = advanceDate(rule.nextDate, rule.frequency);
      const isExpired = rule.endDate && newNextDate > rule.endDate;
      let existingId: string | null = null;
      let advanced = false;
      let deletedHere = false;

      // One transaction: the duplicate read, the rule's advance, then the
      // insert, so an interruption can't leave the txn posted with the rule
      // un-advanced, and nothing is inserted unless the advance matched.
      await db.withTransactionAsync(async () => {
        // Idempotency guard: if a non-deleted transaction already exists for
        // this exact occurrence (account + date + payee + amount), don't post
        // a second one. This is what prevents duplicates after a data-recovery
        // / full re-pull makes an already-posted rule look "due" again. Read
        // inside the transaction (#154): a second post of the same occurrence
        // (a double tap, or two offline taps resumed together on reconnect)
        // waits for the first one's COMMIT and finds its row, where a read
        // before the transaction let both insert. The shared scope above
        // already runs two posts one at a time; this read holds without it.
        const existing = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM transactions
           WHERE account_id = ? AND txn_date = ? AND payee = ? AND amount = ?
             AND _sync_status != 'deleted'
           LIMIT 1`,
          [
            rule.accountId,
            rule.nextDate,
            rule.template.payee,
            rule.template.amount,
          ]
        );
        existingId = existing?.id ?? null;

        // The rule's own write goes first, and skips a rule this device has
        // marked deleted (#154). The post takes its rule from the Recurring
        // list, not from disk, and the list still shows a rule its Delete has
        // just marked: online until the delete's refetch, and offline, where a
        // Delete and a Post both wait for the network and resume on reconnect,
        // in the order they were tapped (the shared scope; without it the
        // delete's single statement landed first either way). An account
        // delete marks the account's rules too (applyAccountDelete, one
        // transaction), so a post whose account check above passed before that
        // delete committed meets its rule deleted here. Unguarded, this UPDATE
        // set the rule back to 'pending', advanced, and the insert below
        // posted from it: the push uploaded the rule live and the transaction
        // with it, the delete lost on every device; after an account delete
        // the transaction went into the deleted account, where the server
        // refuses a new child (23503, 005's inherit_account_tombstone) and it
        // stayed pending here forever.
        // `IS NOT`, not `!=`: a NULL status (no writer makes one) is not a
        // delete. It runs for the last occurrence too, and the expiry below
        // then marks the rule deleted; the push sends a deleted row's
        // tombstone alone, so the transient next_date never leaves the device.
        const res = await db.runAsync(
          "UPDATE recurring_rules SET next_date = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ? AND _sync_status IS NOT 'deleted'",
          [newNextDate, now, rule.id]
        );
        advanced = res.changes > 0;
        if (!advanced) {
          // No row: this device deleted the rule, or no longer has it (a
          // pulled tombstone, or the reset's wipe). Return, and throw below
          // once the transaction is over, as applyTransactionUpdate refuses
          // (#127, #139): the transaction commits with nothing of this post's
          // in it, where a throw here would roll back whatever plain write
          // joined it (a pull's tombstone DELETE, another hook's write). The
          // status read only picks the words; it goes here because the push
          // hard-deletes a 'deleted' rule once its tombstone is uploaded, and
          // read after the COMMIT the words would say the rule is gone. Here
          // narrows that, no more: the push's DELETE is a plain statement and
          // can land between the two.
          const here = await db.getFirstAsync<{ _sync_status: string | null }>(
            'SELECT _sync_status FROM recurring_rules WHERE id = ?',
            [rule.id]
          );
          deletedHere = here?._sync_status === 'deleted';
          return;
        }

        if (isExpired) {
          // The statement alone, not applyRecurringRuleDelete: the advance
          // above has just matched the rule, so that function's check has
          // nothing to catch here, and its throw would roll back whatever
          // joined this transaction (see RULE_DELETE_SQL).
          await db.runAsync(RULE_DELETE_SQL, [now, rule.id]);
        }

        if (existingId === null) {
          await db.runAsync(
            `INSERT INTO transactions
               (id, user_id, account_id, txn_date, payee, amount, check_number, memo,
                status, created_at, updated_at, _sync_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'pending')`,
            [
              txnId,
              user!.id,
              rule.accountId,
              rule.nextDate,
              rule.template.payee,
              rule.template.amount,
              rule.template.checkNumber ?? null,
              rule.template.memo ?? null,
              now,
              now,
            ]
          );

          if (rule.template.splits.length > 0) {
            for (const s of rule.template.splits) {
              await db.runAsync(
                `INSERT INTO transaction_splits
                   (id, transaction_id, amount, memo, updated_at, _sync_status)
                 VALUES (?, ?, ?, ?, ?, 'pending')`,
                [Crypto.randomUUID(), txnId, s.amount, s.memo, now]
              );
            }
          }
        }
      });

      // Assigned inside the task, where TypeScript does not look: without the
      // cast it takes existingId for null here.
      const postedId = existingId as string | null;
      if (!advanced) {
        if (postedId !== null) {
          // This occurrence is already posted here and the rule is no longer
          // live here: nothing to insert, nothing to advance, nothing to push.
          // For example a second tap on the last occurrence, whose first
          // post's expiry marked the rule deleted (#154); or a stale card of a
          // rule a pulled tombstone removed, or one deleted after its
          // occurrence was posted. It resolves as the post before it did, not
          // with the words for a rule the user deleted.
          return { id: postedId, skipped: true };
        }
        if (deletedHere) {
          throw new Error(
            'This recurring rule was deleted on this device, so nothing was posted.'
          );
        }
        throw new Error(RULE_GONE_MESSAGE);
      }

      requestPush(user!.id);
      return { id: postedId ?? txnId, skipped: postedId !== null };
    },
    // Settled, not only succeeded: a refused post came from a list that still
    // shows the rule, so it refetches too (#154).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

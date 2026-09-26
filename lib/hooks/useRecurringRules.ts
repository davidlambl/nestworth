import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { useAuth } from '../auth';
import { mapRecurringRule } from '../mappers';
import {
  applyRecurringRuleDelete,
  RULE_DELETE_SQL,
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

      // Idempotency guard: if a non-deleted transaction already exists for
      // this exact occurrence (account + date + payee + amount), don't post
      // a second one — just advance the rule. This is what prevents
      // duplicates after a data-recovery / full re-pull makes an
      // already-posted rule look "due" again, and it also makes the
      // insert-then-advance sequence below safe to retry: if a prior post
      // inserted the txn but crashed before advancing next_date, the retry
      // finds the existing row and only advances.
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

      const newNextDate = advanceDate(rule.nextDate, rule.frequency);
      const isExpired = rule.endDate && newNextDate > rule.endDate;

      // Insert (when needed) and advance the rule in one transaction so an
      // interruption can't leave the txn posted with the rule un-advanced.
      await db.withTransactionAsync(async () => {
        if (!existing) {
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

        if (isExpired) {
          // The statement alone, not applyRecurringRuleDelete: its throw would
          // roll back the posted transaction, and a rule already gone here
          // needs nothing from the post (see RULE_DELETE_SQL).
          await db.runAsync(RULE_DELETE_SQL, [now, rule.id]);
        } else {
          await db.runAsync(
            "UPDATE recurring_rules SET next_date = ?, updated_at = ?, _sync_status = 'pending' WHERE id = ?",
            [newNextDate, now, rule.id]
          );
        }
      });

      requestPush(user!.id);
      return { id: existing?.id ?? txnId, skipped: !!existing };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

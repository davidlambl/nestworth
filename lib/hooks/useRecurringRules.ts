import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { mapRecurringRule } from '../mappers';
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
      const { data, error } = await supabase
        .from('recurring_rules')
        .select('*')
        .eq('user_id', user!.id)
        .order('next_date', { ascending: true });

      if (error) {
        throw error;
      }

      return (data as DbRecurringRule[]).map(mapRecurringRule);
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
      const { data, error } = await supabase
        .from('recurring_rules')
        .insert({
          user_id: user!.id,
          account_id: input.accountId,
          frequency: input.frequency,
          next_date: input.nextDate,
          end_date: input.endDate ?? null,
          template: input.template,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return mapRecurringRule(data as DbRecurringRule);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
    },
  });
}

export function useDeleteRecurringRule() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('recurring_rules')
        .delete()
        .eq('id', id);
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
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
      const { data: txn, error: txnErr } = await supabase
        .from('transactions')
        .insert({
          user_id: user!.id,
          account_id: rule.accountId,
          txn_date: rule.nextDate,
          payee: rule.template.payee,
          amount: rule.template.amount,
          check_number: rule.template.checkNumber ?? null,
          memo: rule.template.memo ?? null,
          status: 'pending',
        })
        .select()
        .single();

      if (txnErr) {
        throw txnErr;
      }

      if (rule.template.splits.length > 0) {
        await supabase.from('transaction_splits').insert(
          rule.template.splits.map((s) => ({
            transaction_id: txn.id,
            amount: s.amount,
            memo: s.memo,
          }))
        );
      }

      const newNextDate = advanceDate(rule.nextDate, rule.frequency);
      const isExpired =
        rule.endDate && newNextDate > rule.endDate;

      if (isExpired) {
        await supabase
          .from('recurring_rules')
          .delete()
          .eq('id', rule.id);
      } else {
        await supabase
          .from('recurring_rules')
          .update({ next_date: newNextDate })
          .eq('id', rule.id);
      }

      return txn;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RULES_KEY });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

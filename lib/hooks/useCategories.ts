import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { mapCategory } from '../mappers';
import type { Category, CategoryType, DbCategory } from '../types';

const CATEGORIES_KEY = ['categories'];

export function useCategories() {
  const { user } = useAuth();

  return useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('user_id', user!.id)
        .order('name', { ascending: true });

      if (error) {
        throw error;
      }

      return (data as DbCategory[]).map(mapCategory);
    },
    enabled: !!user,
  });
}

interface CreateCategoryInput {
  name: string;
  type: CategoryType;
  parentId?: string | null;
}

export function useCreateCategory() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCategoryInput) => {
      const { data, error } = await supabase
        .from('categories')
        .insert({
          user_id: user!.id,
          name: input.name,
          type: input.type,
          parent_id: input.parentId ?? null,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return mapCategory(data as DbCategory);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; name?: string; type?: CategoryType }) => {
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.type !== undefined) {
        updates.type = input.type;
      }

      const { data, error } = await supabase
        .from('categories')
        .update(updates)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return mapCategory(data as DbCategory);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('categories').delete().eq('id', id);
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

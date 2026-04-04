import { supabase } from './supabase';

const PAGE_SIZE = 1000;

export async function fetchAll<T>(
  table: string,
  query: (builder: ReturnType<typeof supabase.from>) => any
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;

  while (true) {
    const builder = query(supabase.from(table));
    const { data, error } = await builder.range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    results.push(...(data as T[]));

    if (!data || data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  return results;
}

const IN_BATCH_SIZE = 200;

export async function fetchWithBatchedIn<T>(
  table: string,
  column: string,
  ids: string[],
  selectCols = '*'
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }

  const results: T[] = [];

  for (let i = 0; i < ids.length; i += IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + IN_BATCH_SIZE);
    const { data, error } = await supabase
      .from(table)
      .select(selectCols)
      .in(column, batch)
      .limit(PAGE_SIZE);

    if (error) {
      throw error;
    }

    results.push(...(data as T[]));
  }

  return results;
}

import type { AccountWithBalance } from './types';

/**
 * Swap the item with the given `id` one position in `direction` (-1 = up,
 * +1 = down). Returns a new array or `null` when the id is absent or the
 * move is out of bounds. Never mutates the input.
 */
export function moveAccount<T extends { id: string }>(
  ordered: readonly T[],
  id: string,
  direction: -1 | 1
): T[] | null {
  const idx = ordered.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const target = idx + direction;
  if (target < 0 || target >= ordered.length) return null;
  const next = ordered.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}

/**
 * Split active / archived, move within active, recombine. Returns the full
 * cache array (archived preserved at the tail) for an optimistic cache write,
 * or `null` when the move is a no-op.
 */
export function applyMove(
  all: AccountWithBalance[],
  id: string,
  direction: -1 | 1
): { next: AccountWithBalance[] } | null {
  const active = all.filter((a) => !a.isArchived);
  const archived = all.filter((a) => a.isArchived);
  const moved = moveAccount(active, id, direction);
  if (!moved) return null;
  return {
    next: [...moved, ...archived],
  };
}

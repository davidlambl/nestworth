import { moveAccount, applyMove } from '../accountOrder';
import type { AccountWithBalance } from '../types';

// Minimal stubs — only `id` and `isArchived` matter for the logic under test.
function acct(
  id: string,
  overrides: Partial<AccountWithBalance> = {}
): AccountWithBalance {
  return {
    id,
    userId: 'u',
    name: id,
    type: 'checking',
    icon: null,
    initialBalance: 0,
    excludeFromTotal: false,
    sortOrder: 0,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentBalance: 0,
    ...overrides,
  };
}

describe('moveAccount', () => {
  const ordered = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

  it('swaps an item down', () => {
    expect(moveAccount(ordered, 'A', 1)).toEqual([
      { id: 'B' },
      { id: 'A' },
      { id: 'C' },
    ]);
  });

  it('swaps an item up', () => {
    expect(moveAccount(ordered, 'C', -1)).toEqual([
      { id: 'A' },
      { id: 'C' },
      { id: 'B' },
    ]);
  });

  it('returns null when the move is out of bounds (top)', () => {
    expect(moveAccount(ordered, 'A', -1)).toBeNull();
  });

  it('returns null when the move is out of bounds (bottom)', () => {
    expect(moveAccount(ordered, 'C', 1)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(moveAccount(ordered, 'X', 1)).toBeNull();
  });

  it('does not mutate the input array', () => {
    const copy = [...ordered];
    moveAccount(ordered, 'A', 1);
    expect(ordered).toEqual(copy);
  });
});

describe('applyMove', () => {
  const A = acct('A');
  const B = acct('B');
  const C = acct('C');
  const Z = acct('Z', { isArchived: true });

  it('preserves archived rows at the tail', () => {
    const result = applyMove([A, C, B, Z], 'C', -1);
    expect(result).not.toBeNull();
    expect(result!.next.map((a) => a.id)).toEqual(['C', 'A', 'B', 'Z']);
    expect(result!.activeIds).toEqual(['C', 'A', 'B']);
  });

  it('two successive calls compose to [C, B, A]', () => {
    const all = [A, C, B, Z];
    const r1 = applyMove(all, 'A', 1);
    expect(r1).not.toBeNull();
    const r2 = applyMove(r1!.next, 'A', 1);
    expect(r2).not.toBeNull();
    expect(r2!.next.map((a) => a.id)).toEqual(['C', 'B', 'A', 'Z']);
    expect(r2!.activeIds).toEqual(['C', 'B', 'A']);
  });

  it('returns null when the move is out of bounds', () => {
    expect(applyMove([A, B, C, Z], 'C', 1)).toBeNull();
  });
});

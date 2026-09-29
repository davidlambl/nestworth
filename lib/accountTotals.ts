import type { Account, AccountWithBalance } from './types';

/**
 * Whether an account's balance is left out of the net balance: the All
 * Accounts total on the Accounts tab and in the desktop sidebar. An archived
 * account always is, whatever its own "Include in Net Balance" switch says; an
 * active one is when that switch is off. The totals and the Accounts tab's
 * "Excluded" label and dimmed balance all read this one predicate, so they
 * cannot disagree again (#146: the label read the switch alone and missed
 * every archived account the totals already skipped).
 */
export function isExcludedFromTotals(
  account: Pick<Account, 'isArchived' | 'excludeFromTotal'>
): boolean {
  return account.isArchived || account.excludeFromTotal;
}

/**
 * The net balance: the sum of every account's balance except the ones
 * `isExcludedFromTotals` leaves out. Before the accounts load it is 0.
 */
export function netBalance(
  accounts:
    | readonly Pick<
        AccountWithBalance,
        'isArchived' | 'excludeFromTotal' | 'currentBalance'
      >[]
    | undefined
): number {
  return (accounts ?? [])
    .filter((a) => !isExcludedFromTotals(a))
    .reduce((sum, a) => sum + a.currentBalance, 0);
}

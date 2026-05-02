import { expect, type Page } from '@playwright/test';

// Shared helpers for specs that interact with the test user's account list.
// The test user accumulates data across runs; both specs need to wait for
// the cross-device sync pull to land before assuming the rendered list is
// authoritative.

/**
 * Wait until the AccountsScreen reflects post-pull state.
 *
 * Sequence on a Playwright session:
 *   1. user resolves from localStorage tokens
 *   2. useAccounts fires against an empty IndexedDB-backed SQLite → []
 *   3. UI flashes "No accounts yet"
 *   4. initialPull fetches from Supabase and writes to local SQLite
 *   5. invalidateQueries → useAccounts refetches → cards render
 *
 * If we exit the wait at step 3 we'll race the pull. We need a signal that
 * both the network pull and the cache refetch have completed. networkidle
 * (no in-flight requests for 500ms) covers the supabase fetch; then we
 * still need either a card or the empty state to confirm useAccounts
 * resolved with the post-pull data.
 */
export async function waitForSyncIdle(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
  const firstCard = page.locator('[data-testid^="account-card-"]').first();
  const emptyText = page.getByText('No accounts yet');
  await expect(firstCard.or(emptyText)).toBeVisible({ timeout });
}

/**
 * Best-effort delete of every account whose name starts with one of `prefixes`.
 * Loops because the FlatList re-renders after each delete and the next batch
 * scrolls into view.
 *
 * `maxPasses` is a hard safety cap to avoid infinite loops, NOT a target —
 * the loop already exits as soon as the matching count reaches zero. Set it
 * comfortably above the worst-case debris count for the shared test user.
 * If we ever blow past the cap, throw rather than silently leaving debris;
 * silent partial cleanup was previously masking real test setup failures
 * (createAccount timeouts caused by 50+ leftover rows pushing the new card
 * off-screen).
 */
export async function deleteAccountsWithPrefix(
  page: Page,
  prefixes: string[],
  maxPasses = 500
): Promise<number> {
  // Auto-accept window.confirm() for the delete dialog. Safe to register
  // multiple times across calls — handlers stack.
  page.on('dialog', (d) => d.accept().catch(() => {}));

  const editToggle = page.getByTestId('accounts-edit-toggle');
  if (!(await editToggle.isVisible().catch(() => false))) return 0;
  if ((await editToggle.innerText()).trim() === 'Edit') {
    await editToggle.click();
  }

  // Build a single locator that matches every test-prefix delete button.
  // Using `name`-property text matching across all prefixes via regex.
  const escapedPrefixes = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const prefixDeleteRegex = new RegExp(`^Delete (${escapedPrefixes.join('|')})`);
  const matchingDeletes = page.getByRole('button', { name: prefixDeleteRegex });

  let deleted = 0;
  let pass = 0;
  let stalled = false;
  try {
    for (; pass < maxPasses; pass++) {
      const before = await matchingDeletes.count();
      if (before === 0) break;

      // Always click the first match and wait for the *count* to drop.
      // Name-based wait is unsafe — prior parallel runs left duplicate names.
      // `force: true` skips actionability checks (RN Web's TouchableOpacity
      // sometimes confuses Playwright's hit-test, especially in long lists).
      const target = matchingDeletes.first();
      await target.scrollIntoViewIfNeeded();
      await target.click({ force: true });
      await expect.poll(() => matchingDeletes.count(), { timeout: 15_000 }).toBeLessThan(before);
      deleted++;
    }

    stalled = pass === maxPasses && (await matchingDeletes.count()) > 0;
  } finally {
    // Always try to exit edit mode, even on the throw path. Otherwise the
    // next test inherits a list stuck in `Done` state with debris still
    // present, which is exactly the state the helper is meant to clear.
    if (await editToggle.isVisible().catch(() => false)) {
      if ((await editToggle.innerText().catch(() => 'Edit')).trim() === 'Done') {
        await editToggle.click().catch(() => {});
      }
    }
  }

  if (stalled) {
    throw new Error(
      `deleteAccountsWithPrefix hit maxPasses=${maxPasses} with debris remaining. ` +
        `Run cleanup-test-accounts.spec.ts with CLEANUP_TEST_ACCOUNTS=1 or raise the cap.`
    );
  }

  return deleted;
}

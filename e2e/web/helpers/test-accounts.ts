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
 *   4. initialPull/fullSync fetches from Supabase and writes to local SQLite
 *   5. invalidateQueries → useAccounts refetches → cards render
 *
 * `networkidle` only confirms the supabase.select calls have returned. The
 * pull then iterates rows in a JS for-loop, awaiting `db.runAsync` for each
 * `upsertRemoteAccount`. Those local SQLite writes don't touch the network.
 * If we proceed at networkidle, the pull is still running in the background
 * and its writes interleave with subsequent test mutations: a chevron tap's
 * mutationFn writes (status='pending'), the deferred push marks rows
 * 'synced', and the still-running pull then overwrites the just-pushed
 * sort_order with the supabase data captured at the start of the pull
 * (often stale by then). Wait for the sync indicator to flip from
 * "Syncing…" to "Synced" — that fires after fullSync's
 * `await pullChanges` resolves, which happens after the iteration finishes.
 */
export async function waitForSyncIdle(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
  const firstCard = page.locator('[data-testid^="account-card-"]').first();
  const emptyText = page.getByText('No accounts yet');
  await expect(firstCard.or(emptyText)).toBeVisible({ timeout });
  // Sync label settles to one of: "Synced", "Sync error", "Offline",
  // "{N} pending". Anything but "Syncing…" means fullSync (and its pull
  // iteration) has resolved.
  await expect(page.getByText('Syncing…').first()).toBeHidden({ timeout });
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
  // Auto-accept the window.confirm() dialog that handleDelete shows on web.
  // Stash the handler so we can deregister in finally — multiple stacked
  // handlers from prior helper calls compete to accept the same dialog,
  // and the second accept() throws "Dialog has already been handled".
  const dialogHandler = (d: { accept: () => Promise<void> }) => {
    d.accept().catch(() => {});
  };
  page.on('dialog', dialogHandler);

  const editToggle = page.getByTestId('accounts-edit-toggle');
  if (!(await editToggle.isVisible().catch(() => false))) {
    page.off('dialog', dialogHandler);
    return 0;
  }
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

      // Standard click() — same pattern that works in transactions.spec.ts,
      // recurring.spec.ts, etc. Playwright handles actionability + scroll.
      // Earlier versions used `force: true` which appeared to land on the
      // wrong element in long lists, exiting edit mode silently.
      await matchingDeletes.first().click();
      // Cache refetch + FlatList rerender after a delete in a long list
      // can take several seconds; 30s is conservative.
      await expect.poll(() => matchingDeletes.count(), { timeout: 30_000 }).toBeLessThan(before);
      deleted++;
    }

    stalled = pass === maxPasses && (await matchingDeletes.count()) > 0;
  } finally {
    page.off('dialog', dialogHandler);
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

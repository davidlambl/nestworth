import { test, expect, Page } from '@playwright/test';
import { deleteAccountsWithPrefix, waitForSyncIdle } from './helpers/test-accounts';

const STAMP = Date.now();
const A = `Reorder Acct ${STAMP} A`;
const B = `Reorder Acct ${STAMP} B`;
const C = `Reorder Acct ${STAMP} C`;

async function createAccount(page: Page, name: string) {
  await page.getByTestId('accounts-add-btn').click();
  await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByTestId('accounts-new-name').fill(name);
  await page.getByTestId('accounts-create-btn').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 10000 });
}

async function orderOf(page: Page, names: string[]): Promise<string[]> {
  // Read account names in the order the FlatList renders them, restricted
  // to the three accounts this spec created. Validity precondition: callers
  // must purge any other "Reorder Acct " accounts first, otherwise debris
  // can sit between A/B/C and a chevron tap that swaps mine with debris
  // leaves the relative order of mine unchanged — a false negative.
  const cards = page.locator('[data-testid^="account-card-"]');
  const count = await cards.count();
  const present: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await cards.nth(i).innerText()).trim();
    const match = names.find((n) => text.includes(n));
    if (match && !present.includes(match)) present.push(match);
  }
  return present;
}

async function deleteIfPresent(page: Page, names: string[]) {
  // Best-effort cleanup that survives mid-test failures. Auto-accept the
  // window.confirm() that web uses for delete confirmation.
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const editToggle = page.getByTestId('accounts-edit-toggle');
  if (await editToggle.isVisible().catch(() => false)) {
    // Toggle text flips between "Edit" and "Done" — only enter edit mode
    // if we're not already in it.
    if ((await editToggle.innerText()).trim() === 'Edit') {
      await editToggle.click();
    }
  }
  for (const name of names) {
    const btn = page.getByRole('button', { name: `Delete ${name}` });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(page.getByText(name)).not.toBeVisible({ timeout: 10000 });
    }
  }
}

// Force serial execution. The whole spec mutates a single shared Supabase
// user; running repeats in parallel (Playwright's local default) causes the
// "purge prior debris" step in one instance to delete accounts that another
// instance is mid-test on, plus interleaves account creation timestamps so
// the FlatList is no longer contiguous for any one instance's A/B/C.
test.describe.configure({ mode: 'serial' });

test.describe('Accounts reorder + edit', () => {
  test('reorder via chevrons, rapid-fire reorder, and rename in edit mode', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });
    // Wait for the cross-device sync pull to land before we read or mutate
    // the account list — otherwise our "purge prior debris" step runs
    // against the local-cache-only snapshot and misses Supabase-side debris.
    await waitForSyncIdle(page);

    // Purge any leftover "Reorder Acct " accounts from prior failed runs.
    // The order assertions below assume our A/B/C are contiguous in the
    // FlatList — debris cards interleaved with ours would break that.
    await deleteAccountsWithPrefix(page, ['Reorder Acct ']);

    try {
      // Set up: three accounts created in order A, B, C → sort_order 0, 1, 2
      await createAccount(page, A);
      await createAccount(page, B);
      await createAccount(page, C);

      expect(await orderOf(page, [A, B, C])).toEqual([A, B, C]);

      // Enter edit mode
      await page.getByTestId('accounts-edit-toggle').click();

      // --- Single-step reorder ---
      // Move C up once → expected order [A, C, B]. Single mutation, no race.
      await page.getByTestId(`accounts-move-up-${C}`).click();
      await expect
        .poll(async () => orderOf(page, [A, B, C]), { timeout: 10_000 })
        .toEqual([A, C, B]);

      // --- Rapid-fire reorder (the iOS bug) ---
      // Two back-to-back move-down taps on A. Intended end state: [C, B, A].
      //
      // useReorderAccounts kicks off a fresh mutation per tap. Each mutation
      // does N sequential `db.runAsync` UPDATEs, which on iOS round-trip
      // through JSI to native SQLite (~10–50 ms each). The two mutations
      // run in PARALLEL — TanStack Query does not serialize mutations from
      // the same hook. Their UPDATE loops interleave, the last writer wins
      // per row, and the final sort_order in SQLite is non-deterministic.
      //
      // The optimistic `setQueryData` in onMutate makes the UI look correct
      // briefly, so users see the right order — until the next refetch
      // (triggered by onSettled, a rename, app foreground, sync) surfaces
      // the wrong on-disk order.
      await page.getByTestId(`accounts-move-down-${A}`).click();
      await page.getByTestId(`accounts-move-down-${A}`).click();

      // The optimistic cache settles to [C, B, A]. This usually passes
      // even pre-fix because the optimistic write masks the DB race.
      await expect
        .poll(async () => orderOf(page, [A, B, C]), { timeout: 10_000 })
        .toEqual([C, B, A]);

      // Force a refetch by reloading the page. Post-fix: order stays
      // [C, B, A]. Pre-fix: a stale on-disk order surfaces (e.g. [C, A, B]).
      await page.reload();
      // Wait until the FlatList has actually rendered our accounts —
      // the "Accounts" sidebar header appears before useAccounts resolves.
      await page.getByText(A).waitFor({ state: 'visible', timeout: 15_000 });
      expect(await orderOf(page, [A, B, C])).toEqual([C, B, A]);

      // --- Rename in edit mode ---
      await page.getByTestId('accounts-edit-toggle').click();
      const renamed = `${C} Renamed`;
      await page.getByText(C, { exact: true }).click();
      await page.getByTestId('accounts-edit-name').waitFor({ state: 'visible', timeout: 10000 });
      await page.getByTestId('accounts-edit-name').fill(renamed);
      await page.getByTestId('accounts-edit-save').click();
      await expect(page.getByText(renamed)).toBeVisible({ timeout: 10000 });

      // The rename triggers an invalidate + refetch, which is a second way
      // the buggy on-disk order can surface even without an explicit reload.
      expect(await orderOf(page, [A, B, renamed])).toEqual([renamed, B, A]);
    } finally {
      await deleteIfPresent(page, [`${C} Renamed`, C, B, A]);
    }
  });
});

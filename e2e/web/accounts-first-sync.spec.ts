import { test, expect } from './fixtures';
import { deleteAccountAndWaitForPush } from './helpers/test-accounts';

// #55, made deterministic: hold `GET /rest/v1/transactions` open for 2.5 s so
// the bootstrap still owns the sync lock while the account is created and
// deleted. Both mutations call `requestPush`, which can only queue a flag
// while the lock is held; before this fix nothing drained that flag, so the
// sidebar label sat at `1 pending` until an AppState or NetInfo event that on
// the web may never come. Waiting for the exact word `Synced` is therefore the
// assertion: it means the queued work was drained before the holder released.
// On `main` this fails every run (5 of 5 locally), stuck at `1 pending`.
//
// Deliberately no rename step, unlike accounts.spec.ts. That spec's rename
// has a separate, spec-side race (the second cause in #55). After Create, the
// Add-Account modal stays mounted for react-native-web's 250 ms slide-out, and
// its focus trap stays active until that animation ends. A `fill()` on
// `accounts-edit-name` inside that window is pulled back into
// `accounts-new-name`. The new name goes into the hidden, closing field, and
// Save updates the account with its old name. The fix is to wait for
// `accounts-new-name` to detach before editing; it belongs in accounts.spec.ts,
// not here, where it would make this spec red for a reason it is not testing.
//
// The name shares accounts.spec.ts's `E2E Test ` prefix so the same cleanup
// and CI purge cover it, with its own token so the two can never collide.
const TEST_ACCOUNT = `E2E Test FirstSync ${Date.now()}`;

test.describe('Accounts CRUD during the first sync', () => {
  test('creates and deletes an account while the bootstrap holds the lock', async ({
    page,
  }) => {
    // The route delay only holds the window open; nothing else proves a
    // mutation landed inside it. On a slow runner the bootstrap can finish
    // before the create click, and `Synced` would then pass while testing
    // nothing. The engine logs this line exactly when requestPush finds the
    // lock held, so it is what makes the spec check its own premise.
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));

    await page.route('**/rest/v1/transactions*', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    // Create account
    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(TEST_ACCOUNT);
    await page.getByTestId('accounts-create-btn').click();

    await expect(page.getByText(TEST_ACCOUNT)).toBeVisible({ timeout: 10000 });

    // Delete it and wait for the delete to be pushed, not just applied
    // locally. This is the assertion the whole spec exists for.
    await page.getByTestId('accounts-edit-toggle').click();
    page.on('dialog', (dialog) => dialog.accept());
    await deleteAccountAndWaitForPush(page, TEST_ACCOUNT);
    await expect(page.getByText(TEST_ACCOUNT)).not.toBeVisible();

    expect(
      consoleLines,
      'no mutation landed while the bootstrap held the lock; the spec tested nothing'
    ).toContain('[sync] push queued: a sync is in flight');
  });
});

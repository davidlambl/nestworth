import { test, expect } from './fixtures';
import {
  deleteAccountAndWaitForPush,
  waitForSyncIdle,
} from './helpers/test-accounts';

// `E2E Test ` is in TEST_ACCOUNT_PREFIXES, so CI's age-gated purge in
// global-setup.ts reclaims this account if the run dies before its delete.
const TEST_ACCOUNT = `E2E Test ${Date.now()}`;
const CARD_ID = `account-card-${TEST_ACCOUNT.replace(/\s+/g, '-').toLowerCase()}`;

test.describe('Account archiving', () => {
  test('archive hides an account, Archived restores it, delete still works', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    // Pre-mutation wait: let the cross-device pull finish writing before this
    // spec starts asserting about the contents of the list.
    await waitForSyncIdle(page);

    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(TEST_ACCOUNT);
    await page.getByTestId('accounts-create-btn').click();

    const card = page.getByTestId(CARD_ID);
    await expect(card).toBeVisible({ timeout: 15000 });

    // Archive it from the edit-mode row.
    const editToggle = page.getByTestId('accounts-edit-toggle');
    await editToggle.click();
    const archiveBtn = page.getByRole('button', {
      name: `Archive ${TEST_ACCOUNT}`,
      exact: true,
    });
    await archiveBtn.click();

    // Gone from the active list; the collapsed Archived group appears. Never
    // assert an exact count — the shared test user may hold other archived
    // rows.
    await expect(archiveBtn).toBeHidden({ timeout: 15000 });
    await expect(card).toBeHidden();
    const archivedToggle = page.getByTestId('accounts-archived-toggle');
    await expect(archivedToggle).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/^Archived \(\d+\)$/).first()).toBeVisible();

    // Expanding the group brings the card back, dimmed.
    await archivedToggle.click();
    await expect(card).toBeVisible({ timeout: 10000 });

    // Its register is read-mostly: banner, no add button.
    await editToggle.click(); // leave edit mode so the card navigates
    await page.getByText(TEST_ACCOUNT).first().click();
    await expect(page.getByTestId('register-archived-banner')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('register-add-btn')).toHaveCount(0);

    // Unarchiving from the banner brings the header buttons back. This also
    // covers useUpdateAccount invalidating ['account', id]: the register reads
    // that key, not ['accounts'].
    await page.getByTestId('register-unarchive-btn').click();
    await expect(page.getByTestId('register-archived-banner')).toBeHidden({
      timeout: 15000,
    });
    await expect(page.getByTestId('register-add-btn')).toBeVisible({
      timeout: 10000,
    });

    // Back on the Accounts tab the account is active again, and delete — still
    // the destructive exit — works as before.
    await page.goBack();
    await editToggle.click({ timeout: 10000 });
    await expect(archiveBtn).toBeVisible({ timeout: 15000 });

    page.on('dialog', (dialog) => dialog.accept());
    await deleteAccountAndWaitForPush(page, TEST_ACCOUNT);
    await expect(card).toBeHidden();
  });
});

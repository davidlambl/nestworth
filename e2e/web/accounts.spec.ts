import { test, expect } from '@playwright/test';
import { deleteAccountAndWaitForPush } from './helpers/test-accounts';

const TEST_ACCOUNT = `E2E Test ${Date.now()}`;

test.describe('Accounts CRUD', () => {
  test('create, rename, and delete an account', async ({ page }) => {
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

    // Enter edit mode and rename
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByText(TEST_ACCOUNT).click();

    const renamed = `${TEST_ACCOUNT} Renamed`;
    await page
      .getByTestId('accounts-edit-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-edit-name').fill(renamed);
    await page.getByTestId('accounts-edit-save').click();

    await expect(page.getByText(renamed)).toBeVisible({ timeout: 10000 });

    // Delete the account (still in edit mode) and wait for the delete to be
    // pushed, not just applied locally.
    page.on('dialog', (dialog) => dialog.accept());
    await deleteAccountAndWaitForPush(page, renamed);
    await expect(page.getByText(renamed)).not.toBeVisible();
  });
});

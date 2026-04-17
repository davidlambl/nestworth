import { test, expect } from '@playwright/test';

const ACCT_NAME = `Txn Test ${Date.now()}`;
const PAYEE = `E2E Payee ${Date.now()}`;

test.describe('Transactions CRUD', () => {
  test('create account, add transaction, edit it, delete it, clean up', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

    // Create a scratch account
    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(ACCT_NAME);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // Navigate into the account register
    await page.getByText(ACCT_NAME).click();
    await expect(page.getByText('No transactions')).toBeVisible({ timeout: 10000 });

    // Create a transaction
    await page.getByTestId('register-add-btn').click();
    await page.getByTestId('new-txn-payee').fill(PAYEE);
    await page.getByTestId('new-txn-amount').fill('1234');
    await page.getByTestId('new-txn-memo').fill('e2e test memo');
    await page.getByTestId('new-txn-save').click();

    // Should be back on register with the transaction visible
    await expect(page.getByText(PAYEE)).toBeVisible({ timeout: 10000 });

    // Tap the transaction to edit it
    await page.getByText(PAYEE).click();
    await page.getByTestId('edit-txn-payee').fill(`${PAYEE} Edited`);
    await page.getByTestId('edit-txn-save').click();

    await expect(page.getByText(`${PAYEE} Edited`)).toBeVisible({ timeout: 10000 });

    // Delete the transaction
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByText(`${PAYEE} Edited`).click();
    await page.getByTestId('edit-txn-delete').click();

    await expect(page.getByText('No transactions')).toBeVisible({ timeout: 10000 });

    // Clean up: go back and delete the scratch account
    await page.goBack();
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByRole('button', { name: `Delete ${ACCT_NAME}` }).click();
  });
});

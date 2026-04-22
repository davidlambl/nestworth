import { test, expect } from '@playwright/test';

const ts = Date.now();
const FROM_ACCT = `Xfer From ${ts}`;
const TO_ACCT = `Xfer To ${ts}`;

test.describe('Transfers', () => {
  test('create two accounts, transfer between them, verify both legs', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

    // Create "from" account
    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(FROM_ACCT);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(FROM_ACCT)).toBeVisible({ timeout: 10000 });

    // Create "to" account
    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(TO_ACCT);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(TO_ACCT)).toBeVisible({ timeout: 10000 });

    // Open the "from" account register
    await page.getByText(FROM_ACCT).first().click();
    await expect(page.getByText('No transactions')).toBeVisible({ timeout: 10000 });

    // Start a transfer
    await page.getByTestId('register-transfer-btn').click();

    // From-account balance should be visible (fixed from account, zero balance for a fresh account)
    await expect(page.getByTestId('transfer-from-balance')).toHaveText(/Balance: \$0\.00/);

    // Pick "to" account using picker testID (avoids ambiguity from sidebar/account cards)
    const toPickerId = `picker-${TO_ACCT.replace(/\s+/g, '-').toLowerCase()}`;
    await page.getByTestId('transfer-to-picker').click();
    await page.getByTestId(toPickerId).click();

    // Enter amount and save
    await page.getByTestId('transfer-amount').fill('5000');
    await page.getByTestId('transfer-save').click();

    // Should be back on from account register with the debit
    await expect(page.getByText(`Transfer to ${TO_ACCT}`)).toBeVisible({ timeout: 10000 });

    // Navigate to "to" account and verify the credit leg
    await page.goto('/');
    await page.getByText(TO_ACCT).first().click();
    await expect(page.getByText(`Transfer from ${FROM_ACCT}`)).toBeVisible({ timeout: 10000 });

    // Clean up: delete both accounts
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto('/');
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByRole('button', { name: `Delete ${FROM_ACCT}` }).click();
    await page.getByRole('button', { name: `Delete ${TO_ACCT}` }).click();
  });
});

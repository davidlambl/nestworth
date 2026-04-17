import { test, expect } from '@playwright/test';

const ts = Date.now();
const ACCT_NAME = `Recur Acct ${ts}`;
const RULE_PAYEE = `E2E Rent ${ts}`;

test.describe('Recurring rules', () => {
  test('create account, add recurring rule, verify it, delete it, clean up', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

    // Create a scratch account
    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(ACCT_NAME);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // Navigate to Settings > Recurring Transactions via URL
    await page.goto('/settings');
    await page.getByText('Recurring Transactions').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Recurring Transactions').click();

    await expect(page.getByText('No recurring transactions')).toBeVisible({ timeout: 10000 });

    // Create a new recurring rule
    await page.getByTestId('recurring-add-btn').click();

    // Select the scratch account
    await page.getByText(ACCT_NAME).click();
    await page.getByTestId('recurring-payee').fill(RULE_PAYEE);
    await page.getByTestId('recurring-amount').fill('1500');
    await page.getByText('Monthly').click();
    await page.getByTestId('recurring-save').click();

    // Verify the rule appears
    await expect(page.getByText(RULE_PAYEE)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Monthly')).toBeVisible();

    // Delete the rule via long-press (web = confirm dialog)
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByText(RULE_PAYEE).click({ delay: 1000 });

    await expect(page.getByText('No recurring transactions')).toBeVisible({ timeout: 10000 });

    // Clean up: go back and delete the scratch account
    await page.goto('/');
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByRole('button', { name: `Delete ${ACCT_NAME}` }).click();
  });
});

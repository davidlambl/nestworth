import { test, expect } from '@playwright/test';

const ts = Date.now();
const ACCT_NAME = `Import Acct ${ts}`;
const CSV_DATA = `Date,Title,Amount
2026-01-15,"E2E Coffee Shop",-4.50
2026-01-16,"E2E Paycheck",2500.00`;

test.describe('CSV Import', () => {
  test('create account, import CSV, verify transactions, clean up', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

    // Create a scratch account
    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(ACCT_NAME);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // Navigate to Import via URL-based settings navigation
    await page.goto('/settings');
    await page.getByText('Import Transactions (CSV)').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Import Transactions (CSV)').click();

    // Select the scratch account
    await page.getByText(ACCT_NAME).click();

    // Paste CSV data
    await page.getByTestId('import-csv-input').fill(CSV_DATA);
    await page.getByTestId('import-preview-btn').click();

    // Preview step: verify parsed transactions
    await expect(page.getByText('E2E Coffee Shop')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('E2E Paycheck')).toBeVisible();
    await expect(page.getByText('2 of 2 selected')).toBeVisible();

    // Confirm import
    await page.getByText('Import 2 Transactions').click();
    await expect(page.getByText('Import Complete')).toBeVisible({ timeout: 10000 });
    await page.getByText('Done').click();

    // Go to the account and verify imported transactions
    await page.goto('/');
    await page.getByText(ACCT_NAME).click();
    await expect(page.getByText('E2E Coffee Shop')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('E2E Paycheck')).toBeVisible();

    // Clean up: delete the scratch account
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto('/');
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByRole('button', { name: `Delete ${ACCT_NAME}` }).click();
  });
});

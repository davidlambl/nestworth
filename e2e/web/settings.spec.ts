import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('displays settings page with key sections', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Appearance')).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('Not signed in')).not.toBeVisible();
    await expect(page.getByText('Recurring Transactions')).toBeVisible();
    await expect(page.getByText('Import Transactions (CSV)')).toBeVisible();
    await expect(page.getByText('Export Transactions (CSV)')).toBeVisible();
    await expect(page.getByText('Cloud sync')).toBeVisible();
    await expect(page.getByText('Font Size')).toBeVisible();
    await expect(page.getByText('Sign Out')).toBeVisible();
    await expect(
      page.getByText('Reset & re-download from cloud')
    ).toBeVisible();
  });

  test('reset local data prompts for confirmation and can be cancelled', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByText('Cloud sync')).toBeVisible({ timeout: 15000 });

    // Cancel the confirm() so the test stays non-destructive (no re-download).
    let prompted = '';
    page.once('dialog', async (dialog) => {
      prompted = dialog.message();
      await dialog.dismiss();
    });

    await page.getByTestId('settings-reset-local').click();

    await expect.poll(() => prompted).toContain('re-download');
    // Cancelled → still on Settings, nothing wiped.
    await expect(page.getByText('Cloud sync')).toBeVisible();
  });

  test('can toggle theme preference', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Appearance')).toBeVisible({ timeout: 15000 });

    await page.getByText('Dark').click();
    await page.getByText('System').click();

    await expect(page.getByText('Appearance')).toBeVisible();
  });

  test('can toggle font size preference', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Font Size')).toBeVisible({ timeout: 15000 });

    await page.getByText('Large').click();
    await expect(page.getByText('Font Size')).toBeVisible();

    await page.getByText('Medium').click();
    await expect(page.getByText('Font Size')).toBeVisible();
  });
});

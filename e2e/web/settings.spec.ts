import { test, expect } from './fixtures';
import appJson from '../../app.json';

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

  test('footer shows the version from app.json', async ({ page }) => {
    await page.goto('/settings');
    // The README's "which build is running?" check reads this line, so it must
    // follow app.json rather than a literal that a release can forget to bump.
    await expect(page.getByTestId('settings-version')).toHaveText(
      `Nestworth v${appJson.expo.version}`,
      { timeout: 15000 }
    );
  });

  test('reset local data prompts for confirmation and can be cancelled', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByText('Cloud sync')).toBeVisible({ timeout: 15000 });
    // The button is deliberately `disabled` while `syncStatus.isSyncing` —
    // resetLocalData refuses to run during a sync. `Cloud sync` renders long
    // before the startup sync finishes, and since #55 that sync reliably
    // happens (it used to be skipped when the engine's effect was torn down
    // mid-bootstrap), so clicking here without waiting hits a disabled button
    // and no confirm() is ever raised.
    // Not toBeEnabled(): react-native-web renders this as a role-less div, on
    // which Playwright ignores aria-disabled, so it would pass immediately.
    await expect(page.getByTestId('settings-reset-local')).not.toHaveAttribute(
      'aria-disabled',
      'true',
      { timeout: 30_000 }
    );

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

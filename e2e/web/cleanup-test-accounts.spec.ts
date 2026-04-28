import { test } from '@playwright/test';
import { deleteAccountsWithPrefix, waitForSyncIdle } from './helpers/test-accounts';

// Standalone spec for purging test-owned accounts left behind by failed runs.
// Skipped by default — run explicitly with:
//   CLEANUP_TEST_ACCOUNTS=1 npx playwright test cleanup-test-accounts --project=chromium
//
// Mirrors the prefix list in e2e/ios/cleanup-test-accounts.yaml.
const PREFIXES = [
  'Maestro ',
  'E2E Test ',
  'Icon Test ',
  'Txn Test ',
  'Import Acct ',
  'Xfer ',
  'Payee Rank ',
  'Recur Acct ',
  'Reorder Acct ',
];

test.describe('Cleanup test accounts', () => {
  test.skip(
    process.env.CLEANUP_TEST_ACCOUNTS !== '1',
    'Set CLEANUP_TEST_ACCOUNTS=1 to run.'
  );

  test('delete every account matching a known test prefix', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });
    await waitForSyncIdle(page);

    const cardCount = await page.locator('[data-testid^="account-card-"]').count();
    console.log(`After sync: ${cardCount} cards rendered`);

    const deleted = await deleteAccountsWithPrefix(page, PREFIXES);
    console.log(`Cleanup complete — deleted ${deleted} test accounts.`);
  });
});

import { test } from '@playwright/test';
import {
  deleteAccountsWithPrefix,
  expectSynced,
  TEST_ACCOUNT_PREFIXES,
  waitForSyncIdle,
} from './helpers/test-accounts';

// Standalone spec for purging test-owned accounts left behind by failed runs.
// Skipped by default — run explicitly with:
//   CLEANUP_TEST_ACCOUNTS=1 npx playwright test cleanup-test-accounts --project=chromium
//
// CI does not need it: global-setup tombstones stale test accounts through the
// REST API on every run (E2E_PURGE_STALE_TEST_ACCOUNTS=1). This spec is the
// browser-driven fallback for a local clean-up of everything, age regardless.

test.describe('Cleanup test accounts', () => {
  test.skip(
    process.env.CLEANUP_TEST_ACCOUNTS !== '1',
    'Set CLEANUP_TEST_ACCOUNTS=1 to run.'
  );

  test('delete every account matching a known test prefix', async ({
    page,
  }) => {
    test.setTimeout(300_000);

    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    await waitForSyncIdle(page);

    const cardCount = await page
      .locator('[data-testid^="account-card-"]')
      .count();
    console.log(`After sync: ${cardCount} cards rendered`);

    const deleted = await deleteAccountsWithPrefix(page, TEST_ACCOUNT_PREFIXES);
    // The helper returns once the LOCAL list is empty; the tombstones still
    // have to be pushed before this context closes.
    await expectSynced(page);
    console.log(`Cleanup complete — deleted ${deleted} test accounts.`);
  });
});

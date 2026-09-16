import { test, expect, type Page } from '@playwright/test';
import { deleteAccountAndWaitForPush } from './helpers/test-accounts';

const ts = Date.now();
const ACCT_NAME = `Payee Rank ${ts}`;
const INTERIOR_PAYEE = `Safeway Groceries ${ts}`;
const PREFIX_PAYEE = `Groceries R Us ${ts}`;

// React Native Web's TextInput swallows Playwright's fill() and
// pressSequentially() in some RN 0.81 builds — the native input event
// fires but React's controlled-input handler doesn't pick it up, so the
// state never updates. Setting the value via the prototype setter and
// dispatching a bubbling 'input' event is the standard workaround.
async function setRNInput(page: Page, testId: string, value: string) {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test.describe('Payee suggestion ranking', () => {
  test('prefix matches rank above interior substring matches', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    // Scratch account
    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await setRNInput(page, 'accounts-new-name', ACCT_NAME);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // Open the register
    await page.getByText(ACCT_NAME).click();
    await expect(page.getByText('No transactions')).toBeVisible({
      timeout: 10000,
    });

    // Seed the prefix-matching payee FIRST so recency alone would rank it last.
    // Without prefix ranking, the interior match (Safeway) would appear above
    // the prefix match (Groceries R Us). With prefix ranking, the prefix
    // match jumps ahead despite being older.
    await page.getByTestId('register-add-btn').click();
    await page
      .getByTestId('new-txn-payee')
      .waitFor({ state: 'visible', timeout: 10000 });
    await setRNInput(page, 'new-txn-payee', PREFIX_PAYEE);
    await setRNInput(page, 'new-txn-amount', '1000');
    await page.getByTestId('new-txn-save').click();
    await expect(page.getByText(PREFIX_PAYEE)).toBeVisible({ timeout: 10000 });

    await page.getByTestId('register-add-btn').click();
    await page
      .getByTestId('new-txn-payee')
      .waitFor({ state: 'visible', timeout: 10000 });
    await setRNInput(page, 'new-txn-payee', INTERIOR_PAYEE);
    await setRNInput(page, 'new-txn-amount', '2000');
    await page.getByTestId('new-txn-save').click();
    await expect(page.getByText(INTERIOR_PAYEE)).toBeVisible({
      timeout: 10000,
    });

    // Open a fresh new-transaction screen and probe the suggestion order
    await page.getByTestId('register-add-btn').click();
    await page
      .getByTestId('new-txn-payee')
      .waitFor({ state: 'visible', timeout: 10000 });
    await setRNInput(page, 'new-txn-payee', 'Gro');

    const first = page.getByTestId('payee-suggestion-0');
    const second = page.getByTestId('payee-suggestion-1');
    await expect(first).toHaveText(PREFIX_PAYEE);
    await expect(second).toHaveText(INTERIOR_PAYEE);

    // Core assertion (prefix ranking) has already passed at this point.
    // Cleanup is best-effort — Expo Router's web Stack accumulates screens,
    // so multi-step back-navigation is flaky. Failures here shouldn't mask
    // the behavior we're actually verifying.
    page.on('dialog', (dialog) => dialog.accept());
    try {
      await page.getByText('Cancel').last().click();
      await page.getByText(INTERIOR_PAYEE).click();
      await page.getByTestId('edit-txn-delete').click();
      await expect(page.getByText(INTERIOR_PAYEE)).not.toBeVisible({
        timeout: 10000,
      });

      await page.getByText(PREFIX_PAYEE).click();
      await page.getByTestId('edit-txn-delete').click();
      await expect(page.getByText(PREFIX_PAYEE)).not.toBeVisible({
        timeout: 10000,
      });

      // The delete handler pops the edit screen with router.back(); a goto()
      // issued while that history navigation is still in flight is aborted
      // (net::ERR_ABORTED). Wait for the edit screen to be gone first.
      await expect(page.getByTestId('edit-txn-delete')).toBeHidden({
        timeout: 10000,
      });
      // A full navigation, not goBack(): after the register/edit screens the
      // Accounts screen's edit toggle is still in the DOM but not visible, so
      // the old `.last().click()` timed out every run and this account was
      // the one that always leaked (#54).
      await page.goto('/');
      await page
        .getByText('Accounts')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
      await page.getByTestId('accounts-edit-toggle').click({ timeout: 5000 });
      // Waits for the delete to be pushed, not just applied locally; anything
      // this best-effort path misses is tombstoned by the CI purge in
      // global-setup.
      await deleteAccountAndWaitForPush(page, ACCT_NAME);
    } catch (e) {
      console.warn('payee-suggestions cleanup skipped:', (e as Error).message);
    }
  });
});

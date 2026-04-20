import { test, expect } from '@playwright/test';

const ACCT_NAME = `Icon Test ${Date.now()}`;
const CHOSEN_EMOJI = '🎯';

test.describe('New account icon selection', () => {
  test('persists the user-picked emoji on the new account', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/');
    await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

    await page.getByTestId('accounts-add-btn').click();
    await page.getByTestId('accounts-new-name').waitFor({ state: 'visible', timeout: 10000 });

    // Fill the name via the RN Web-compatible setter (fill() doesn't always
    // land on RN Web controlled TextInputs).
    await page.getByTestId('accounts-new-name').evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, ACCT_NAME);

    // Open the icon picker and select a non-default emoji
    await page.getByTestId('accounts-new-icon-picker').click();
    await page.getByTestId(`accounts-icon-${CHOSEN_EMOJI}`).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId(`accounts-icon-${CHOSEN_EMOJI}`).click();

    // The preview in the new-account form should now show the chosen emoji
    await expect(page.getByTestId('accounts-new-icon-preview')).toHaveText(CHOSEN_EMOJI);

    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // The account card icon should be the chosen emoji, not the default 🏦
    const cardId = `account-card-${ACCT_NAME.replace(/\s+/g, '-').toLowerCase()}`;
    await expect(page.getByTestId(cardId).getByText(CHOSEN_EMOJI)).toBeVisible();

    // Best-effort cleanup — matches the pattern used by payee-suggestions.spec.ts
    try {
      await page.getByTestId('accounts-edit-toggle').last().click({ timeout: 5000 });
      await page.getByRole('button', { name: `Delete ${ACCT_NAME}` }).click();
    } catch (e) {
      console.warn('account-icon cleanup skipped:', (e as Error).message);
    }
  });
});

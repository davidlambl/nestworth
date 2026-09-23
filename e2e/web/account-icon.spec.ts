import { test, expect } from './fixtures';
import {
  deleteAccountAndWaitForPush,
  waitForModalToClose,
  waitForSyncIdle,
} from './helpers/test-accounts';

const ACCT_NAME = `Icon Test ${Date.now()}`;
const CHOSEN_EMOJI = '🎯';

test.describe('New account icon selection', () => {
  test('persists the user-picked emoji on the new account', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    // Let the startup pull finish before opening the form. On PR #92's run the
    // "+" was pressed while the list was still loading, which pushed the whole
    // modal hand-off below into the window where the pulled accounts were being
    // rendered — the busy main thread is what let the click below land mid-slide.
    await waitForSyncIdle(page);

    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });

    // Fill the name via the RN Web-compatible setter (fill() doesn't always
    // land on RN Web controlled TextInputs).
    await page.getByTestId('accounts-new-name').evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, ACCT_NAME);

    // Open the icon picker and select a non-default emoji. The Icon row closes
    // the New Account modal and opens the picker in one commit, and a closing
    // react-native-web Modal keeps its focus trap for its whole 250 ms slide-out
    // (the #61 trap — see e2e.md and waitForModalToClose). A click on a tile
    // before the form modal has detached can be terminated by that focus steal
    // before onPress fires: on run 35816473080 the 🎯 tile was pressed mid-slide,
    // the picker stayed open, and the preview assertion looked for a modal that
    // had just unmounted. So wait for the closing modal to leave the DOM first.
    await page.getByTestId('accounts-new-icon-picker').click();
    await waitForModalToClose(page, 'accounts-new-name');
    await page.getByTestId(`accounts-icon-${CHOSEN_EMOJI}`).click();

    // The preview in the new-account form should now show the chosen emoji
    await expect(page.getByTestId('accounts-new-icon-preview')).toHaveText(
      CHOSEN_EMOJI
    );

    // The same hand-off in reverse: picking a tile closes the picker and
    // re-opens the form, and the picker owns focus until it unmounts.
    await waitForModalToClose(page, `accounts-icon-${CHOSEN_EMOJI}`);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });

    // The account card icon should be the chosen emoji, not the default 🏦
    const cardId = `account-card-${ACCT_NAME.replace(/\s+/g, '-').toLowerCase()}`;
    await expect(
      page.getByTestId(cardId).getByText(CHOSEN_EMOJI)
    ).toBeVisible();

    // Best-effort cleanup — matches the pattern used by payee-suggestions.spec.ts.
    // When it runs, it waits for the delete to be pushed, not just applied
    // locally; anything it misses is tombstoned by the CI purge in global-setup.
    try {
      await page
        .getByTestId('accounts-edit-toggle')
        .last()
        .click({ timeout: 5000 });
      await deleteAccountAndWaitForPush(page, ACCT_NAME);
    } catch (e) {
      console.warn('account-icon cleanup skipped:', (e as Error).message);
    }
  });
});

import { test, expect } from './fixtures';
import {
  deleteAccountAndWaitForPush,
  waitForModalToClose,
} from './helpers/test-accounts';

const ACCT_NAME = `Txn Test ${Date.now()}`;
const PAYEE = `E2E Payee ${Date.now()}`;

test.describe('Transactions CRUD', () => {
  test('create account, add transaction, edit it, delete it, clean up', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    // Create a scratch account
    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(ACCT_NAME);
    await page.getByTestId('accounts-create-btn').click();
    await expect(page.getByText(ACCT_NAME)).toBeVisible({ timeout: 10000 });
    // The Add modal's focus trap stays active through its slide-out and would
    // pull the payee fill() below back into `accounts-new-name` (#55).
    await waitForModalToClose(page, 'accounts-new-name');

    // Navigate into the account register
    await page.getByText(ACCT_NAME).click();
    await expect(page.getByText('No transactions')).toBeVisible({
      timeout: 10000,
    });

    // Create a transaction
    await page.getByTestId('register-add-btn').click();
    // `transaction/new` is a pushed route, so the click only starts the
    // navigation: wait for the field to exist rather than letting the first
    // fill() define the moment the screen is ready.
    await page
      .getByTestId('new-txn-payee')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('new-txn-payee').fill(PAYEE);
    await page.getByTestId('new-txn-amount').fill('1234');
    await page.getByTestId('new-txn-memo').fill('e2e test memo');
    await page.getByTestId('new-txn-save').click();

    // Should be back on register with the transaction visible
    await expect(page.getByText(PAYEE)).toBeVisible({ timeout: 10000 });
    // The row rendering does not mean the departing route has gone: a
    // dismissed screen stays mounted over the register until its animation
    // ends, so the click below could land on it instead of the row.
    await waitForModalToClose(page, 'new-txn-payee');

    // Tap the transaction to edit it
    await page.getByText(PAYEE).click();
    // `transaction/[id]` starts with payee='' and copies `txn.payee` in an
    // effect once `useTransaction` resolves (app/transaction/[id].tsx:75,
    // :90-93). A fill() that lands before that effect runs is overwritten and
    // Save writes the original payee (#78) — the loaded value in the field is
    // the proof that the effect has already run.
    await expect(page.getByTestId('edit-txn-payee')).toHaveValue(PAYEE, {
      timeout: 10000,
    });
    await page.getByTestId('edit-txn-payee').fill(`${PAYEE} Edited`);
    // Fail here, not two steps later, if the typed value is ever lost again.
    await expect(page.getByTestId('edit-txn-payee')).toHaveValue(
      `${PAYEE} Edited`
    );
    await page.getByTestId('edit-txn-save').click();

    await expect(page.getByText(`${PAYEE} Edited`)).toBeVisible({
      timeout: 10000,
    });
    // Same hand-off as after the create: the edit route is still mounted over
    // the register while it animates out, and the row click below has to
    // reach the register.
    await waitForModalToClose(page, 'edit-txn-payee');

    // Delete the transaction
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByText(`${PAYEE} Edited`).click();
    // The edit route mounts from scratch and renders a spinner instead of the
    // form until `useTransaction` resolves, so Delete does not exist yet.
    await page
      .getByTestId('edit-txn-delete')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('edit-txn-delete').click();

    await expect(page.getByText('No transactions')).toBeVisible({
      timeout: 10000,
    });

    // Clean up: back to Accounts, delete the scratch account, wait for the push
    // A full navigation, not goBack(): after the register and edit screens the
    // Accounts screen's edit toggle is still in the DOM but not visible, so the
    // click below would time out — the pattern that made this class of spec
    // leak accounts in #54.
    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    await page.getByTestId('accounts-edit-toggle').click();
    await deleteAccountAndWaitForPush(page, ACCT_NAME);
  });
});

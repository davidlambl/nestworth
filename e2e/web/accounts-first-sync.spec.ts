import { test, expect } from './fixtures';
import {
  deleteAccountAndWaitForPush,
  waitForModalToClose,
} from './helpers/test-accounts';

// #55, made deterministic: hold `GET /rest/v1/transactions` open for 2.5 s so
// the bootstrap still owns the sync lock while the account is created, renamed
// and deleted. Each mutation calls `requestPush`, which can only queue a flag
// while the lock is held; before #59 nothing drained that flag, so the sidebar
// label sat at `1 pending` until an AppState or NetInfo event that on the web
// may never come. Waiting for the exact word `Synced` is therefore the
// assertion: it means the queued work was drained before the holder released.
// Before #59 this failed every run (5 of 5 locally), stuck at `1 pending`.
//
// The rename step also crosses #55's second cause, a react-native-web Modal
// hand-off. After Create, the Add-Account modal stays mounted for its 250 ms
// slide-out, and it stays the ACTIVE modal (its document-level focus trap
// included) until that animation ends; the Edit modal only becomes active
// when its own slide-in ends. A `fill()` on `accounts-edit-name` inside that
// window has its focus pulled back into `accounts-new-name`, the text lands
// in the closing field, and Save writes the account's old name. So the spec
// waits for `accounts-new-name` to detach before it edits
// (`waitForModalToClose`) and asserts the edit field holds the new name
// before it saves, so any focus theft fails at the step where it happens.
//
// The name shares accounts.spec.ts's `E2E Test ` prefix so the same cleanup
// and CI purge cover it, with its own token so the two can never collide.
const TEST_ACCOUNT = `E2E Test FirstSync ${Date.now()}`;

test.describe('Accounts CRUD during the first sync', () => {
  test('creates, renames and deletes an account while the bootstrap holds the lock', async ({
    page,
  }) => {
    // The route delay only holds the window open; nothing else proves a
    // mutation landed inside it. On a slow runner the bootstrap can finish
    // before the create click, and `Synced` would then pass while testing
    // nothing. The engine logs this line exactly when requestPush finds the
    // lock held, so it is what makes the spec check its own premise.
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));

    await page.route('**/rest/v1/transactions*', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    await page.goto('/');
    await page
      .getByText('Accounts')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    // Create account
    await page.getByTestId('accounts-add-btn').click();
    await page
      .getByTestId('accounts-new-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-new-name').fill(TEST_ACCOUNT);
    await page.getByTestId('accounts-create-btn').click();

    await expect(page.getByText(TEST_ACCOUNT)).toBeVisible({ timeout: 10000 });
    // The Add modal is still sliding out and still owns focus; see the header.
    await waitForModalToClose(page, 'accounts-new-name');

    // Enter edit mode and rename
    await page.getByTestId('accounts-edit-toggle').click();
    await page.getByText(TEST_ACCOUNT).click();

    const renamed = `${TEST_ACCOUNT} Renamed`;
    await page
      .getByTestId('accounts-edit-name')
      .waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('accounts-edit-name').fill(renamed);
    await expect(page.getByTestId('accounts-edit-name')).toHaveValue(renamed);
    await page.getByTestId('accounts-edit-save').click();

    await expect(page.getByText(renamed)).toBeVisible({ timeout: 10000 });

    // Delete it (still in edit mode) and wait for the delete to be pushed, not
    // just applied locally. This is the assertion the whole spec exists for.
    page.on('dialog', (dialog) => dialog.accept());
    await deleteAccountAndWaitForPush(page, renamed);
    await expect(page.getByText(renamed)).not.toBeVisible();

    expect(
      consoleLines,
      'no mutation landed while the bootstrap held the lock; the spec tested nothing'
    ).toContain('[sync] push queued: a sync is in flight');
  });
});

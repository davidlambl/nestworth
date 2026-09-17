import { expect, type Page } from '@playwright/test';

// Shared helpers for specs that interact with the test user's account list.
// The test user is shared by every run, locally and in CI, so a spec has two
// duties at the sync boundary:
//
//   - BEFORE mutating a list it will make assertions about, wait for the
//     cross-device pull to land (`waitForSyncIdle`), otherwise the pull's
//     late writes interleave with the spec's own.
//   - AFTER its last delete, wait for the push to complete
//     (`deleteAccountAndWaitForPush` / `expectSynced`). Deleting is
//     local-first: the mutation soft-deletes in SQLite and fires
//     `requestPush()` without awaiting it, so a spec that returns on the
//     click closes the browser context before the tombstone reaches
//     Supabase and the account survives on the server (issue #54).

/**
 * Every name prefix a spec or Maestro flow gives the accounts it creates.
 * `cleanup-test-accounts.spec.ts` and the CI-time purge in `global-setup.ts`
 * both key off this list; `e2e/mobile/cleanup-test-accounts.yaml` keeps its
 * own copy because YAML cannot import it — keep the two in step.
 */
export const TEST_ACCOUNT_PREFIXES = [
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

/**
 * Wait until the sidebar sync label reads exactly `Synced`.
 *
 * `statusLabel` derives that word from `isSyncing === false`, no error, online
 * and a pending count of zero, and the engine refreshes the count before it
 * clears the flag. So once a write's `requestPush` has been called, `Synced`
 * cannot appear again until that push has completed. The gate is the call:
 * a write whose `requestPush` has not happened yet is invisible to the label,
 * which is why `deleteAccountAndWaitForPush` waits for the list to re-render
 * (downstream of the mutation's synchronous `requestPush`) before it polls.
 * Call this only after such a re-render, never straight after a click. The
 * count is local to this browser context, so only this spec's own writes are
 * being waited on.
 *
 * Deliberately asserts the label is VISIBLE first. It is only rendered in the
 * sidebar (viewport ≥ 768 px, sidebar not collapsed); a spec that cannot see
 * it cannot prove anything about its writes, and should fail here rather than
 * pass vacuously the way a `toBeHidden('Syncing…')` check would.
 */
export async function expectSynced(
  page: Page,
  timeout = 30_000
): Promise<void> {
  const label = page.getByTestId('sync-status-label');
  await expect(
    label,
    'sync label not rendered: it lives in the sidebar (viewport ≥ 768 px, not collapsed), so this spec cannot verify its writes were pushed'
  ).toBeVisible({ timeout });
  await expect(label).toHaveText('Synced', { timeout });
}

/**
 * Click `Delete <name>` (the spec must already be in edit mode and have a
 * dialog handler that accepts the confirm) and wait until the delete has
 * been pushed, not just applied locally.
 *
 * The button disappearing proves the local soft-delete landed; the mutation
 * calls `requestPush()` synchronously before it resolves, so from that point
 * the label can only read `Synced` once the tombstone is on the server and
 * the local rows are hard-deleted.
 */
export async function deleteAccountAndWaitForPush(
  page: Page,
  name: string,
  timeout = 30_000
): Promise<void> {
  const deleteButton = page.getByRole('button', {
    name: `Delete ${name}`,
    exact: true,
  });
  await deleteButton.click();
  await expect(deleteButton).toBeHidden({ timeout: 10_000 });
  await expectSynced(page, timeout);
}

/**
 * Wait for a react-native-web `Modal` that is closing to leave the DOM, by
 * waiting for `testId` (any element inside that modal) to detach.
 *
 * Rule: before typing into anything after a modal closes (a second modal, or
 * a field on the screen behind it), wait for the previous modal to detach.
 *
 * Why (react-native-web 0.21, `exports/Modal`): a modal joins the active-modal
 * stack only in `onShow`, when its slide-in animation ends, and leaves it only
 * in `onDismiss`, when its 250 ms slide-out ends. Throughout the slide-out the
 * closing modal stays mounted and stays active, and its `ModalFocusTrap` keeps
 * a capture-phase `focus` listener on `document` that pulls focus back to the
 * trap's first focusable descendant whenever focus leaves it. Playwright's
 * `fill()` focuses its target and then inserts text into whatever holds
 * focus, so a `fill()` inside that window types into the closing modal
 * instead (issue #55: the rename went into `accounts-new-name` and Save wrote
 * the old name). `hidden` is not enough: the element stays visible while the
 * modal slides out; it is only gone once the modal unmounts its content.
 */
export async function waitForModalToClose(
  page: Page,
  testId: string,
  timeout = 10_000
): Promise<void> {
  await page.getByTestId(testId).waitFor({ state: 'detached', timeout });
}

/**
 * Wait until the AccountsScreen reflects post-pull state.
 *
 * Sequence on a Playwright session:
 *   1. user resolves from localStorage tokens
 *   2. useAccounts fires against an empty IndexedDB-backed SQLite → []
 *   3. UI flashes "No accounts yet"
 *   4. initialPull/fullSync fetches from Supabase and writes to local SQLite
 *   5. invalidateQueries → useAccounts refetches → cards render
 *
 * `networkidle` only confirms the supabase.select calls have returned. The
 * pull then iterates rows in a JS for-loop, awaiting `db.runAsync` for each
 * `upsertRemoteAccount`. Those local SQLite writes don't touch the network.
 * If we proceed at networkidle, the pull is still running in the background
 * and its writes interleave with subsequent test mutations: a chevron tap's
 * mutationFn writes (status='pending'), the deferred push marks rows
 * 'synced', and the still-running pull then overwrites the just-pushed
 * sort_order with the supabase data captured at the start of the pull
 * (often stale by then). Wait for the sync indicator to flip from
 * "Syncing…" to "Synced" — that fires after fullSync's
 * `await pullChanges` resolves, which happens after the iteration finishes.
 */
export async function waitForSyncIdle(
  page: Page,
  timeout = 30_000
): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
  const firstCard = page.locator('[data-testid^="account-card-"]').first();
  const emptyText = page.getByText('No accounts yet');
  await expect(firstCard.or(emptyText)).toBeVisible({ timeout });
  // Sync label settles to one of: "Synced", "Sync error", "Offline",
  // "{N} pending". Anything but "Syncing…" means fullSync (and its pull
  // iteration) has resolved.
  await expect(page.getByText('Syncing…').first()).toBeHidden({ timeout });
}

/**
 * Best-effort delete of every account whose name starts with one of `prefixes`.
 * Loops because the FlatList re-renders after each delete and the next batch
 * scrolls into view.
 *
 * `maxPasses` is a hard safety cap to avoid infinite loops, NOT a target —
 * the loop already exits as soon as the matching count reaches zero. Set it
 * comfortably above the worst-case debris count for the shared test user.
 * If we ever blow past the cap, throw rather than silently leaving debris;
 * silent partial cleanup was previously masking real test setup failures
 * (createAccount timeouts caused by 50+ leftover rows pushing the new card
 * off-screen).
 */
export async function deleteAccountsWithPrefix(
  page: Page,
  prefixes: string[],
  maxPasses = 500
): Promise<number> {
  // Auto-accept the window.confirm() dialog that handleDelete shows on web.
  // Stash the handler so we can deregister in finally — multiple stacked
  // handlers from prior helper calls compete to accept the same dialog,
  // and the second accept() throws "Dialog has already been handled".
  const dialogHandler = (d: { accept: () => Promise<void> }) => {
    d.accept().catch(() => {});
  };
  page.on('dialog', dialogHandler);

  const editToggle = page.getByTestId('accounts-edit-toggle');
  if (!(await editToggle.isVisible().catch(() => false))) {
    page.off('dialog', dialogHandler);
    return 0;
  }
  if ((await editToggle.innerText()).trim() === 'Edit') {
    await editToggle.click();
  }

  // Build a single locator that matches every test-prefix delete button.
  // Using `name`-property text matching across all prefixes via regex.
  const escapedPrefixes = prefixes.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const prefixDeleteRegex = new RegExp(
    `^Delete (${escapedPrefixes.join('|')})`
  );
  const matchingDeletes = page.getByRole('button', { name: prefixDeleteRegex });

  // Archived debris is invisible until the Archived group is expanded: the
  // section renders its cards — and therefore their delete buttons — only when
  // open, and a run that dies between archiving and unarchiving leaves exactly
  // that kind of debris behind. So this has to end with the group OPEN, which
  // is not the same as clicking the toggle: a blind click on an already-open
  // group closes it and hides the very rows the helper exists to purge.
  //
  // Read `aria-expanded` off the toggle rather than inferring from card counts.
  const archivedToggle = page.getByTestId('accounts-archived-toggle');
  const unarchiveButtons = page.locator('[data-testid^="accounts-unarchive-"]');

  let deleted = 0;
  let pass = 0;
  let stalled = false;
  let didOpenGroup = false;
  try {
    if (await archivedToggle.isVisible().catch(() => false)) {
      if ((await archivedToggle.getAttribute('aria-expanded')) === 'false') {
        await archivedToggle.click();
        didOpenGroup = true;
      }
      // Web-first assertion, so this both waits for the expansion to render
      // and fails loudly if the group ended up closed anyway. Going quiet here
      // would under-count the debris and report success.
      await expect(unarchiveButtons.first()).toBeVisible({ timeout: 10_000 });
    }

    for (; pass < maxPasses; pass++) {
      const before = await matchingDeletes.count();
      if (before === 0) break;

      // Standard click() — same pattern that works in transactions.spec.ts,
      // recurring.spec.ts, etc. Playwright handles actionability + scroll.
      // Earlier versions used `force: true` which appeared to land on the
      // wrong element in long lists, exiting edit mode silently.
      await matchingDeletes.first().click();
      // Cache refetch + FlatList rerender after a delete in a long list
      // can take several seconds; 30s is conservative.
      await expect
        .poll(() => matchingDeletes.count(), { timeout: 30_000 })
        .toBeLessThan(before);
      deleted++;
    }

    stalled = pass === maxPasses && (await matchingDeletes.count()) > 0;
  } finally {
    page.off('dialog', dialogHandler);
    // Close the archived group if this helper opened it, so we leave the
    // page in the same state we found it.
    if (didOpenGroup && (await archivedToggle.isVisible().catch(() => false))) {
      if ((await archivedToggle.getAttribute('aria-expanded')) === 'true') {
        await archivedToggle.click().catch(() => {});
      }
    }
    // Always try to exit edit mode, even on the throw path. Otherwise the
    // next test inherits a list stuck in `Done` state with debris still
    // present, which is exactly the state the helper is meant to clear.
    if (await editToggle.isVisible().catch(() => false)) {
      if (
        (await editToggle.innerText().catch(() => 'Edit')).trim() === 'Done'
      ) {
        await editToggle.click().catch(() => {});
      }
    }
  }

  if (stalled) {
    throw new Error(
      `deleteAccountsWithPrefix hit maxPasses=${maxPasses} with debris remaining. ` +
        `Run cleanup-test-accounts.spec.ts with CLEANUP_TEST_ACCOUNTS=1 or raise the cap.`
    );
  }

  return deleted;
}

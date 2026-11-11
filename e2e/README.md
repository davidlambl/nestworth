# End-to-End Testing

Nestworth uses two E2E frameworks:

| Suite  | Tool       | Specs live in             | Platform                          | Runs on |
| ------ | ---------- | ------------------------- | --------------------------------- | ------- |
| Web    | Playwright | `e2e/web/*.spec.ts`       | PWA                               | Any OS  |
| Mobile | Maestro    | `e2e/mobile/flows/*.yaml` | Native (iOS today, Android-ready) | macOS   |

`e2e/mobile/` also holds the Maestro `config.yaml` plus shared subroutines (`login.yaml`, `cleanup-test-accounts.yaml`) referenced via `- runFlow: ../<name>.yaml` from inside flow files.

## Test user setup (one-time, hosted runs and Maestro only)

The Playwright specs need no user of yours by default: they run against the local Supabase stack and make a user for each run there (below). A run against the hosted project (`E2E_TARGET=hosted`, what CI's `Playwright (hosted)` job does after a merge to `main`) and the Maestro flows sign in as a dedicated Supabase user:

1. Go to your Supabase Dashboard > Authentication > Add User
2. Email: `e2e-test@nestworth.app` (or any email)
3. Password: a strong test password
4. Mark the email as confirmed

Then create `.env.e2e` in the project root (gitignored):

```
E2E_TEST_EMAIL=e2e-test@nestworth.app
E2E_TEST_PASSWORD=your-test-password
```

Alternatively, set these as environment variables directly.

## Web (Playwright)

### Prerequisites

```bash
npm install # installs @playwright/test and the Supabase CLI
npx playwright install --with-deps chromium webkit
```

By default the specs run against the local Supabase stack (`supabase/config.toml`; CONTRIBUTING.md section 3, "Rehearsing a migration", says what it holds), which needs a container runtime that answers `docker info`:

```bash
npx supabase start   # the stack: migrations from empty, the receipts bucket; the first start pulls its images
npm run e2e:web      # the suite, as a user made for this run
npx supabase stop    # keeps the local data, the run users included; --no-backup deletes it
```

No `.env.e2e` is needed for this. The stack's keys are the CLI's local demo keys, read from `npx supabase status -o json` when a run starts: keep them out of `.env.local` and every `EXPO_PUBLIC_*` variable (a build refuses the secret one there). The stack's ports are fixed in `config.toml`, so one runs per machine. A user is made per run and stays in the local database (signed in by no later run) until `npx supabase db reset --local` or `stop --no-backup`.

### How it works

Playwright's `globalSetup` (`e2e/web/global-setup.ts`) runs before all specs:

1. Makes a user for this run on the local stack through its Auth admin API (`e2e/web/helpers/local-stack.ts`) and joins a Realtime channel as it once, printing `[e2e] realtime: the run's user joined a Postgres changes channel ...` (or `joined no ...`, which in CI is also a warning on the job); with `E2E_TARGET=hosted`, takes the shared user from `.env.e2e` instead, after the purge below
2. Signs in through the real UI as that user
3. Dismisses onboarding if it appears
4. Saves the session to `e2e/web/.auth/user.json`

Authenticated specs (`chromium` and `webkit-mobile` projects) load this saved session via `storageState`, so they start already signed in. Unauthenticated specs (`smoke.spec.ts`, `auth.spec.ts`) run in a separate project with no stored session.

### Run tests

```bash
npm run e2e:web           # headless, all projects
npm run e2e:web:ui        # interactive UI mode
npm run e2e:web:report    # open the last HTML report
```

Against the local stack Playwright starts an Expo web dev server of its own on port 8082, built with the stack's URL and publishable key, and never reuses one that is already there (a dev server on 8081, pointed at the hosted project by `.env.local`, is left alone). With `E2E_TARGET=hosted` it uses port 8081 and reuses a dev server already running there, outside CI. The first launch takes ~30 seconds while Metro bundles.

### Debugging failures

- **Trace Viewer** (best): every failed attempt keeps its trace (CI retries a failed test once; a local run does not retry). Open with `npx playwright show-trace test-results/<test>/trace.zip` (a failed retry's is under `test-results/<test>-retry1/`). On CI the traces are in the run's `playwright-report` artifact (the local-stack job's; `playwright-report-hosted` is the hosted job's, on `main`), as its `data/*.zip` files.
- **Screenshots/video**: saved on failure in `test-results/`.
- **A red CI job**: read which step failed first. A step past its own limit says so (`The action 'Install Playwright browsers' has timed out after 20 minutes.`): that one is usually the runner's Ubuntu package mirror, met mostly when the job's cache of the browsers' system packages missed (a new runner image or Playwright version); re-run the job once. A `Local Supabase stack` warning on the run means the first `supabase start` failed and the second worked; that step's log prints what held the stack's ports.
- **UI mode**: run `npm run e2e:web:ui` for a step-through debugger with live browser preview.

### Writing new tests

Add `*.spec.ts` files under `e2e/web/`. Use `getByTestId`, `getByRole`, or `getByText` locators. Prefer `testID` props on React Native components -- they become `data-testid` attributes on web automatically.

`page.route` never sees a request a service worker makes itself. The app's worker (`public/sw.js`) lets only URLs that contain `supabase.co` past it, so a local run blocks it (`serviceWorkers` in `playwright.config.ts`) and the app reaches the stack from the page, as it reaches the hosted project in production. On the hosted target the worker runs: once it controls the page, a route sees Supabase's requests and nothing else.

Before typing after a React Native `Modal` closes, wait for that modal to detach with `waitForModalToClose(page, testId)` from `helpers/test-accounts.ts`: on web the closing modal keeps its focus trap for its 250 ms slide-out, and a `fill()` in that window lands in the closing modal instead of its target.

Each spec should clean up after itself (delete any accounts/transactions it creates) so the test user stays clean across runs. Deleting is local-first, so end the spec with `deleteAccountAndWaitForPush(page, name)` from `helpers/test-accounts.ts` rather than a bare click on `Delete <name>`: it waits for the sidebar sync label to read exactly `Synced`, which is when the tombstone has actually been pushed. A spec that returns on the click closes the browser before the push runs and the account survives on the server.

Failed attempts never reach their cleanup. Against the local stack that costs nothing: the next run has a user of its own. In the shared hosted user, CI's hosted job handles it with `E2E_PURGE_STALE_TEST_ACCOUNTS=1`, which makes `global-setup.ts` tombstone test-prefixed accounts older than 30 minutes through the REST API before signing in (age-gated so a concurrent run's fresh accounts are untouched). Set the same variable with `E2E_TARGET=hosted` to do the same before a hosted run; it needs `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or the legacy `EXPO_PUBLIC_SUPABASE_ANON_KEY`) from `.env.local` or the environment, and signs in with the same key the app builds with (`lib/supabaseKey.ts`). Never run the hosted target on your machine while CI's hosted job runs: `accounts-reorder.spec.ts` purges its own prefix with no age gate.

## Mobile (Maestro)

### Prerequisites

Maestro requires a Java runtime (JDK 17+). If you don't have one:

```bash
brew install --cask zulu@17
```

Install Maestro CLI:

```bash
curl -fsSL "https://get.maestro.mobile.dev" | bash
```

Build the dev client (required once, or after native dependency changes):

```bash
npx expo run:ios
```

### Run tests

**Before running:** an iOS Simulator must be **booted** with the Nestworth dev client installed. Maestro runs against a live simulator -- if none is booted you'll see `You have 0 devices connected`.

```bash
# Boot the Simulator (opens the last-used device)
open -a Simulator

# Verify a device is booted
xcrun simctl list devices booted
```

If the Nestworth dev client isn't on the home screen, run `npx expo run:ios` once to build and install it.

Metro must also be running in a separate terminal since the dev client loads JS over the network:

```bash
# Terminal 1 -- leave running
npx expo start

# Terminal 2 -- credentials load automatically from .env.e2e
npm run e2e:mobile

# Or run a single flow (must export env vars manually)
export $(grep -v '^#' .env.e2e | xargs)
maestro test e2e/mobile/flows/accounts-crud.yaml
```

### How Maestro auth works

The `e2e:mobile` script auto-loads credentials from `.env.e2e`. Authenticated flows use `- runFlow: ../login.yaml` at the top, which reads `${E2E_TEST_EMAIL}` and `${E2E_TEST_PASSWORD}` from env vars and signs in through the UI. The login subscript lives at `e2e/mobile/login.yaml` (outside `flows/` so it isn't picked up as a standalone test). The unauthenticated flows (`smoke.yaml`, `auth-navigation.yaml`) don't need credentials.

### Writing new flows

Add `*.yaml` files under `e2e/mobile/flows/`. Each flow starts with `appId: app.nestworth.ios` and a `---` separator. For authenticated flows, include `- runFlow: ../login.yaml` after `launchApp`. Use `testID` values set in React Native components as `id` selectors.

Reference: [Maestro docs](https://maestro.mobile.dev/docs)

## Test IDs

Both frameworks share the same `testID` props. When adding new interactive elements, include a `testID` prefixed by screen name so both Playwright and Maestro can target them:

```tsx
<TextInput testID="new-txn-payee" ... />
```

- **Web (Playwright)**: `page.getByTestId('new-txn-payee')`
- **iOS (Maestro)**: `- tapOn: { id: "new-txn-payee" }`

Prefix by screen name to avoid collisions across Expo Router's stacked screens (e.g. `sign-in-email`, `sign-up-email`, `accounts-add-btn`, `new-txn-payee`).

The header buttons are the exception on iOS (#249): the system draws them as native items, which take no `testID`, so the flows tap them by their accessibility label -- on iOS Maestro's `text` selector matches an element's accessibility label (the whole label, ignoring case): `- tapOn: { text: 'New account' }`, `'New transaction'`, `'New transfer'`, `'Cancel'`. Web and the desktop app keep the drawn buttons and their testIDs (`accounts-add-btn`, `register-add-btn`, `register-transfer-btn`), which the Playwright specs press. The labels are in `components/HeaderActions.ios.tsx`; `lib/__tests__/headerActions.test.ts` holds the flows to them. A label also matches a title of the same words in any case (the New Account modal's "New Account", the New Transaction sheet's "New Transaction"), so after a form saves, wait for it to close -- `extendedWaitUntil: notVisible:` on its save button's testID (`accounts-create-btn`, `new-txn-save`) -- before the next label tap. A `visible:` wait on the new card's testID is not enough on its own: the New Account modal closes once the save has stored the account, so the card shows while the sliding modal is still on screen over it.

## Next steps

- **Visual regression**: add Playwright snapshot assertions (`expect(page).toHaveScreenshot()`) for key screens.
- **Mobile CI**: an `e2e-mobile` job on `macos-latest` in `.github/workflows/test.yml` (the web suite already runs there: `Playwright (web)` on the local stack, `Playwright (hosted)` after a merge to `main`).
- **Android**: Maestro supports Android out of the box. Add an `npx expo run:android` build step and run the same `e2e/mobile/flows/` against it (the `appId` directive at the top of each flow file may need to switch from the iOS bundle id to the Android package name).

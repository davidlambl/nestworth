# End-to-End Testing

Nestworth uses two E2E frameworks:

| Suite | Tool | Specs live in | Platform | Runs on |
| --- | --- | --- | --- | --- |
| Web | Playwright | `e2e/web/*.spec.ts` | PWA | Any OS |
| Mobile | Maestro | `e2e/mobile/flows/*.yaml` | Native (iOS today, Android-ready) | macOS |

`e2e/mobile/` also holds the Maestro `config.yaml` plus shared subroutines (`login.yaml`, `cleanup-test-accounts.yaml`) referenced via `- runFlow: ../<name>.yaml` from inside flow files.

## Test user setup (one-time)

Authenticated tests require a dedicated Supabase user:

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
npm install # installs @playwright/test
npx playwright install --with-deps chromium webkit
```

### How it works

Playwright's `globalSetup` (`e2e/web/global-setup.ts`) runs before all specs:
1. Signs in through the real UI using credentials from `.env.e2e`
2. Dismisses onboarding if it appears
3. Saves the session to `e2e/web/.auth/user.json`

Authenticated specs (`chromium` and `webkit-mobile` projects) load this saved session via `storageState`, so they start already signed in. Unauthenticated specs (`smoke.spec.ts`, `auth.spec.ts`) run in a separate project with no stored session.

### Run tests

```bash
npm run e2e:web           # headless, all projects
npm run e2e:web:ui        # interactive UI mode
npm run e2e:web:report    # open the last HTML report
```

Playwright will auto-start the Expo web dev server on port 8081 if it is not already running. The first launch takes ~30 seconds while Metro bundles.

### Debugging failures

- **Trace Viewer** (best): traces are captured on first retry. Open with `npx playwright show-trace test-results/<test>/trace.zip`.
- **Screenshots/video**: saved on failure in `test-results/`.
- **UI mode**: run `npm run e2e:web:ui` for a step-through debugger with live browser preview.

### Writing new tests

Add `*.spec.ts` files under `e2e/web/`. Use `getByTestId`, `getByRole`, or `getByText` locators. Prefer `testID` props on React Native components -- they become `data-testid` attributes on web automatically.

Each spec should clean up after itself (delete any accounts/transactions it creates) so the test user stays clean across runs.

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

Add `*.yaml` files under `e2e/mobile/flows/`. Each flow starts with `appId: com.nestworth.app` and a `---` separator. For authenticated flows, include `- runFlow: ../login.yaml` after `launchApp`. Use `testID` values set in React Native components as `id` selectors.

Reference: [Maestro docs](https://maestro.mobile.dev/docs)

## Test IDs

Both frameworks share the same `testID` props. When adding new interactive elements, include a `testID` prefixed by screen name so both Playwright and Maestro can target them:

```tsx
<TextInput testID="new-txn-payee" ... />
```

- **Web (Playwright)**: `page.getByTestId('new-txn-payee')`
- **iOS (Maestro)**: `- tapOn: { id: "new-txn-payee" }`

Prefix by screen name to avoid collisions across Expo Router's stacked screens (e.g. `sign-in-email`, `sign-up-email`, `accounts-add-btn`, `new-txn-payee`).

## Next steps

- **Visual regression**: add Playwright snapshot assertions (`expect(page).toHaveScreenshot()`) for key screens.
- **CI integration**: add a `e2e-web` job on `ubuntu-latest` and a `e2e-ios` job on `macos-latest` to `.github/workflows/test.yml`. Store test credentials as GitHub Actions secrets.
- **Android**: Maestro supports Android out of the box. Add an `npx expo run:android` build step and run the same `e2e/mobile/flows/` against it (the `appId` directive at the top of each flow file may need to switch from the iOS bundle id to the Android package name).

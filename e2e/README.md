# End-to-End Testing

Nestworth uses two E2E frameworks:

| Suite | Tool | Platform | Runs on |
| ----- | ---------- | -------- | ------- |
| Web | Playwright | PWA | Any OS |
| iOS | Maestro | Native | macOS |

## Web (Playwright)

### Prerequisites

```bash
npm install # installs @playwright/test
npx playwright install --with-deps chromium webkit
```

### Run tests

```bash
npm run e2e:web           # headless, all browsers
npm run e2e:web:ui        # interactive UI mode
npm run e2e:web:report    # open the last HTML report
```

Playwright will auto-start the Expo web dev server on port 8081 if it is not already running. The first launch takes ~30 seconds while Metro bundles.

### Debugging failures

- **Trace Viewer** (best): traces are captured on first retry. Open with `npx playwright show-trace test-results/<test>/trace.zip`.
- **Screenshots/video**: saved on failure in `test-results/`.
- **UI mode**: run `npm run e2e:web:ui` for a step-through debugger with live browser preview.

### Writing new tests

Add `*.spec.ts` files under `e2e/web/`. Use `getByTestId`, `getByRole`, or `getByText` locators. Prefer `testID` props on React Native components — they become `data-testid` attributes on web automatically.

## iOS (Maestro)

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

Metro must be running in a separate terminal since the dev client loads JS over the network:

```bash
# Terminal 1 — leave running
npx expo start

# Terminal 2
npm run e2e:ios                           # all flows
maestro test .maestro/flows/smoke.yaml    # single flow
```

Make sure the iOS Simulator is booted with the Nestworth dev client installed before starting tests.

### Writing new flows

Add `*.yaml` files under `.maestro/flows/`. Each flow starts with `appId: com.nestworth.app` and a `---` separator. Use `testID` values set in React Native components as `id` selectors.

Reference: [Maestro docs](https://maestro.mobile.dev/docs)

## Test IDs

Both frameworks share the same `testID` props. When adding new interactive elements, include a `testID` so both Playwright and Maestro can target them:

```tsx
<TextInput testID="email-input" ... />
```

- **Web (Playwright)**: `page.getByTestId('email-input')`
- **iOS (Maestro)**: `- assertVisible: { id: "email-input" }`

## Next steps

- **Authenticated flows**: create a seeded Supabase test project. For Playwright, use `storageState` to reuse a signed-in session. For Maestro, set env vars in a `.env.e2e` file.
- **Visual regression**: add Playwright snapshot assertions (`expect(page).toHaveScreenshot()`) for key screens.
- **CI integration**: add a `e2e-web` job on `ubuntu-latest` and a `e2e-ios` job on `macos-latest` to `.github/workflows/test.yml`.
- **Android**: Maestro supports Android out of the box. Add `npx expo run:android` build step and run the same `.maestro/flows/` against it.

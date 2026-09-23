# Nestworth

Cross-platform personal finance tracker for iOS, web, and macOS (a signed, notarized Electron app distributed as a `.dmg`). Manage accounts, track transactions, capture receipts, and sync across devices.

## Features

- **Multi-account management** -- Checking, savings, credit card, cash, and other account types with customizable emoji icons; archive retired accounts to hide them from the list and totals without losing their history
- **Transaction register** -- POS-style auto-decimal amount entry, pending/cleared status toggle, running balance with cleared/outstanding breakdown
- **Transfers** -- Move funds between accounts with linked transactions
- **Recurring rules** -- Schedule weekly, biweekly, monthly, quarterly, or yearly transactions
- **Receipt capture** -- Attach photos from camera or gallery to transactions, stored in Supabase Storage
- **CSV import/export** -- Import transactions from other apps with auto-detected column mapping; export all transactions as CSV
- **Reports** -- Spending summaries by period with top payees breakdown
- **Net balance control** -- Include or exclude individual accounts from the headline balance
- **Local-first** -- SQLite is the primary data store; every read and write hits the local database, so the app is fully usable offline and syncs to the cloud in the background
- **PWA** -- Installable as a desktop app via web manifest and service worker
- **macOS app** -- Signed and notarized `.dmg` built with Electron, with a native menu, `Cmd+E` CSV export, and native save dialog
- **Theming** -- Light, dark, and system-follow modes with small/medium/large font size preference
- **Biometric lock** -- Optional Face ID / Touch ID gate on iOS
- **Responsive layout** -- Bottom tabs on mobile, collapsible sidebar on desktop

## Tech Stack

| Layer      | Technology                                                              |
| ---------- | ----------------------------------------------------------------------- |
| Framework  | Expo SDK 54, React Native 0.81, React 19                                |
| Routing    | Expo Router (file-based, typed routes)                                  |
| Backend    | Supabase (PostgreSQL, Auth, Realtime, Storage)                          |
| Data store | expo-sqlite (WAL), with a custom push/pull sync engine                  |
| UI state   | TanStack Query, reading from SQLite                                     |
| Desktop    | Electron + electron-builder (arm64, hardened-runtime, notarized `.dmg`) |
| Language   | TypeScript 5.9                                                          |

## Project Structure

```
app/
  (auth)/              Sign-in and sign-up screens
  (tabs)/              Tab navigator: accounts, reports, settings
    _layout.tsx        Responsive tabs/sidebar layout
    index.tsx          Accounts list with emoji picker
    reports.tsx        Spending reports
    settings.tsx       Theme, font size, export, biometric lock
  account/
    [id].tsx           Transaction register for a single account
    all.tsx            Combined register across all accounts
  transaction/
    new.tsx            New transaction form
    [id].tsx           Edit transaction form
    transfer.tsx       Transfer between accounts
  import.tsx           CSV import wizard
  recurring/           Recurring rule management
  +html.tsx            Custom HTML shell (PWA manifest, service worker)
  _layout.tsx          Root layout (auth gate, providers)

lib/
  auth.tsx             Auth context and session management
  supabase.ts          Supabase client initialization
  db.ts                SQLite schema and connection (primary data store)
  sync.ts              Push/pull sync engine (Supabase <-> SQLite)
  syncStatus.ts        Sync state exposed to the UI
  query.tsx            TanStack Query client and sync orchestration
  theme.tsx            Theme and font size context provider
  types.ts             TypeScript interfaces (Account, Transaction, etc.)
  mappers.ts           Supabase row to app model mappers
  format.ts            Currency formatting
  csvImport.ts         CSV parser with column auto-detection
  register.ts          Register maths: filtering, running balances, payees
  transactionUpdate.ts Atomic transaction edit (incl. paired transfer leg)
  transferLink.ts      Transfer pairing helpers
  exportTransactions.ts CSV export (shared by web, native, and Electron)
  hooks/
    useAccounts.ts     Account CRUD, reordering, balance computation
    useTransactions.ts Transaction CRUD with optimistic updates
    useRecurringRules.ts Recurring rule management
    useRealtimeSync.ts Supabase Realtime subscriptions
    useReceiptPhoto.ts Photo capture and upload
    useBiometricLock.ts Face ID / Touch ID integration

components/
  Sidebar.tsx          Desktop sidebar navigation
  Onboarding.tsx       First-run onboarding flow
  useColorScheme.ts    Theme-aware color scheme hook

supabase/migrations/   SQL migrations (run in order)
public/                PWA assets (manifest, service worker, icons)

electron/
  src/
    main.ts            Electron main: window, in-process static server, lifecycle
    server.ts          Loopback HTTP server over dist/ (fixed port, SPA fallback)
    menu.ts            Application menu (File / Edit / View / Window / Help)
    ipc.ts             IPC handlers (csv:save → native save dialog)
    preload.ts         contextBridge exposing window.electronAPI
  resources/icon.icns  macOS app icon
  tsconfig.json
electron-builder.yml   arm64 hardened-runtime .dmg config
```

## Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
- Apple Developer account (for iOS device builds and the notarized macOS app)

## Getting Started

1. **Clone and install**

```bash
git clone <repo-url> && cd nestworth
npm ci
```

1. **Configure environment**

Create `.env.local` in the project root:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

1. **Run database migrations**

In the Supabase SQL Editor, run each migration file in order:

- `supabase/migrations/001_initial.sql` -- Tables, indexes, RLS policies, realtime
- `supabase/migrations/002_drop_categories.sql` -- Remove categories feature
- `supabase/migrations/003_account_icon.sql` -- Add emoji icon column to accounts
- `supabase/migrations/004_exclude_from_total.sql` -- Add exclude-from-total flag
- `supabase/migrations/005_tombstones.sql` -- Soft-delete tombstones, cascade triggers, missing indexes, `purge_tombstones()`
- `supabase/migrations/006_split_updated_at.sql` -- `updated_at` on transaction splits, maintained by a trigger
- `supabase/migrations/007_schedule_purge_tombstones.sql` -- Enables `pg_cron` and runs `purge_tombstones()` weekly

> **Run `005_tombstones.sql` before deploying a client build that includes tombstones.** Against the old schema the new client's delete path fails and local deletes stay queued forever. Upgrading in the other order is safe: an old client on the new schema keeps working.

From `005_tombstones.sql` on, a migration can also be applied from **Actions → Database migration → Run workflow** (`.github/workflows/migrate.yml`). It needs one repository secret, `SUPABASE_DB_URL`, holding the project's **Session pooler** connection string (Project Settings → Database -- the direct string is IPv6-only and GitHub's runners are IPv4). It applies one file inside a single transaction, so a failure leaves the database untouched. Files 001–004 predate it and are refused there: they were applied by hand and are not safe to run twice. Nothing applies migrations on push, on purpose -- see the TestFlight section for why the order has to be a person's decision.

1. **Start development**

```bash
npx expo start             # Expo dev server
npx expo start --web       # Web only
npx expo run:ios           # iOS device/simulator
npm run electron:dev       # macOS desktop app (Electron)
npm run electron:build     # Signed/notarized .dmg (see "macOS app" below)
```

## Testing

Unit tests use Jest (`npm test`). End-to-end tests cover web (Playwright) and mobile (Maestro — iOS today, Android-ready):

```bash
npm run e2e:web       # Playwright — launches Expo web automatically
npm run e2e:mobile    # Maestro — requires a booted simulator with the dev client
```

See [`e2e/README.md`](./e2e/README.md) for setup, debugging, and writing new tests. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for architecture deep-dives, code conventions, and what to add when making changes.

## Database Schema

Four core tables, all protected by Row Level Security scoped to `auth.uid()`:

| Table                | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `accounts`           | User accounts with type, icon, balance, sort order, exclude-from-total flag      |
| `transactions`       | Individual debits/credits linked to an account, with status and optional receipt |
| `transaction_splits` | Line-item splits within a transaction                                            |
| `recurring_rules`    | Scheduled transaction templates with frequency and next-date                     |

Realtime is enabled on all tables. An `update_updated_at` trigger keeps timestamps current on accounts, transactions, and recurring rules.

## iOS app

The iOS app is an Expo managed build. **No over-the-air updates are configured**, so a new version is a native rebuild: installed over USB from a Mac (next section), or built on Expo's cloud and delivered through TestFlight (the section after). There is no OTA channel: every change ships as a fresh install.

### Production build to a physical iPhone

Prerequisites (beyond [Getting Started](#getting-started)): Xcode installed, an Apple Developer account signed into it, and the iPhone connected over USB (trust the computer when prompted; wireless works once the device has been paired in Xcode). The signing team is already set as `appleTeamId` in `app.json`.

1. Ensure `.env.local` holds the **production** Supabase URL + anon key -- `EXPO_PUBLIC_*` values are inlined into the bundle at build time.
1. Build the optimized Release configuration and install it to the connected device:

   ```bash
   npx expo run:ios --device --configuration Release
   ```

   `--device` prompts for the connected iPhone (append a name to skip the prompt, e.g. `--device "David's iPhone"`). `--configuration Release` embeds the JS bundle so the app runs standalone -- unlike the default `npm run ios` dev build, it does not need the Metro dev server running.

1. On the first install signed with a new certificate, trust it on the phone under **Settings → General → VPN & Device Management → Developer App**.

Build from an up-to-date `main` so the install carries the latest fixes. Confirm what's running in the app's **Settings** screen -- the footer shows the running app version (the _Nestworth vX.Y.Z_ line).

Equivalent in Xcode: open `ios/*.xcworkspace`, select the device, and **Product → Run** (or **Product → Archive** to export an `.ipa`).

### TestFlight, without a Mac

The build runs on Expo's macOS machines and the upload to TestFlight is an API call, so a release can be cut from a phone. It is a manual GitHub Actions workflow (`.github/workflows/testflight.yml`), deliberately not tied to push: a build that carries a schema change has to follow the database migration, and only a person can order those two.

One-time setup, all of it in a browser:

1. **Expo.** The project is already linked (`owner` and `extra.eas.projectId` in `app.json`). On the project's **Environment variables** page, add `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` to the `production` environment -- `.env.local` never reaches the build machines, and a build without them installs fine and then fails at first launch. Then create an **access token** under your account settings.
1. **App Store Connect.** Users and Access → Integrations → App Store Connect API → generate a key with the **Admin** role. EAS uses it to create the distribution certificate and provisioning profile on the first build, and App Manager cannot create certificates. Download the `.p8` immediately (Apple offers it exactly once) and note the Key ID and the Issuer ID shown on the same page.
1. **GitHub.** Add four repository secrets: `EXPO_TOKEN`, `ASC_API_KEY_P8` (the whole contents of the `.p8` file), `ASC_KEY_ID`, and `ASC_ISSUER_ID`.
1. **The App Store Connect app record.** My Apps → + → New App, choosing the bundle identifier from `app.json`. This one step cannot be automated: creating an app record needs an Apple ID login, and an API key cannot supply one. Take the numeric **Apple ID** from the new app's App Information page and put it in `eas.json` as `submit.production.ios.ascAppId` — without it a non-interactive submission stops with "Set ascAppId in the submit profile".

Every release after that is **Actions → TestFlight → Run workflow**, which takes a mode: build a new version and submit it, or submit the last one that finished building. The second exists because a build whose submission failed is otherwise stranded, and builds are rationed monthly on the free tier. The build number is assigned by EAS (`appVersionSource: remote` in `eas.json`), so `app.json` never needs a bump for TestFlight to accept an upload; change `version` there when the marketing version should move. The first run also creates the App Store Connect app record. On Expo's free tier builds queue at low priority, so expect the job to wait before it builds.

If `eas build` stops with an `owner` mismatch, the organization slug was edited away from its default when the Expo project was created: set `owner` in `app.json` to the slug the error names.

## PWA

The web build is installable as a Progressive Web App:

- `public/manifest.json` -- App name, icons, theme color, standalone display
- `public/sw.js` -- Service worker with network-first caching (excludes Supabase requests)
- `app/+html.tsx` -- Links the manifest, registers the service worker, sets meta tags (service worker is suppressed inside Electron)

## macOS app

Nestworth has three Mac stories, in increasing order of "feels native":

1. **PWA** -- install the web build from a browser
2. **Designed for iPad** -- on Apple Silicon, the iOS build runs unchanged via UIKit compatibility (no extra work; appears automatically as a run destination in Xcode)
3. **Electron desktop app** -- a signed, notarized `.dmg` with a desktop-shaped window, native menu, and native save dialogs

The Electron build wraps the existing Expo static web bundle. The main process boots an in-process loopback HTTP server over `dist/` and points a `BrowserWindow` at it, which preserves absolute asset URLs and gives the renderer a stable origin so `localStorage` persists Supabase sessions across launches. A preload script exposes a narrow `window.electronAPI` (just CSV save + a menu-export listener); renderer navigation is locked to the local origin and off-origin links are routed to `shell.openExternal`.

Dev launch (no signing, opens a window straight from the export):

```bash
npm run electron:dev       # exports the web bundle, compiles main, opens a window
```

### Build and install the desktop app

A release is these three commands, run from the repo on a Mac (the app is built for Apple Silicon only -- `arch: arm64` in `electron-builder.yml`):

```bash
git checkout main && git pull                          # build from an up-to-date main
npm ci                                                 # only if the pull changed package-lock.json
APPLE_KEYCHAIN_PROFILE=nestworth npm run electron:build
```

The build exports the web bundle, compiles the Electron main process, then packages, signs, notarizes (a few minutes, spent waiting on Apple) and staples the app. It writes `dist-electron/Nestworth-<version>-arm64.dmg` plus the unpacked `dist-electron/mac-arm64/Nestworth.app`.

Before you start:

- **Quit Nestworth if it is running.** The build rewrites `dist-electron/`, which is where the app runs from if you launched it from the build folder.
- **`.env.local` must hold the production Supabase URL and anon key.** `EXPO_PUBLIC_*` values are inlined into the bundle at build time, as for the iOS build.
- **`npm ci` is only needed when dependencies changed.** If the pull's summary lists `package-lock.json`, run it (it recompiles `better-sqlite3`, so allow a minute); otherwise skip it.
- **To release a new version**, cut it on `main` once the changes have merged, then build:

  ```bash
  git checkout main && git pull
  npm version 1.2.0 -m "chore: release %s"   # or: npm version patch
  git push --follow-tags origin main
  ```

  `npm version` bumps `package.json` and the lockfile (where the `.dmg` file name comes from), runs `scripts/sync-app-version.js` to mirror the number into `app.json` (what the app's Settings footer and EAS read), and makes a single commit tagged `vX.Y.Z`. It refuses to run on a dirty tree. It goes on `main` rather than in a PR because a tag made on a branch does not survive the squash-merge.

#### One-time setup, per Mac

Store the notarization credentials in the login keychain under the profile name the build command references:

```bash
xcrun notarytool store-credentials nestworth \
  --apple-id "you@example.com" --team-id P9KK9LA3ZV
```

It prompts once for an app-specific password (created in your Apple Account settings) and keeps it in the keychain, so the password never has to live in an environment variable, a shell history, or a dotfile. The team ID is the `appleTeamId` already in `app.json` -- a public identifier, embedded in every signed binary, not a secret. To confirm the profile exists later, use `xcrun notarytool history --keychain-profile nestworth` (`security find-generic-password` does not find it). electron-builder also accepts `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` as environment variables, but an exported password is readable by every child process of that shell -- prefer the keychain profile.

#### Verify, then install

```bash
spctl --assess --type execute -vv dist-electron/mac-arm64/Nestworth.app
```

It must print `accepted` with `source=Notarized Developer ID`. If no credentials were found, electron-builder logs `skipped macOS notarization` and still emits a signed `.dmg`: that build runs on this Mac but Gatekeeper blocks it on any other, and `spctl` will not say `Notarized`. A green build is not proof.

Install by opening the `.dmg` and dragging Nestworth to Applications (replacing the previous copy), or run `dist-electron/mac-arm64/Nestworth.app` directly. The app's data -- the Supabase session and the local database -- lives in `~/Library/Application Support/nestworth` and survives reinstalling. Confirm what is running in **Settings**: the footer shows the version from `app.json`.

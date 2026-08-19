# Nestworth

Cross-platform personal finance tracker for iOS, web, and macOS (a signed, notarized Electron app distributed as a `.dmg`). Manage accounts, track transactions, capture receipts, and sync across devices.

## Features

- **Multi-account management** -- Checking, savings, credit card, cash, and other account types with customizable emoji icons
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

- Node.js 18+
- A [Supabase](https://supabase.com) project
- Apple Developer account (for iOS device builds)

## Getting Started

1. **Clone and install**

```bash
git clone <repo-url> && cd checkbook
npm install
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

The iOS app is a standard Expo managed build -- **no EAS Build and no over-the-air updates are configured**, so a new version is a native rebuild installed directly to the device. There is no OTA channel: every change ships as a fresh install.

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

**Cable-free alternative:** distributing via TestFlight or ad-hoc install links requires EAS Build -- add an `eas.json` and run `eas build -p ios`. That path is not set up in this repo today.

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

Dev launch:

```bash
npm run electron:dev       # exports the web bundle, compiles main, opens a window
```

Signed/notarized build:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="<your-10-char-team-id>"
npm run electron:build     # produces dist-electron/Nestworth-<version>-arm64.dmg
```

(The team ID is the same value already present at `appleTeamId` in `app.json`. It's a public identifier and is also embedded in every signed binary -- not a secret.)

Verify the result: `spctl --assess --type execute dist-electron/mac-arm64/Nestworth.app` should report `accepted source=Notarized Developer ID`.

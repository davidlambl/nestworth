# Nestworth

Cross-platform personal finance tracker for iOS, web, and macOS. Manage accounts, track transactions, capture receipts, and sync across devices.

## Features

- **Multi-account management** -- Checking, savings, credit card, cash, and other account types with customizable emoji icons
- **Transaction register** -- POS-style auto-decimal amount entry, pending/cleared status toggle, running balance with cleared/outstanding breakdown
- **Transfers** -- Move funds between accounts with linked transactions
- **Recurring rules** -- Schedule weekly, biweekly, monthly, quarterly, or yearly transactions
- **Receipt capture** -- Attach photos from camera or gallery to transactions, stored in Supabase Storage
- **CSV import/export** -- Import transactions from other apps with auto-detected column mapping; export all transactions as CSV
- **Reports** -- Spending summaries by period with top payees breakdown
- **Net balance control** -- Include or exclude individual accounts from the headline balance
- **Offline-first** -- Query cache persisted to AsyncStorage; works without connectivity and syncs when back online
- **PWA** -- Installable as a desktop app via web manifest and service worker
- **Theming** -- Light, dark, and system-follow modes with small/medium/large font size preference
- **Biometric lock** -- Optional Face ID / Touch ID gate on iOS
- **Responsive layout** -- Bottom tabs on mobile, collapsible sidebar on desktop

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Expo SDK 54, React Native 0.81, React 19 |
| Routing | Expo Router (file-based, typed routes) |
| Backend | Supabase (PostgreSQL, Auth, Realtime, Storage) |
| Data layer | TanStack Query with AsyncStorage persistence |
| Language | TypeScript 5.9 |

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
  supabaseHelpers.ts   Pagination helpers (fetchAll, batched queries)
  query.tsx            TanStack Query client with offline persistence
  theme.tsx            Theme and font size context provider
  types.ts             TypeScript interfaces (Account, Transaction, etc.)
  mappers.ts           Supabase row to app model mappers
  format.ts            Currency formatting
  csvImport.ts         CSV parser with column auto-detection
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
npx expo start          # Expo dev server
npx expo start --web    # Web only
npx expo run:ios        # iOS device/simulator
```

## Testing

Unit tests use Jest (`npm test`). End-to-end tests cover web (Playwright) and mobile (Maestro — iOS today, Android-ready):

```bash
npm run e2e:web       # Playwright — launches Expo web automatically
npm run e2e:mobile    # Maestro — requires a booted simulator with the dev client
```

See [README.md](./e2e/README.md) for setup, debugging, and writing new tests.

## Database Schema

Four core tables, all protected by Row Level Security scoped to `auth.uid()`:

| Table | Purpose |
| --- | --- |
| `accounts` | User accounts with type, icon, balance, sort order, exclude-from-total flag |
| `transactions` | Individual debits/credits linked to an account, with status and optional receipt |
| `transaction_splits` | Line-item splits within a transaction |
| `recurring_rules` | Scheduled transaction templates with frequency and next-date |

Realtime is enabled on all tables. An `update_updated_at` trigger keeps timestamps current on accounts, transactions, and recurring rules.

## PWA

The web build is installable as a Progressive Web App:

- `public/manifest.json` -- App name, icons, theme color, standalone display
- `public/sw.js` -- Service worker with network-first caching (excludes Supabase requests)
- `app/+html.tsx` -- Links the manifest, registers the service worker, sets meta tags

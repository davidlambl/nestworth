# Contributing to Nestworth

This guide describes the architecture, conventions, and testing expectations for anyone making changes to the codebase.

## 1. Architecture

### Local-First SQLite with Supabase Sync

Nestworth is a cross-platform personal finance app (iOS, web PWA, and macOS desktop via Electron) built with Expo SDK 54, React Native 0.81, React 19, and TypeScript 5.9.

- **Primary data store**: `expo-sqlite` (`lib/db.ts`). Single shared DB file `nestworth.db` with WAL journaling. On web, `sql.js` (WASM/IndexedDB) provides the same API.
- **Remote sync**: Supabase (PostgreSQL + Auth + Realtime + Storage). Used for cross-device sync, not as the primary read path.
- **UI reactivity**: TanStack Query reads from SQLite. Mutations write to SQLite first (marking `_sync_status = 'pending'`), then call `requestPush()` to queue a background sync.
- **Routing**: Expo Router with file-based typed routes. `(auth)/` group for sign-in/sign-up, `(tabs)/` for the main app.

### Sync Engine (`lib/sync.ts`)

- **`requestPush`**: Pushes local `pending`/`deleted` rows to Supabase. Serialized via `_syncInProgress` flag with a `_pushQueued` drain mechanism.
- **`fullSync`**: Push then pull. Also drains `_pushQueued` on completion.
- **`initialPull`**: Bootstrap for first login -- fetches all remote data, sets both `last_pull_at` and `last_txn_pull_at`.
- **`pullChanges`**: Full-table pull for accounts/rules (`pullTableFull`) that reconciles deletions AND force-heals any `synced` row whose `updated_at` drifted from the server in either direction (`forceUpsertRemoteAccount`/`forceUpsertRemoteRule`, mirroring the transaction self-heal — relevant because `accounts.initial_balance` feeds every total). Self-healing pull for transactions (`pullTransactions`): an `updated_at > cursor` fast-path, then a reconcile pass that enumerates all remote `(id, updated_at)` and -- via the pure `planTransactionReconcile` -- deletes server-removed rows, pulls rows missing locally, and force-refreshes (`forceUpsertRemoteTransaction`) any `synced` row whose timestamp differs in _either_ direction. This lets a device recover from a server correction whose `updated_at` is _older_ than the device cursor (which the fast-path skips forever).
- **`resetLocalData`**: Recovery escape hatch, surfaced in Settings as "Reset & re-download from cloud" for the rare case the local store drifts past what the reconcile can heal (e.g. an OPFS-backed SQLite file that "Clear site data" won't drop). Holds the `_syncInProgress` lock for the WHOLE operation and uses the lock-free `pushChanges`/`pullChanges` primitives (NOT `fullSync`/`initialPull`), so a background AppState/NetInfo sync can't slip between steps and either race the wipe or hold the lock when the re-bootstrap runs (which would make it a no-op, leaving the device wiped-but-empty). Order: flush pending edits up (and abort if any remain unsynced afterward, so a swallowed push error isn't wiped away), confirm the cloud is reachable BEFORE wiping (an offline reset aborts without touching local data), wipe all local tables + the sync cursor (`wipeLocalData`), then re-download via `pullChanges` in `throwOnError` mode — a failed download surfaces as a failed reset and leaves the cursor unset (→ next-launch re-bootstrap) rather than a silently partial cache.
- **Conflict resolution**: Last-write-wins. Local `ON CONFLICT DO UPDATE ... WHERE _sync_status = 'synced'` protects unsynced local edits from being overwritten by remote data. The transaction reconcile treats the server as authoritative for already-`synced` rows, so it overwrites them regardless of timestamp order -- but still never touches `pending`/`deleted` rows.
- **Sync meta keys**: Scoped by userId (`last_pull_at:${userId}`, `last_txn_pull_at:${userId}`) to support multi-user sign-in on the same device.

### Sync Orchestration (`lib/query.tsx`)

- `useSyncEngine` hook runs inside `SyncProvider` (nested inside `AuthProvider`).
- On user change: resets `initializedRef` to prevent stale listeners from triggering premature sync.
- Triggers: app foreground (`AppState`), network reconnection (`NetInfo`), initial login.

### Data Tables

`accounts`, `transactions`, `transaction_splits`, `recurring_rules` -- all have `_sync_status` (`synced` | `pending` | `deleted`). The `sync_meta` table stores pull timestamps.

### Desktop shell (Electron)

`electron/src/main.ts` is the macOS entry point. It boots an in-process loopback HTTP server (`server.ts`, fixed port 49217 with ephemeral fallback) over `dist/` and points a `BrowserWindow` at it. This preserves absolute asset URLs from `expo export -p web` and gives the renderer a stable origin so `localStorage` (Supabase session, AsyncStorage) persists across launches. The service worker is intentionally suppressed in Electron via a `navigator.userAgent` check in `app/+html.tsx`.

`preload.ts` exposes a deliberately narrow `window.electronAPI` via `contextBridge`: `saveCsv` (round-trips through `ipc.ts`'s `csv:save` handler, which validates `event.senderFrame` origin before showing the save dialog) and `onExportCsv` (menu→renderer event). The menu listener is mounted in `app/(tabs)/_layout.tsx` so `Cmd+E` works from any tab, calling the shared `lib/exportTransactions.ts` helper. Renderer navigation is locked to the local origin in `main.ts` (off-origin links go to `shell.openExternal`).

When adding desktop-only behavior: extend the existing `window.electronAPI` surface rather than enabling `nodeIntegration`. When adding Expo-side code that touches browser-only globals, gate on `Platform.OS === 'web'` (Electron presents as web to React Native) and use `electronAPI` for desktop-specific paths.

## 2. Conventions

- **Style**: PascalCase for components, camelCase for variables/functions, 2-space indent.
- **Naming**: Hook files are `useX.ts`, mapper functions in `lib/mappers.ts`, types in `lib/types.ts`.
- **Soft-delete pattern**: All deletions set `_sync_status = 'deleted'` and `updated_at = now`. Queries filter with `AND _sync_status != 'deleted'`. Push syncs the delete to Supabase then hard-deletes locally.
- **Mutation pattern**: Write to SQLite -> call `requestPush(user!.id)` -> invalidate relevant query keys in `onSuccess`.
- **Query keys**: `['accounts']`, `['transactions', accountId]`, `['transactions', '__all__']`, `['recurring_rules']`, `['transaction', id]`, `['account', id]`, `['reports', userId, period]`.
- **Header buttons**: Use plain `paddingLeft: 16` or `paddingRight: 16` -- no `height: '100%'` (causes misalignment on iOS due to safe area insets).
- **testIDs**: Every interactive element should have a `testID` prop, prefixed by screen name to avoid collisions in Expo Router's Stack (e.g. `sign-in-email`, `sign-up-email`). These become `data-testid` on web and `id` on native.

## 3. Testing

### Overview

| Layer      | Tool             | Location                  | Command              |
| ---------- | ---------------- | ------------------------- | -------------------- |
| Unit       | Jest + jest-expo | `lib/__tests__/*.test.ts` | `npm test`           |
| E2E web    | Playwright       | `e2e/web/*.spec.ts`       | `npm run e2e:web`    |
| E2E mobile | Maestro          | `e2e/mobile/flows/*.yaml` | `npm run e2e:mobile` |

Config files: `jest.config.js`, `playwright.config.ts`. Full E2E setup docs: [`e2e/README.md`](./e2e/README.md).

### Unit tests (Jest)

Existing test files cover pure functions: `format.test.ts`, `mappers.test.ts`, `csvImport.test.ts`, `register.test.ts`, `syncStatusHelpers.test.ts`.

Tests go in `lib/__tests__/`. Jest is configured with `jest-expo` preset and `@/` path alias. The `testPathIgnorePatterns` in `jest.config.js` excludes `e2e/` so Playwright `.spec.ts` files are not picked up.

### E2E web tests (Playwright)

Playwright runs against the Expo web build (Chromium desktop + WebKit mobile emulation). The config auto-starts Metro on port 8081. Specs go in `e2e/web/*.spec.ts`.

**Authentication**: A `globalSetup` script (`e2e/web/global-setup.ts`) signs in via the UI using credentials from `.env.e2e`, dismisses onboarding, and saves the session to `e2e/web/.auth/user.json`. Authenticated specs load this via `storageState`. Unauthenticated specs (`smoke.spec.ts`, `auth.spec.ts`) run in a separate project.

Key patterns:

- Use `getByTestId` with screen-prefixed IDs (e.g. `sign-in-email`) since Expo Router's Stack keeps multiple screens in the DOM simultaneously on web.
- For back-navigation tests where the Stack pushes a new screen instead of popping, use `.last()` to target the topmost instance.
- Use `getByText` and `getByRole` for assertions that don't need testIDs, but beware of duplicate text across stacked screens.
- Each authenticated spec should clean up after itself (delete created accounts/transactions) so the test user stays clean.

### E2E mobile tests (Maestro)

Maestro flows go in `e2e/mobile/flows/*.yaml`. Each flow declares `appId: com.nestworth.app` and uses `id:` selectors matching the `testID` props. Metro must be running in a separate terminal since the dev client loads JS over the network.

**Authentication**: `npm run e2e:mobile` reads `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` from `.env.e2e` and passes them to Maestro.

### What to add when making changes

**For every new feature:**

1. Add a unit test in `lib/__tests__/` for any new pure logic (formatters, parsers, helpers, mappers).
2. Add `testID` props to new interactive elements, prefixed by screen name.
3. Add a Playwright spec in `e2e/web/` covering the primary user flow.
4. Add a Maestro flow in `e2e/mobile/flows/` covering the same flow on mobile.

**For every bug fix:**

1. Add a unit test that reproduces the bug and verifies the fix (regression test).
2. If the bug is UI-visible, add or update a Playwright assertion and/or Maestro step to cover it.

**Running all checks before committing:**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run e2e:web
```

CI runs the same gates on every PR (`.github/workflows/test.yml`): typecheck, lint,
format check, unit tests, a web bundle export, and an Electron main compile. The
Playwright job additionally needs `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`,
`EXPO_PUBLIC_SUPABASE_URL`, and `EXPO_PUBLIC_SUPABASE_ANON_KEY` as repository
secrets; without them that job skips rather than failing.

**Lint severity:** the React Compiler rule family (`react-hooks/set-state-in-effect`,
`static-components`, `refs`, `immutability`, `preserve-manual-memoization`) is set to
`warn` in `eslint.config.js` rather than `error`. Those warnings mark genuine
modernization work across the screens; the intent is to fix them and ratchet the rules
up to `error`, not to leave them muted forever.

**Local database backups live outside the repo,** at `~/nestworth-backups`. They
contain real account and transaction data, so they are deliberately kept out of the
project directory rather than merely gitignored -- a gitignore does not protect against
archives, editor indexing, or `git add -f`. `backups/` remains in `.gitignore` as a
safety net in case a script recreates it.

**Gotcha -- stale native module after a Node upgrade:** `better-sqlite3` (used by the
sync unit tests) is compiled against a specific `NODE_MODULE_VERSION`. After changing
Node versions locally the suite fails with `Cannot read properties of undefined
(reading '_sqlite')`. Fix with `npm rebuild better-sqlite3`. CI is unaffected because
it installs fresh against the Node version in `.nvmrc`.

## 4. Known Issues & Gotchas

- **Deploys are forward-only once a new migration ships.** `runMigrations` refuses to
  open a database whose `user_version` is newer than the running build
  (`lib/migrations.ts`) — correct, since the older code would write rows against a
  schema it does not understand. The consequence is operational: rolling the web
  deploy back across a migration makes every returning browser hit that guard,
  because the OPFS database is not rolled back with the bundle. Roll forward instead.
- **Clock skew can briefly defer deletion reconcile for rows this device just pushed.**
  Since push adopts the server's `updated_at`, a synced row carries SERVER time while
  the pull's `pullStartedAt` snapshot is CLIENT time. If the client clock is behind by
  δ, a row this device pushed looks "created mid-pull" for up to δ and is excluded from
  the reconcile pass, so a remote deletion of it is skipped until the clock catches up.
  Self-corrects; the durable fix is a local monotonic marker instead of comparing
  server-stamped timestamps against the client clock.
- **A second browser tab can lose the migration write lock.** Two tabs opening the same
  OPFS database can race; the loser gets `database is locked`. `getDb()` drops a rejected
  init promise so the next call retries rather than poisoning the session (`lib/db.ts`).
- **`useReceiptPhoto.ts` uses `require()` imports** for `getDb` and `requestPush` instead of top-level ES imports. This was likely done to avoid circular dependencies but is fragile.
- **Transaction split sync is delete-then-reinsert**: The push logic deletes all remote splits for a transaction, then reinserts from local. This is not atomic -- if the process is interrupted between delete and insert, remote splits are lost (mitigated by keeping local copies as `'pending'` on failure).
- **`pullTransactions` reconcile fetches all remote `(id, updated_at)` every sync**: Required for both deletion detection and drift self-healing, but adds overhead for very large histories. A soft-delete column plus a server-side change feed on Supabase would allow incremental detection instead.
- **Reconcile treats an empty remote enumeration as authoritative**: if the remote read returns zero rows _without_ an error (e.g. a misconfigured RLS policy), the reconcile deletes all local `synced` rows for that table. A hard error already bails the pass safely; a clean-but-empty response does not. In practice an expired session returns an error (not empty), so this is a latent edge rather than an observed failure — a follow-up could require a non-empty enumeration before honoring deletions.
- **Split corrections that don't bump the parent `updated_at` won't refresh**: split sync piggybacks on the parent transaction landing in the pulled/refreshed set, and `transaction_splits` has no `updated_at` of its own. Editing splits through the app always bumps the parent, so this only affects out-of-band/server-side split edits. (Split refresh fetches the remote copy _before_ deleting the local one, so a failed fetch never drops local splits.)
- **No schema migration system**: `lib/db.ts` uses `CREATE TABLE IF NOT EXISTS`. Adding columns later will require manual `ALTER TABLE` migration logic.
- **`expo-sqlite` web support**: Uses `sql.js` with IndexedDB/OPFS. Data durability on web is less guaranteed than native SQLite -- browser storage can be evicted. The OPFS-backed DB also survives DevTools "Clear site data" in Chromium, so a corrupted local store must be reset via Settings → "Reset & re-download from cloud" (`resetLocalData`) or by deleting the app's storage directory.
- **Expo Router Stack on web**: `<Link>` pushes new screens rather than replacing, so the DOM accumulates stacked screens. Tests must account for duplicate elements. Maestro on native does not have this issue since the Stack only renders the topmost screen.
- **Expo dev server `Cannot pipe to a closed or destroyed stream`**: Benign race condition in `expo-server` when Playwright disconnects before the response stream finishes. Does not affect test results.

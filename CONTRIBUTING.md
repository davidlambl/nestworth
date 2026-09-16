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

- **`requestPush`**: Pushes local `pending`/`deleted` rows to Supabase. Serialized by the `_syncInProgress` lock. A request that finds the lock held is queued (`_pushQueued`, or `_fullSyncQueued` for `fullSync`/`initialPull`) and every lock holder ends in `finishSync`, which drains the queue with the lock-free primitives, refreshes the pending count, and only then publishes `isSyncing=false` and releases the lock -- so nothing requested mid-sync is ever dropped, and the label reads `Synced` only when the count is fresh and zero. A `deleted` row is pushed as a **tombstone**, not a hard delete: `update({ deleted_at })` filtered by `.is('deleted_at', null)` so a retry or a server-side cascade never re-stamps (and so never re-broadcasts) a row that is already dead. Zero matched rows is success — never pushed, already purged, or already tombstoned all mean "the server agrees it's gone" — and falls through to the local hard delete. `transaction_splits` has no tombstone of its own: splits ride their parent and stay hard-deleted. Deleting an account only tombstones the account; server triggers cascade the stamp to its transactions and rules (`005_tombstones.sql`), though the client still pushes child tombstones itself rather than depending on them. A child written into an account that was _already_ tombstoned is REJECTED by the server with `23503` rather than stamped dead, which is what keeps an offline-created row alive -- see the born-dead note in Known Issues. If a push fails because the server is missing `deleted_at` entirely, `pushChanges` reports it once through `setLastError` instead of retrying in silence.
- **`fullSync`**: Push then pull. If a sync is already in flight it queues a full sync and awaits the holder (which drains it before releasing) instead of silently returning, so `syncNow` and sign-out get the sync they asked for.
- **`initialPull`**: Bootstrap for first login (if a sync already holds the lock it queues a full sync instead -- with unset cursors an equivalent bootstrap -- and awaits it) -- fetches all remote data (live rows only; tombstones are never downloaded), and sets all three meta keys **from a snapshot taken before the first remote read**, never from an end-of-pull `now` (a bootstrap of a large history spans many round trips, and stamping the later time declares that whole window pulled), including `last_txn_reconcile_at` so a fresh device does not immediately re-enumerate what it just downloaded.
- **`pullChanges`**: Full-table pull for accounts/rules (`pullTableFull`) that reconciles deletions AND force-heals any `synced` row whose `updated_at` drifted from the server in either direction (`forceUpsertRemoteAccount`/`forceUpsertRemoteRule`, mirroring the transaction self-heal — relevant because `accounts.initial_balance` feeds every total). These tables stay full-table because they are tiny; the read partitions into live rows (which upsert as before) and tombstoned rows (which route to a scoped local delete). Self-healing pull for transactions (`pullTransactions`) is two passes:
  1. **Incremental, every sync**: `updated_at > cursor`. Because a delete is now an ordinary `UPDATE` that stamps `deleted_at`, this pass sees deletions too — a tombstoned row routes to a scoped local delete (splits first) instead of an upsert, and never enters the pulled/touched sets. This is the whole point of tombstones: per-sync cost is proportional to what changed, not to total history.
  2. **Periodic reconcile, at most once per `RECONCILE_INTERVAL_MS` (24h)**, gated on the `last_txn_reconcile_at:${userId}` meta key. Enumerates all remote `(id, updated_at, deleted_at)` -- tombstones included, deliberately -- and treats a tombstoned row as absent. It counts RAW rows separately from live ones so "the server says everything is deleted" stays distinguishable from "the read returned nothing"; filtering server-side would collapse the two and the #19 guard would then refuse the honest answer forever. It -- via the pure `planTransactionReconcile` -- deletes server-removed rows, pulls rows missing locally, and force-refreshes (`forceUpsertRemoteTransaction`) any `synced` row whose timestamp differs in _either_ direction. This is what lets a device recover from a server correction whose `updated_at` is _older_ than the device cursor (which the fast-path skips forever), and from a tombstone that was purged before the device ever pulled it. The key only advances after a pass actually completes — not on error, and not on the empty-enumeration skip — so a misconfigured RLS policy keeps retrying rather than going quiet for 24h. **An empty remote read is never authoritative**: `planTransactionReconcile` returns no deletions unless the caller confirms the enumeration actually came back with rows (`remoteReadReturnedRows`), and `pullTableFull` mirrors that check on its own read, so a clean-but-empty response (a broken RLS policy, say) can never wipe the local store. The cursor is subject to the same rule: `last_txn_pull_at` is only advanced when the incremental pass actually read, since banking it over an unread window would hide those changes from `gt('updated_at', cursor)` permanently now that the reconcile is only a daily backstop.
- **`resetLocalData`**: Recovery escape hatch, surfaced in Settings as "Reset & re-download from cloud" for the rare case the local store drifts past what the reconcile can heal (e.g. an OPFS-backed SQLite file that "Clear site data" won't drop). Holds the `_syncInProgress` lock for the WHOLE operation and uses the lock-free `pushChanges`/`pullChanges` primitives (NOT `fullSync`/`initialPull`), so a background AppState/NetInfo sync can't slip between steps and either race the wipe or hold the lock when the re-bootstrap runs (which would make it a no-op, leaving the device wiped-but-empty). Order: flush pending edits up (and abort if any remain unsynced afterward, so a swallowed push error isn't wiped away), confirm the cloud is reachable BEFORE wiping (an offline reset aborts without touching local data), wipe all local tables + the sync cursor (`wipeLocalData`), then re-download via `pullChanges` in `throwOnError` mode — a failed download surfaces as a failed reset and leaves the cursor unset (→ next-launch re-bootstrap) rather than a silently partial cache.
- **Conflict resolution**: Last-write-wins, except that **delete wins over a concurrent edit**. Local `ON CONFLICT DO UPDATE ... WHERE _sync_status = 'synced'` protects unsynced local edits from being overwritten by remote data. The transaction reconcile treats the server as authoritative for already-`synced` rows, so it overwrites them regardless of timestamp order -- but still never touches `pending`/`deleted` rows. When a pending edit lands on a row another device tombstoned, the edit applies but the tombstone survives (PostgREST only sets the keys in the payload, and `deleted_at` is never one of them), so the push read-back sees `deleted_at` set and drops the row locally instead of marking it synced. The alternative -- edit wins -- resurrects a row the user already deleted, which is exactly what the old hard-delete push did.
- **Sync meta keys**: Scoped by userId (`last_pull_at:${userId}`, `last_txn_pull_at:${userId}`, `last_txn_reconcile_at:${userId}`) to support multi-user sign-in on the same device. `wipeLocalData` clears `sync_meta`, so a reset forces a fresh reconcile.

### Sync Orchestration (`lib/query.tsx`)

- `useSyncEngine` hook runs inside `SyncProvider` (nested inside `AuthProvider`) and calls `startSyncSession` from `lib/sync.ts`: open the DB, `initialPull` if this device has never pulled, then one `fullSync`.
- Keyed on the user **id**, not the `User` object: auth-js emits a fresh object on every auth event, and keying on it tore the engine down mid-bootstrap on nearly every launch (#55). The effect's `cancelled` flag stops the follow-up sync and cache invalidations after sign-out or unmount.
- Triggers: app foreground (`AppState`), network reconnection (`NetInfo`) -- both only once the bootstrap has finished -- and initial login.
- The `QueryClient` has `MutationCache`/`QueryCache` `onError` handlers: a failed mutation or query is logged with its key and variables and surfaced through `setLastError` (the label shows `Sync error`), since the mutation hooks have no `onError` of their own and `Alert.alert` is a no-op on web.

### Data Tables

`accounts`, `transactions`, `transaction_splits`, `recurring_rules` -- all have `_sync_status` (`synced` | `pending` | `deleted`). The `sync_meta` table stores pull timestamps.

### Desktop shell (Electron)

`electron/src/main.ts` is the macOS entry point. It boots an in-process loopback HTTP server (`server.ts`, fixed port 49217 with ephemeral fallback) over `dist/` and points a `BrowserWindow` at it. This preserves absolute asset URLs from `expo export -p web` and gives the renderer a stable origin so `localStorage` (Supabase session, AsyncStorage) persists across launches. The service worker is intentionally suppressed in Electron via a `navigator.userAgent` check in `app/+html.tsx`.

`preload.ts` exposes a deliberately narrow `window.electronAPI` via `contextBridge`: `saveCsv` (round-trips through `ipc.ts`'s `csv:save` handler, which validates `event.senderFrame` origin before showing the save dialog) and `onExportCsv` (menu→renderer event). The menu listener is mounted in `app/(tabs)/_layout.tsx` so `Cmd+E` works from any tab, calling the shared `lib/exportTransactions.ts` helper. Renderer navigation is locked to the local origin in `main.ts` (off-origin links go to `shell.openExternal`).

When adding desktop-only behavior: extend the existing `window.electronAPI` surface rather than enabling `nodeIntegration`. When adding Expo-side code that touches browser-only globals, gate on `Platform.OS === 'web'` (Electron presents as web to React Native) and use `electronAPI` for desktop-specific paths.

## 2. Conventions

- **Style**: PascalCase for components, camelCase for variables/functions, 2-space indent.
- **Naming**: Hook files are `useX.ts`, mapper functions in `lib/mappers.ts`, types in `lib/types.ts`.
- **Soft-delete pattern**: All deletions set `_sync_status = 'deleted'` and `updated_at = now`. Queries filter with `AND _sync_status != 'deleted'`. Push writes a server-side tombstone (`deleted_at`) rather than deleting the remote row, then hard-deletes locally -- the local hard delete is scoped `AND _sync_status = 'deleted'` so it cannot swallow an edit made while the push was in flight. There is deliberately **no local `deleted_at` column**: the tombstone exists only on the server, and consuming one means hard-deleting the local row (`lib/tombstones.ts`). Local deletes of remote data are always scoped to `_sync_status = 'synced'`, so an incoming tombstone can never discard a `pending` edit or a queued local delete.
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
- Each authenticated spec should clean up after itself (delete created accounts/transactions) so the test user stays clean. Deletes are local-first -- the mutation soft-deletes in SQLite and fires `requestPush()` without awaiting it -- so a spec that returns on the Delete click closes the browser context before the tombstone reaches Supabase. End with `deleteAccountAndWaitForPush` from `e2e/web/helpers/test-accounts.ts`, which waits for the card to leave the list and then for the sidebar label to read exactly `Synced`. The engine refreshes the pending count before it clears the syncing flag, so once a write's `requestPush` has been called (which the mutation does synchronously, before the list re-renders) that word cannot appear again until the push has completed. `expectSynced` alone is only meaningful after such a re-render, never straight after a click.
- Debris from failed attempts is handled in CI: with `E2E_PURGE_STALE_TEST_ACCOUNTS=1` (set in `test.yml`), `global-setup.ts` tombstones test-prefixed accounts older than 30 minutes through the REST API before signing in. The age gate is what makes it safe next to a concurrently running job. Locally it is opt-in; `cleanup-test-accounts.spec.ts` remains the browser-driven purge of everything.

### E2E mobile tests (Maestro)

Maestro flows go in `e2e/mobile/flows/*.yaml`. Each flow declares `appId: app.nestworth.ios` and uses `id:` selectors matching the `testID` props. Metro must be running in a separate terminal since the dev client loads JS over the network.

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
format check, unit tests, a web bundle export, and an Electron main compile.
Two more workflows run only when a person starts them from the Actions tab:
`migrate.yml` applies one Supabase migration file, and `testflight.yml` builds iOS on
EAS and submits it to TestFlight. They are manual so the migration can be ordered ahead
of the client, an order Netlify's push-triggered web deploy cannot otherwise guarantee.
The README's TestFlight section has the one-time setup. The
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

**macOS notarization credentials** live in a `notarytool` keychain profile, not in
environment variables. Create it once with `xcrun notarytool store-credentials nestworth
--apple-id <id> --team-id P9KK9LA3ZV`, then build with
`APPLE_KEYCHAIN_PROFILE=nestworth npm run electron:build`. Verify a finished build with
`spctl --assess --type execute -vv dist-electron/mac-arm64/Nestworth.app`, which must say
`source=Notarized Developer ID` -- electron-builder silently skips notarization when it
finds no credentials, so a green build is not proof.

**Gotcha -- stale native module after a Node upgrade:** `better-sqlite3` (used by the
sync unit tests) is compiled against a specific `NODE_MODULE_VERSION`. After changing
Node versions locally the suite fails with `Cannot read properties of undefined
(reading '_sqlite')`. Fix with `npm rebuild better-sqlite3`. CI is unaffected because
it installs fresh against the Node version pinned in the workflow.

## 4. Known Issues & Gotchas

- **Deploys are forward-only once a new migration ships.** `runMigrations` refuses to
  open a database whose `user_version` is newer than the running build
  (`lib/migrations.ts`) — correct, since the older code would write rows against a
  schema it does not understand. The consequence is operational: rolling the web
  deploy back across a migration makes every returning browser hit that guard,
  because the OPFS database is not rolled back with the bundle. Roll forward instead.
- **Clock skew can briefly defer the _periodic_ reconcile for rows this device just
  pushed.** Since push adopts the server's `updated_at`, a synced row carries SERVER
  time while the pull's `pullStartedAt` snapshot is CLIENT time. If the client clock is
  behind by δ, a row this device pushed looks "created mid-pull" for up to δ and is
  excluded from the reconcile pass, so a remote deletion of it is skipped until the
  clock catches up. This now only affects the 24h reconcile, not routine deletes: a
  tombstone arrives through the incremental pass as an explicit per-id assertion and
  needs no `pullStartedAt` comparison at all. Self-corrects; the durable fix is a local
  monotonic marker instead of comparing server-stamped timestamps against the client
  clock.
- **A second browser tab can lose the migration write lock.** Two tabs opening the same
  OPFS database can race; the loser gets `database is locked`. `getDb()` drops a rejected
  init promise so the next call retries rather than poisoning the session (`lib/db.ts`).
- **`useReceiptPhoto.ts` uses `require()` imports** for `getDb` and `requestPush` instead of top-level ES imports. This was likely done to avoid circular dependencies but is fragile.
- **Transaction split sync is delete-then-reinsert**: The push logic deletes all remote splits for a transaction, then reinserts from local. This is not atomic -- if the process is interrupted between delete and insert, remote splits are lost (mitigated by keeping local copies as `'pending'` on failure).
- **Tombstone retention must stay far longer than the reconcile interval.**
  `purge_tombstones()` defaults to 30 days against a `RECONCILE_INTERVAL_MS` of 24h. The
  tombstone is the only _incremental_ signal that a row is gone, so purging one before
  every device has pulled it leaves those devices showing the row until their next
  periodic reconcile. Shortening retention towards 24h removes that margin. The function
  ships unscheduled and is `security definer` with EXECUTE revoked from `public`,
  `anon`, and `authenticated`; run it by hand.
- **Split corrections that don't bump the parent `updated_at` won't refresh**: split sync piggybacks on the parent transaction landing in the pulled/refreshed set, and `transaction_splits` has no `updated_at` of its own. Editing splits through the app always bumps the parent, so this only affects out-of-band/server-side split edits. (Split refresh fetches the remote copy _before_ deleting the local one, so a failed fetch never drops local splits.)
- **Supabase migrations are ordered and `005_tombstones.sql` must land before the
  client that uses it.** Against the old schema the new client's tombstone-filtered
  reads bail out safely, but its tombstone write fails outright and local deletes queue
  up forever. The reverse order is safe: an old client on the new schema keeps
  hard-deleting (which new clients notice via the periodic reconcile), it just keeps
  showing rows other devices tombstoned until it is upgraded. Push-side and pull-side
  tombstone support are also not independently deployable — push-only turns deletes into
  rows that never disappear, pull-only propagates them only every 24h — so they ship
  together.
- **Delete wins over a concurrent edit, and the edit is discarded silently.** If device B
  edits a transaction offline while device A deletes it, B's push applies the edit to the
  tombstoned server row but the tombstone survives, so B's read-back drops the row
  locally. B's edit is gone with no prompt. This is deliberate -- the alternative
  resurrects a row the user deliberately deleted -- but it is a real data-loss surface if
  the two devices are both in active use, and there is no UI telling B what happened.
- **An emptied-_and-purged_ account needs "Reset & re-download".** Deleting every
  transaction is handled normally: the tombstones come back in the enumeration, so the
  reconcile sees rows and honours the all-deleted answer. The gap is narrower -- only once
  those tombstones have been PURGED does the enumeration genuinely return zero rows, and
  then the #19 guard declines to act on it because it is indistinguishable from a broken
  RLS policy. This is the intended trade (a latent whole-store wipe is far worse than a
  rare manual reset), and Settings → "Reset & re-download from cloud" is the recovery
  path.
- **A row created offline for an account another device deleted never syncs.** The
  server rejects it with `23503` (`inherit_account_tombstone`), exactly as the foreign key
  did before tombstones existed, so the row stays `pending` on the device and is retried on
  every push, forever. That is deliberate: the alternative -- stamping it dead -- makes the
  push read the tombstone back and hard-delete data the server has never held, destroying
  what the user typed. The row stays visible and can be moved to a live account, but
  nothing in the UI explains why it will not sync.
- **`deleted_at` is stamped by the server, never by the client.** A
  `normalize_deleted_at` trigger rewrites it to `now()` on the NULL → non-NULL transition
  on all three tables. Trusting the client clock would make the purge retention
  meaningless, since `purge_tombstones` compares against server `now()` -- the same reason
  `001` refuses to trust the client for `updated_at`.
- **A live child can still be born under a dead parent, and only the purge cleans it
  up.** `inherit_account_tombstone` deliberately takes no row lock on the parent (a
  `for share` there would deadlock against `accounts_tombstone_children`), so a child
  committed in the instant before the parent's tombstone becomes visible is born live.
  `purge_tombstones` adopts any such orphan before reclaiming anything. The client's
  periodic reconcile does NOT cover this: it only deletes local rows _absent_ from the
  enumeration, and a live orphan is present.
- **Migrations 001–004 cannot be replayed, and nothing applies a migration on push.**
  The first four were run by hand, and 001 creates its row-level-security policies with
  no existence guard (Postgres has no `create policy if not exists`), so `migrate.yml`
  refuses them. From 005 on every migration must be safe to run twice -- `if not exists`
  on columns and indexes, `drop trigger if exists` before `create trigger`,
  `create or replace` for functions -- and must be valid inside one transaction, which
  rules out `create index concurrently`. Netlify builds the web client from its own git
  hook the instant `main` changes, so an automatic migration step could land after the
  client that needs it; run the migration workflow first, then let the client out.
- **iOS and macOS ship under different identifiers, deliberately.** iOS is
  `app.nestworth.ios` (`app.json`) and the Electron app is `com.nestworth.app`
  (`electron-builder.yml`). `com.nestworth.app` is registered to an Apple account
  that is not this team, and Apple's App ID namespace is global, so it can never be
  claimed here — the Developer portal refuses it outright. Local device builds
  worked for a long time regardless, because Xcode signed them with the team's
  wildcard App ID (`*`), which matches any bundle identifier; only App Store
  distribution needs an explicit registration, which is where it surfaced. The
  Electron identifier is untouched because Developer ID signing needs no App ID
  registration, and changing it would drop the desktop app's stored Supabase
  session. Keep the Maestro `appId` in `e2e/mobile/**` in step with the iOS value.
- **`expo-sqlite` web support**: Uses `sql.js` with IndexedDB/OPFS. Data durability on web is less guaranteed than native SQLite -- browser storage can be evicted. The OPFS-backed DB also survives DevTools "Clear site data" in Chromium, so a corrupted local store must be reset via Settings → "Reset & re-download from cloud" (`resetLocalData`) or by deleting the app's storage directory.
- **Expo Router Stack on web**: `<Link>` pushes new screens rather than replacing, so the DOM accumulates stacked screens. Tests must account for duplicate elements. Maestro on native does not have this issue since the Stack only renders the topmost screen.
- **Expo dev server `Cannot pipe to a closed or destroyed stream`**: Benign race condition in `expo-server` when Playwright disconnects before the response stream finishes. Does not affect test results.
- **Realtime is still partial (#21)**: split changes arriving over realtime are not persisted (only the parent row is), there is no `recurring_rules` channel, and invalidations are not debounced, so a burst of remote writes re-renders once per event. Tombstones and the `synced`-scoped local deletes are handled; these three remain.

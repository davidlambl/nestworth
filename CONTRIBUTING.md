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

- **`requestPush`**: Pushes local `pending`/`deleted` rows to Supabase. Serialized by the `_syncInProgress` lock. A request that finds the lock held **by a sync for the same user** is queued (`_pushQueued`, or `_fullSyncQueued` for `fullSync`/`initialPull`) and every lock holder ends in `finishSync`, which drains the queue with the lock-free primitives, refreshes the pending count, and only then publishes `isSyncing=false` and releases the lock -- so nothing requested mid-sync is dropped (one holder drains at most `MAX_QUEUED_DRAINS` follow-ups; past that the flags stay set for the next trigger, and a caller awaiting that holder returns before its own sync has run), and the label reads `Synced` only when the count is fresh and zero. The drain clears `lastError` only before a full follow-up, which redoes the pull as well and re-reports a pull that is still incomplete (#66). A drained push cannot undo the holder's failure -- it neither retries a reset that failed nor re-reads what the holder's pull could not -- so it leaves the holder's message in place until the next sync starts, since every holder clears it on entry (#65); a write queued behind a sync that failed therefore leaves the label on `Sync error`, not `Synced`, until then. **The queue flags belong to the holder's user** (`_holderUserId`): `finishSync` drains them as the holder, and every push read and pull filter is `user_id = ?`-scoped, so a request for a _different_ user is never queued -- it waits for the release (`await _inFlight`, re-checking the lock each time round) and takes the lock itself, so the work runs for the user that asked (#63). The one place the two rules meet is the `MAX_QUEUED_DRAINS` cap above: a flag left set past it is drained by whichever holder comes next, and since #63 that may deterministically be the OTHER user, because a cross-user caller now waits for the release rather than queuing behind it. Still benign, and no different in kind from before -- a flag means no more than "re-read that user's pending rows" (and, for `_fullSyncQueued`, "pull them too"), so a drain for the wrong user only redoes that user's own push -- and, for a queued full sync, its pull -- redundant work, never wrong work, and the requester's rows stay pending for its next trigger. That is reachable on any account switch: `useSyncEngine` is keyed on the user id and its cleanup only flips `cancelled`, so the outgoing session keeps the lock while `startSyncSession` starts for the incoming one. `acquireLock` is synchronous and creates `_inFlight` as an unsettled deferred before the lock is observable -- a caller that finds the lock free is holding it by the time it yields, and a waiter never spins on a null or already-settled promise. A `deleted` row is pushed as a **tombstone**, not a hard delete: `update({ deleted_at })` filtered by `.is('deleted_at', null)` so a retry or a server-side cascade never re-stamps (and so never re-broadcasts) a row that is already dead. Zero matched rows is success — never pushed, already purged, or already tombstoned all mean "the server agrees it's gone" — and falls through to the local hard delete. That holds only for a push signed as the user: with no session, supabase-js signs every request with the anon key, a tombstone UPDATE then matches nothing whether or not the row is live, and the hard delete would silently undo the user's delete. So `pushChanges` refuses outright when `auth.getSession()` has no session to give, reports it through `setLastError` ("Couldn't renew your sign-in: …") and leaves every row queued (#95). `transaction_splits` has no tombstone of its own: splits ride their parent and stay hard-deleted. Deleting an account only tombstones the account; server triggers cascade the stamp to its transactions and rules (`005_tombstones.sql`), though the client still pushes child tombstones itself rather than depending on them. A child written into an account that was _already_ tombstoned is REJECTED by the server with `23503` rather than stamped dead, which is what keeps an offline-created row alive -- see the born-dead note in Known Issues. If a push fails because the server is missing `deleted_at` entirely, `pushChanges` reports it once through `setLastError` instead of retrying in silence.
- **Splits carry an `updated_at` (#20, `006_split_updated_at.sql`)** so the push can guard the write that marks them `'synced'` on the row it actually uploaded: it `.insert(...).select('id, updated_at')`, then per id runs `SET _sync_status = 'synced', updated_at = COALESCE(?, updated_at) WHERE id = ? AND updated_at IS ? AND _sync_status = 'pending'` -- the same guard the parent transaction has. A split edit that lands during the round trip replaces the splits under fresh ids, so every one of those statements matches nothing and the replacements stay `'pending'` for the next push, instead of being marked synced unsent and then overwritten by the pull's split refresh. That guard only holds because **the split refresh skips any parent whose LOCAL row is not `'synced'`**: our own push bumps the parent's server `updated_at`, so the next incremental pull lists it in `pulledTxnIds` even though its upsert was a guarded no-op, and refreshing splits there would insert the server's superseded copy (its id no longer exists locally) alongside the pending replacement -- which the next push then uploads together, turning a lost edit into a permanent duplicate. Nothing is given up while the store holds the parent's splits: a pending parent's splits are replaced wholesale by the next push anyway. A parent the store holds without its splits is the exception -- one a download left so (a split read that failed, or a bootstrap killed before it), or one realtime delivered before the next pull (`applyTransactionEvent` writes the parent only; reachable today only through another device's transaction from a legacy recurring template that carries splits): a parent the user edits in that state has no local splits, so the next push deletes the server's splits and uploads none -- a push-side gap, left for #97's guard (replace a pending parent's server splits only when a split row under it is pending or deleted), not a reason to refresh pending parents, which would bring the duplicate back. `IS` rather than `=` because a local `updated_at` may be NULL (a split the local migration 2 could not backfill, or one pulled from a pre-006 server) and SQLite's `=` is not NULL-safe; for the same reason a NULL is sent as an **absent key** rather than an explicit null, so the server's `not null default now()` applies and the stamp comes back to heal the row.
- **`fullSync`**: Push then pull. If a sync **for the same user** is already in flight it queues a full sync and awaits the holder (which drains it before releasing) instead of silently returning, so `syncNow` and sign-out get the sync they asked for. If the holder is syncing someone else it waits for the lock and then runs its own push and pull (#63) -- `syncNow`/`promptSignOut` during an account switch therefore wait for the other user's sync rather than returning early with nothing done.
- **`initialPull`**: Bootstrap for first login -- pages every read to fetch all remote data (live rows only; tombstones are never downloaded), refuses before its first read without a session (#95; every read would answer `[]` under the anon key, and its stamps would declare the device fully pulled over nothing), abandons the download on any failed read so the cursors stay unset, and sets all three meta keys **from a snapshot taken before the first remote read**, never from an end-of-pull `now` (a bootstrap of a large history spans many round trips, and stamping the later time declares that whole window pulled), including `last_txn_reconcile_at` so a fresh device does not immediately re-enumerate what it just downloaded. The loop is written for an **empty** store, and since #96 it only starts over one (the store is checked once, before the first read, so a parent the loop lands and the user re-splits during the download still gets the server's splits beside the re-split, as before): a store that already holds any of this user's rows -- a first bootstrap killed mid-download (rows landed, no keys; probably the commonest way in); one that gave up on a failed read (a session lost mid-download included, #95) with no pull after it to record an attempt, because its session was cancelled before `startSyncSession`'s `fullSync`, or that `fullSync` was refused for want of a session (a refusal stamps neither key, #95), or its push threw before it reached the pull (as `pushTable`'s unguarded `JSON.parse` of a malformed rule template can); a reset whose download threw after landing some tables; or a local write or realtime event that landed a row before the check (benign: the pull still completes over it) -- runs the `pullChanges` substitute described next instead, whose no-cursor read (tombstones included), reconcile and synced-parent split refresh cover what the loop lacks, with one gap: a parent that went pending before its splits landed has none locally, the refresh skips it, and its server splits are lost at the next push until #97's push guard (the loop's unfiltered split read happened to save them on the relaunch; the same edit pushed before any relaunch loses them either way). If a sync **for the same user** already holds the lock it queues a full sync instead and awaits it. That substitute is a `pullChanges` with unset cursors, and it is **not** an equivalent bootstrap: it also downloads every tombstoned transaction and runs the reconcile enumeration (which, for a user with no transactions, never banks its key and so repeats each sync until one exists), and where `initialPull` gives up on a failed read it swallows and reports the failure (#66) and still stamps `last_pull_attempt_at` (unless it was refused for want of a session, which stamps neither), so `needsInitialPull` turns false -- only `last_pull_at`, the "Last synced" line, waits for a pull that completes. It converges anyway, because with no cursor every read `pullChanges` swallows and reports is retried by the next sync (see the cursor rule under `pullChanges`), and no remote read is keyed on either pull key -- they only answer `needsInitialPull`, and `last_pull_at` feeds "Last synced" in Settings. `startSyncSession` runs that same pull straight after an `initialPull` that failed, so the startup sequence depends on the same rule. None of that reasoning survives a cross-user collision, so a bootstrap requested while **another user's** sync holds the lock does not queue: the drain would run as the holder, download nothing for the user who asked, and still leave `needsInitialPull` true with no error to show. It waits for the release and then runs the bootstrap itself, store check included (#63).
- **`pullChanges`**: Full-table pull for accounts/rules (`pullTableFull`) that reconciles deletions AND force-heals any `synced` row whose `updated_at` drifted from the server in either direction (`forceUpsertRemoteAccount`/`forceUpsertRemoteRule`, mirroring the transaction self-heal — relevant because `accounts.initial_balance` feeds every total). These tables stay full-table because they are tiny; the read partitions into live rows (which upsert as before) and tombstoned rows (which route to a scoped local delete). All three steps run on every pull whatever the others did, and `last_pull_at` -- the "Last synced" line in Settings -- is stamped only when every one of them read and applied everything (#66): a failed read, or an empty read that one of the #19 guards below refused to trust, withholds it, `pullChanges` resolves `false`, and the first such failure is reported through `setLastError`. A failed pull never unsets the key, so it keeps the time of the last complete pull. Every run that gets as far as its reads (one refused for want of a session stamps neither), complete or not, also stamps `last_pull_attempt_at` from the same instant, and `needsInitialPull` is true only while both keys are unset: an incomplete pull must not send the next launch back to `initialPull`, which is written for an empty store -- its split loop neither filters by the parent's local status nor deletes stale synced splits, so it would insert the server's splits beside a pending replacement and the next push would upload both, and it banks both transaction keys past any tombstone written in between. Since #96 `initialPull` itself takes that same route over a store that holds any of this user's rows. Under `throwOnError` the reads that already threw -- both whole-table reads, the incremental page, and the split reads for the parents it pulled -- still throw first and stamp neither key; a reconcile that could not complete never threw and still does not (see `resetLocalData`). **A pull with no session reads nothing (#95).** When `auth.getSession()` has no session to give, supabase-js discards its error and signs every request with the anon key, and RLS answers every read `[]` with no error at all -- which step 1 below takes for "nothing changed" (banking its cursor over a window it never read) and a new user's pull for complete. So `pullChanges` asks `getSession()` itself before any read, and with no session it is refused: it reports "Couldn't renew your sign-in: …" (the refresh's failure, mapped by `describeRequestError`) or "Couldn't verify your sign-in" (nothing stored), resolves `false` and stamps neither key -- nothing was read, as for a download that throws, so a fresh device still bootstraps on the next launch; under `throwOnError` it throws. The session can also go between two pages of one read, so `readAllPages` asks again on every empty page (see Paging). Self-healing pull for transactions (`pullTransactions`) is two passes:
  1. **Incremental, every sync**: `updated_at > cursor`. Because a delete is now an ordinary `UPDATE` that stamps `deleted_at`, this pass sees deletions too — a tombstoned row routes to a scoped local delete (splits first) instead of an upsert, and never enters the pulled/touched sets. This is the whole point of tombstones: per-sync cost is proportional to what changed, not to total history.
  2. **Periodic reconcile, at most once per `RECONCILE_INTERVAL_MS` (24h)**, gated on the `last_txn_reconcile_at:${userId}` meta key. Enumerates all remote `(id, updated_at, deleted_at)` -- tombstones included, deliberately -- and treats a tombstoned row as absent. It counts RAW rows separately from live ones so "the server says everything is deleted" stays distinguishable from "the read returned nothing"; filtering server-side would collapse the two and the #19 guard would then refuse the honest answer forever. It -- via the pure `planTransactionReconcile` -- deletes server-removed rows, pulls rows missing locally, and force-refreshes (`forceUpsertRemoteTransaction`) any `synced` row whose timestamp differs in _either_ direction, reading each batch's parents and then their splits before writing either, so a failed read withholds the whole batch and the key (#62). This is what lets a device recover from a server correction whose `updated_at` is _older_ than the device cursor (which the fast-path skips forever), and from a tombstone that was purged before the device ever pulled it. The key only advances after a pass actually completes — not on error, and not on the empty-enumeration skip — so a misconfigured RLS policy keeps retrying rather than going quiet for 24h. **An empty remote read is never authoritative**: `planTransactionReconcile` returns no deletions unless the caller confirms the enumeration actually came back with rows (`remoteReadReturnedRows`), and `pullTableFull` mirrors that check on its own read, so a clean-but-empty response (a broken RLS policy, say -- the anon-key case is refused before the read and on every empty page since #95) can never wipe the local store. The cursor is subject to the same rule: `last_txn_pull_at` is only advanced when the incremental pass actually read -- every transaction page, and every split batch for the parents the pull touched -- since banking it over an unread window would hide those changes from `gt('updated_at', cursor)` permanently now that the reconcile is only a daily backstop. For splits even the backstop does not help: a parent upserted by that pull already matches the server, so the reconcile never refreshes it, and without the hold its splits stay missing until the parent is next edited. A parent the reconcile heals never depends on that cursor, and must not: no incremental read returns a row that is no newer than the cursor, however far back it is held. Its splits are read inside the reconcile instead, before the parent is written, so a failed read there leaves the parent stale and the reconcile key unbanked, and the next pass plans the same row again (#62) -- which is why only the incrementally pulled ids reach the split-refresh step.
- **Paging**: **Every remote read pages** -- `.order('id').range()` through the `readAllPages`/`readAll` helpers, advancing by the rows RETURNED and stopping only on an empty page -- because PostgREST clamps every response at `max_rows` (1000 on hosted Supabase) and says nothing about having done so (#64). Engine-wide, not a `pullChanges` detail: `initialPull`'s four reads, both `pullTableFull` tables, the incremental transaction pass, the reconcile enumeration and all three split reads. The only exception is `resetLocalData`'s single-row reachability probe, which asks for exactly one row and wants no more. A short page is precisely what the clamp looks like, so stopping on one -- or advancing by the page size that was ASKED for rather than the rows returned -- silently truncates the read, and a truncated read is not empty, so the #19 guard does not catch it. The cost is one trailing empty request per read or batch; the alternative was a read whose missing tail reads as "the server no longer has these rows", i.e. deletion authority over rows nobody ever saw. A third rule since #95: **an empty page ends a read only if the client could sign it.** Under the anon key RLS answers `200 []`, the same bytes as the end of the table, and a session can go between two pages of one read, so every empty page -- the first one included -- asks `auth.getSession()`, and with no session the read fails with its own error ("your sign-in could not be renewed (…)"): the pages already delivered stand, and every caller withholds what a failed read withholds (its cursor, its reconcile key, its absence-deletes). Never on a page that returned rows, which a signed request did. The cost is one session read per read-ending empty page, from storage on the happy path. The check cannot see which key signed the page itself, so a refresh that fails for the page and succeeds for the check still gets an anonymous `[]` trusted (Known Issues).
- **`resetLocalData`**: Recovery escape hatch, surfaced in Settings as "Reset & re-download from cloud" for the rare case the local store drifts past what the reconcile can heal (e.g. an OPFS-backed SQLite file that "Clear site data" won't drop). Holds the `_syncInProgress` lock for the WHOLE operation and uses the lock-free `pushChanges`/`pullChanges` primitives (NOT `fullSync`/`initialPull`), so a background AppState/NetInfo sync can't slip between steps and either race the wipe or hold the lock when the re-bootstrap runs (which would make it a no-op, leaving the device wiped-but-empty). It refuses outright when the lock is held, whoever holds it, but it does record itself as the holder, so a request arriving for another user waits for it instead of being mis-queued into the reset's own drain (#63). Order: refuse without a session (#95: with none, the push would be refused too and the reachability probe below reads `[]` under the anon key -- no error, so "reachable"), flush pending edits up (and abort if any of the user's rows remain unsynced afterward, so a swallowed push error isn't wiped away), confirm the cloud is reachable BEFORE wiping (an offline reset aborts without touching local data), check the session again as the last thing before the wipe (it can go during the push and the probe, and a wipe followed by a pull with no session downloads nothing into an empty device; the check stays outside any SQLite transaction, since inside the token's expiry margin it is a refresh of up to 30 s, and on web it can first wait up to 5 s for auth-js's cross-tab lock or queue behind a refresh already in flight), wipe the user's rows from every local table plus their four `sync_meta` keys (`wipeLocalData`), then re-download via `pullChanges` in `throwOnError` mode — a failed download surfaces as a failed reset and leaves both pull keys unset (so `needsInitialPull` turns true → next-launch re-bootstrap -- over any rows the failed download landed, that runs `pullChanges`, not the bootstrap loop (#96) -- unless a pull runs first: a drained queued full sync or any later sync records an attempt if it gets as far as its reads (one refused for want of a session stamps neither), and the recovery is then a no-cursor `pullChanges`) rather than a silently partial cache. A failed read there throws and fails the reset as before; a failed reconcile enumeration or refresh batch after the wipe does not throw -- the reset resolves, the pull reports through `setLastError`, `last_pull_at` is withheld, and the next sync retries the reconcile (#66). **The guard and the wipe are both per-user (#87)**: the guard counts with the same predicates the wipe deletes with -- `user_id = ?`, and splits (which have no `user_id`) through their parent. Another account signed in on the same device is untouched: its unsynced rows neither block the reset nor appear in the refusal's count, and its rows, pending work and `sync_meta` keys stay exactly as they were, so it is not re-downloaded either. Both used to be device-wide, and while the wipe took every account's rows, refusing over anyone's pending rows was the conservative choice -- but it held one account's reset hostage to another's unsynced rows, which it can neither see nor push, and a reset that did run discarded the other account's cache.
- **Conflict resolution**: Last-write-wins, except that **delete wins over a concurrent edit**. Local `ON CONFLICT DO UPDATE ... WHERE _sync_status = 'synced'` protects unsynced local edits from being overwritten by remote data. The transaction reconcile treats the server as authoritative for already-`synced` rows, so it overwrites them regardless of timestamp order -- but still never touches `pending`/`deleted` rows. When a pending edit lands on a row another device tombstoned, the edit applies but the tombstone survives (PostgREST only sets the keys in the payload, and `deleted_at` is never one of them), so the push read-back sees `deleted_at` set and drops the row locally instead of marking it synced. The alternative -- edit wins -- resurrects a row the user already deleted, which is exactly what the old hard-delete push did. Delete wins only while the tombstone exists, though: `purge_tombstones()` reclaims it 30 to 37 days after the delete (weekly, since `007`), and an edit pushed after that re-inserts the row, as hard deletes did (a child of a purged account is refused with `23503` instead; see Known Issues).
- **Sync meta keys**: Scoped by userId (`last_pull_at:${userId}`, `last_pull_attempt_at:${userId}`, `last_txn_pull_at:${userId}`, `last_txn_reconcile_at:${userId}`) to support multi-user sign-in on the same device. `wipeLocalData` clears that user's four keys, so a reset forces a fresh reconcile for that user. `last_pull_at` is stamped only by a pull that read and trusted every table, and a pull that could not leaves it as it was, so "Last synced" is the time of the last COMPLETE pull; `last_pull_attempt_at` is stamped by every `pullChanges` that gets as far as its reads (one refused for want of a session stamps neither), complete or not, and `needsInitialPull` is true only while both are unset (#66).

### Sync Orchestration (`lib/query.tsx`)

- `useSyncEngine` hook runs inside `SyncProvider` (nested inside `AuthProvider`) and calls `startSyncSession` from `lib/sync.ts`: open the DB, `initialPull` if this device has never pulled, then one `fullSync`.
- Keyed on the user **id**, not the `User` object: auth-js emits a fresh object on every auth event, and keying on it tore the engine down mid-bootstrap on nearly every launch (#55). The effect's `cancelled` flag stops the follow-up sync and cache invalidations after sign-out or unmount.
- Triggers: app foreground (`AppState`), network reconnection (`NetInfo`) -- both only once the bootstrap has finished -- and initial login.
- The `QueryClient` has `MutationCache`/`QueryCache` `onError` handlers: a failed mutation is logged with its key (and, in development only, its variables, which carry amounts, payees and memos) and surfaced through `setLastError` (the label shows `Sync error`), since the mutation hooks have no `onError` of their own and `Alert.alert` is a no-op on web; a failed query is only logged, with its key. The sync engine reports through the same `setLastError`: a sync, bootstrap or reset that failed, a server missing a migration this build needs (`pushChanges`), a pull that could not read or trust every table (#66), and a push, pull, bootstrap or reset refused because the client had no session to sign its requests with ("Couldn't renew your sign-in: …", #95). While the device is offline, the label and the Settings status line say `Offline` ahead of any recorded error (#66): a foreground sync runs whatever the connectivity, so the error is then almost always the offline itself, and the reconnection sync clears it before its next attempt.

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
- **Archived accounts**: `accounts.is_archived` is the reversible, non-destructive exit; delete stays the destructive one. An archived account is hidden from the accounts list and its total, the desktop sidebar's list, every account picker (transfer, recurring rule, CSV import) and the **All Accounts** ledger and its balance summary (`activeAccountTransactions` in `lib/register.ts`). It is deliberately still counted in Reports and in CSV export -- history stays meaningful and a backup stays complete. Its register keeps working but is read-mostly: a banner with Unarchive, no add-transaction or transfer button, existing transactions still editable. Recurring rules on an archived account stay in place; Post Now is hidden for them, and `usePostRecurringTransaction` refuses to post into one. Unarchive from the collapsed **Archived** group on the Accounts tab or from that banner. A new read site that lists accounts should filter `!a.isArchived` unless it is a history or export view.
- **Mutation pattern**: Write to SQLite -> call `requestPush(user!.id)` -> invalidate relevant query keys in `onSuccess`.
- **Seeding a form from a query**: seed once per loaded row **id**, not on every refetch. A screen's query is refetched by ordinary sync activity -- the realtime echo of this device's own push (`lib/hooks/useRealtimeSync.ts`) and the blanket `queryClient.invalidateQueries()` that every sync ends with (`lib/query.tsx`) -- and a push adopts the server's `updated_at`, so the refetched object is a new reference even when nothing the user cares about changed. An effect keyed on that object re-seeds the form mid-edit and discards whatever has been typed (#85). Guard it with a `useRef` holding the id already seeded; the only screen that needs this today is `app/transaction/[id].tsx`.
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
- Before typing after a react-native-web `Modal` closes (into a second modal, or a field on the screen behind it), wait for the closing modal to detach with `waitForModalToClose(page, <testID inside it>)` from `e2e/web/helpers/test-accounts.ts`. The closing modal stays mounted and keeps its document-level focus trap active for its 250 ms slide-out, so a `fill()` in that window types into the closing modal instead (issue #55). Waiting for `hidden` is not enough; after a `fill()` that matters, assert `toHaveValue` before saving.
- Debris from failed attempts is handled in CI: with `E2E_PURGE_STALE_TEST_ACCOUNTS=1` (set in `test.yml`), `global-setup.ts` tombstones test-prefixed accounts older than 30 minutes through the REST API before signing in. The age gate is what makes it safe next to a concurrently running job. Locally it is opt-in; `cleanup-test-accounts.spec.ts` remains the browser-driven purge of everything.

### E2E mobile tests (Maestro)

Maestro flows go in `e2e/mobile/flows/*.yaml`. Each flow declares `appId: app.nestworth.ios` and uses `id:` selectors matching the `testID` props. Metro must be running in a separate terminal since the dev client loads JS over the network.

**Authentication**: `npm run e2e:mobile` reads `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` from `.env.e2e` and passes them to Maestro.

### What to add when making changes

**For every new feature:**

1. Add a unit test in `lib/__tests__/` for any new pure logic (formatters, parsers, helpers, mappers).
2. Add `testID` props to new interactive elements, prefixed by screen name.
3. No new Playwright spec or Maestro flow by default: Playwright is a small smoke layer run in single passes, and a new spec needs the owner's explicit ask.

**For every bug fix:**

1. Add a unit test that reproduces the bug and verifies the fix (regression test). Sync-engine regressions go against `lib/testing/syncFixture.ts` and must be proven to fail without the fix.
2. If the bug is UI-visible, verify the fix in a browser or on a device and state what was verified in the PR body.

PRs touching `lib/sync.ts` get an independent review pass before merge.

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
  Local migration 2 (`split_updated_at`, #20) is the first one to make this real:
  before it, every shipped build was on version 1, so no rollback could trip the
  guard. Once it ships, rolling the web deploy -- or the Electron app -- back to
  1.1.2 leaves it unable to open its database until it is upgraded again, and on
  web the OPFS database is shared per origin, so it is not per-tab recoverable.
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
- **Transaction split sync is delete-then-reinsert**: The push logic deletes all remote splits for a transaction, then reinserts from local. This is not atomic -- if the process is interrupted between delete and insert, remote splits are lost (mitigated by keeping local copies as `'pending'` on failure). A _failed_ split upload also leaves the parent transaction `'pending'`, so a server missing `006_split_updated_at.sql` stops every transaction from syncing, not just its splits -- which is why `pushChanges` reports that case through `setLastError` (see `isMissingColumnError`) instead of retrying in silence.
- **Tombstone retention must stay far longer than the reconcile interval.**
  `purge_tombstones()` defaults to 30 days against a `RECONCILE_INTERVAL_MS` of 24h. The
  tombstone is the only _incremental_ signal that a row is gone, so purging one before
  every device has pulled it leaves those devices showing the row until their next
  periodic reconcile. Shortening retention towards 24h removes that margin. The function
  is `security definer` with EXECUTE revoked from `public`, `anon`, and `authenticated`,
  so no app session can call it. `007_schedule_purge_tombstones.sql` runs it weekly with
  `pg_cron` -- job `purge-tombstones`, Sundays 04:00 UTC, default retention, as the
  `postgres` role that scheduled it. The cadence only decides how long past the
  retention a tombstone lingers (up to a week), never how early it goes. Once a tombstone
  is purged, delete no longer wins over a concurrent edit: an edit pushed more than 30 to
  37 days after the delete re-inserts the row, as hard deletes did (the push upserts on
  `id`, and the local row has no `deleted_at`), while a transaction or rule whose account
  was purged too is refused with `23503` and stays `pending`, unless the same device
  re-pushes that account first.
  `cron.job_run_details` records whether each run succeeded, not the three counts the
  function returns; to see those, run it by hand with
  `select * from public.purge_tombstones();` in the SQL editor as `postgres` -- which
  deletes remote data. The migration's header shows how to inspect or unschedule the job.
- **Split corrections that don't bump the parent `updated_at` won't refresh**: split sync piggybacks on the parent transaction landing in the pulled/refreshed set. `transaction_splits` gained an `updated_at` of its own in #20, but it is **not** a pull cursor -- splits are still fetched by `transaction_id` for the parents a pull touched, and they still have no tombstone. Editing splits through the app always bumps the parent, so this only affects out-of-band/server-side split edits. (Split refresh fetches the remote copy _before_ deleting the local one, so a failed fetch never drops local splits.)
- **`006_split_updated_at.sql` must land before the client that uses it, for the
  same reason.** The new client sends `updated_at` in its split INSERT and
  selects it back; against the old schema PostgREST rejects both with
  PGRST204/42703, the split upload fails, and that leaves the parent transaction
  `'pending'` as well -- so one missing column on a child table stops every
  transaction from syncing. While that lasts, the push's remote split DELETE
  succeeds before its INSERT fails, so every push wipes the server-side splits
  of every pending transaction -- self-healing once 006 lands, because the local
  rows stay `'pending'` and the next push reinserts them, but a real reason not
  to leave the client out in front. The reverse order is safe: an old client
  omits the column on insert and takes the `default now()`, and its `select *`
  pulls ignore a column it does not map. Run `migrate.yml` with the file first,
  then merge the client.
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
  It holds only while the tombstone exists -- see the retention bullet above for what an
  edit pushed after the purge does.
- **An emptied-_and-purged_ account needs "Reset & re-download".** Deleting every
  transaction is handled normally: the tombstones come back in the enumeration, so the
  reconcile sees rows and honours the all-deleted answer. The gap is narrower -- only once
  those tombstones have been PURGED does the enumeration genuinely return zero rows, and
  then the #19 guard declines to act on it because it is indistinguishable from a broken
  RLS policy. This is the intended trade (a latent whole-store wipe is far worse than a
  rare manual reset), and Settings → "Reset & re-download from cloud" is the recovery
  path.
- **A token refresh that fails and then succeeds within one read can trust an
  anon-answered empty page.** The session checks (#95) keep an anonymous `[]` from
  being read as the end of a table, but they cannot see which key signed a page. If the
  refresh a page's own request needs fails retryably (a 502/503/504, a network error),
  supabase-js signs that page with the anon key and RLS answers `[]`; if the check's own
  refresh then succeeds, the empty page is trusted. In step 3's split refresh that drops
  the parent's local synced splits and reports the pull complete, cursor banked -- and a
  later edit of that parent pushes by deleting every remote split and inserting none, a
  loss on every device. The reconcile's split refresh does the same and banks its key. A
  flapped page in a multi-page reconcile enumeration truncates it, and the rows past it
  are absence-deleted locally until the next reconcile, up to a day later. All three
  predate #95, which narrows them to this window. The sound fix, not yet made:
  reject, in the `global.fetch` wrapper (`lib/fetchWithTimeout.ts`), any `/rest/v1/`
  request whose `Authorization` header is `Bearer <anon key>`. supabase-js sets that
  header before the wrapper sees the request, the app makes no intentional anonymous
  PostgREST call, and postgrest-js turns the rejection into `{ error }` -- so the read
  would fail instead of answering, which closes this window and a session lost between
  a push's check and its tombstone UPDATE as well.
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

# Backlog #18: Tombstones so pulls can be incremental

Integration branch: `claude/backlog-implementation-plan-6fb5yx`. Closes GitHub issues **#18** (tombstones), **#19** (empty enumeration treated as authoritative), and **#22** (missing Postgres indexes) in one PR. Workers need `npm ci` first (node_modules is not installed in this checkout; `better-sqlite3` builds natively).

## Context

Deletes are hard deletes server-side, so a device can only learn that another device deleted a row by enumerating **every** remote `(id, updated_at)` on **every** sync (`lib/sync.ts:703-729` for transactions; `pullTableFull` at `lib/sync.ts:541-544` re-reads whole tables for accounts and rules). That is the largest scaling risk in the sync path, and it carries a latent data-loss edge: a clean-but-empty enumeration (a misconfigured RLS policy, say) makes the reconcile delete every local synced row (#19).

#12 fixed the timestamp drift that made the reconcile fire on every edited row, so drift is no longer routine and the per-sync scan is now pure tax. A server-side `deleted_at` tombstone turns a delete into an ordinary `UPDATE`, which the existing `updated_at > cursor` incremental pull already sees. The full reconcile (`planTransactionReconcile`) stays as a **periodic** safety net, guarded so an empty enumeration can never delete.

Outcome: per-sync cost for transactions becomes proportional to changes since the cursor instead of total history; #19 is closed by construction plus an explicit guard; the server gets the indexes the query shape needs.

## Design contract (every workstream builds against this)

**No local SQLite schema change.** Local deletion is already `_sync_status='deleted'` then a hard delete after push, and incoming tombstones are consumed into hard deletes. `deleted_at` exists only on the server. This avoids the four hand-maintained schema copies (`lib/migrations.ts`, `lib/__tests__/sync.test.ts:31-37`, `lib/__tests__/migrations.test.ts`, `lib/__tests__/applyTransactionUpdate.test.ts`), and `pushChanges` forwards every local column except `_sync_status` (`lib/sync.ts:347`, `:462`), so a local column would leak into upserts anyway. One new `sync_meta` key: `last_txn_reconcile_at:<userId>` (the KV table needs no DDL; `wipeLocalData` clearing `sync_meta` forces a reconcile after a reset).

**Server.** `accounts`, `transactions`, `recurring_rules` gain `deleted_at timestamptz null`. `transaction_splits` does not (no `user_id`, no `updated_at`; they ride the parent and stay hard-deleted; purge cascades through the FK). Two triggers replace the FK cascade a tombstone no longer fires: tombstoning an account stamps its live children, and a transaction or rule inserted into an already-tombstoned account is born tombstoned. RLS is untouched (`auth.uid() = user_id`, owners can read their own tombstones).

**Push.** `supabase.from(t).delete().eq('id', id)` for accounts, transactions, and rules becomes `.update({ deleted_at: now }).eq('id', id).is('deleted_at', null)`. The `.is` filter stops a retried or cascaded tombstone from re-firing the `updated_at` trigger and re-broadcasting to every device. Never chain `.single()` on that update: zero matched rows (never pushed, already purged, already tombstoned) is success and must fall through to the local hard delete. Tombstone the transaction **before** the best-effort remote split delete. Local hard deletes gain `AND _sync_status = 'deleted'`.

**Tombstone guard in every upsert.** `upsertRemoteAccount/Transaction/Rule` and the three `force*` variants early-return when `row.deleted_at != null`. This is not optional: the deleting device receives its own tombstone as a realtime `UPDATE`, and today's handler feeds it to `upsertRemoteTransaction` whose INSERT branch has no guard (`lib/sync.ts:913-933`), so without this every delete resurrects locally until the next pull.

**Pull.**

- `pullTransactions` step 1 (incremental): rows with `deleted_at` → scoped local delete (splits then row, `WHERE _sync_status = 'synced'`); pending/deleted local rows are never touched. Tombstoned ids never enter `pulledTxnIds`/`touched`.
- Step 2 (full enumeration + `planTransactionReconcile`) runs only when `last_txn_reconcile_at` is missing or older than `RECONCILE_INTERVAL_MS` (24 h). The enumeration and the refresh batch filter `.is('deleted_at', null)`. The key advances to `pullStartedAt` only after a completed pass (not on error, not on the #19 empty-skip, so a misconfigured RLS keeps retrying at the cost of one empty page).
- **#19** lives in the pure planner: `planTransactionReconcile` returns `toDelete: []` when `remote` is empty. `pullTableFull` mirrors that check on its raw `data` before its delete loop.
- `pullTableFull` (accounts, rules) stays full-table (tiny tables). Partition `data` into live and tombstoned: live rows go through the existing upsert/force path and form `remoteIds`; tombstoned synced rows fall to the existing absence-based delete loop (`:587-591`), which is already scoped to synced and reconcilable. Do **not** make these incremental off `last_pull_at` (it is set to "now" after the pull at `:523` and would skip mid-pull changes).
- `initialPull` filters `.is('deleted_at', null)` on all three reads and also sets `last_txn_reconcile_at`.

**Push read-back.** `.select('id, updated_at')` at `:351` and `:467` becomes `.select('id, updated_at, deleted_at')`. If the server reports `deleted_at` set (a pending edit landed on a row another device tombstoned), skip mark-synced and the split upload, and delete locally with the same guard as mark-synced (`WHERE id=? AND updated_at=? AND _sync_status='pending'`). PostgREST upsert only sets payload keys, so the tombstone survives the edit: **delete wins over a concurrent edit**, which is the right semantic (today the same race resurrects the row server-side).

**Realtime.** A tombstone arrives as an `UPDATE` with `payload.new.deleted_at` set: route to the scoped local delete. Keep the `DELETE` branches (purge jobs and old clients still hard-delete) but scope them to synced rows (issue #21's first bullet; the lines are being rewritten anyway).

**Purge.** `purge_tombstones(retention interval default '30 days')` ships in the migration, `security definer`, `set search_path = public`, execute revoked from `anon` and `authenticated`, unscheduled. Invariant: retention must far exceed `RECONCILE_INTERVAL` (24 h); a device offline longer than the retention misses purged tombstones and relies on the periodic reconcile.

**Deploy order.** Run `005_tombstones.sql` **before** deploying the client. Against the old schema the new client's `.is('deleted_at', null)` reads bail safely, but its `.update({ deleted_at })` fails and local deletes stay queued forever. Old clients on the new schema keep working (they hard-delete; new clients see that via the periodic reconcile) but keep showing rows other devices tombstoned until upgraded. W2 and W3 are **not** independently deployable (push-only turns tombstones into visible rows; pull-only propagates deletes every 24 h), so everything ships from the integration branch in one deploy.

**Indexes (#22).** `transactions(user_id, updated_at)` and `recurring_rules(user_id)`. Skip a `deleted_at` index: low cardinality, and the enumeration already walks the user's rows via the leading column.

## Workstreams

**W0 lands first** (one agent, ~1–2 h). **W1, W2, W3, W4 then run in parallel** off that commit, each on its own branch (`claude/tombstones-w1` … `w4`) merged back into the integration branch. Ownership below is by file and, inside `lib/sync.ts`, by function, so git's three-way merge stays conflict-free. New tests go in **new files**; after W0, nobody edits `sync.test.ts` except W3's single test adjustment.

### W0 — Foundation: shared helpers, upsert guards, test fixture

Owner files: `lib/tombstones.ts` (new), `lib/testing/syncFixture.ts` (new), `lib/__tests__/sync.test.ts` (extraction only), `lib/sync.ts` **only** the six upsert/force functions (`:818-1086`, one guard line each).

1. `lib/tombstones.ts` (pure SQL, no import from `sync.ts`, so `useRealtimeSync` cannot form a cycle): `isTombstone(row)`, `deleteLocalTransactionIfSynced(db, id)` (row `WHERE id=? AND _sync_status='synced'`; delete its splits only when that changed a row), `deleteLocalAccountIfSynced`, `deleteLocalRuleIfSynced`.
2. Add `if (isTombstone(row)) return;` at the top of `upsertRemoteAccount`, `forceUpsertRemoteAccount`, `upsertRemoteTransaction`, `forceUpsertRemoteTransaction`, `upsertRemoteRule`, `forceUpsertRemoteRule`.
3. `lib/testing/syncFixture.ts`: move `SCHEMA`, `makeAdapter`, `toPgTimestamp`, `makeSupabase`, `TXN_COLS`, `insertLocalTxn`, `remoteTxn` out of `sync.test.ts:31-337` (outside `__tests__` so jest's default `testMatch` ignores it; no jest globals inside so `tsc` is happy; `jest.mock` calls stay in each test file). Add `remoteAccount`, `remoteRule`, `insertLocalAccount`, `insertLocalRule`, `insertLocalSplit`, and a `wireSyncMocks()` that reproduces the `beforeEach` wiring at `sync.test.ts:307-326` and returns `{ adapter, store, meta }`.
4. Fake extensions in `makeSupabase`:
   - read builder: `.is(col, val)` where `null` also matches a missing key (existing fixtures omit `deleted_at`).
   - `.update(patch)`: chainable `eq/in/is`, thenable; stamps `updated_at = opts.serverNow ?? toPgTimestamp(now)` on matched rows (the trigger always fires on UPDATE); without `.select()` resolves `{ data: null, error: null }`; `.select(cols)` supports `then` and `single` (`single` errors on 0 or >1 rows). Honours `offline`/`failWrites`; add `failWritesOn?: Set<table>`.
   - Simulate the account cascade trigger behind `opts.cascadeTombstones` (default `true`) so a test can prove the client does not depend on it.
   - `delete()` made chainable the same way; `upsert` unchanged (its merge already keeps `deleted_at`, matching PostgREST); `project()` already handles the widened select.
5. `sync.test.ts` imports from the fixture; `npm test` must be green with zero semantic change. Add `lib/__tests__/syncFixture.test.ts` with two checks: `update` stamps `updated_at` and returns no error on zero rows; `is(null)` matches missing keys.

### W1 — Server migration, purge, docs

Owner files: `supabase/migrations/005_tombstones.sql` (new), `README.md`, `CONTRIBUTING.md` (§1 Sync Engine, §2 soft-delete pattern, §4 Known Issues).

`005_tombstones.sql`, idempotent in the style of 003/004:

```sql
alter table accounts        add column if not exists deleted_at timestamptz;
alter table transactions    add column if not exists deleted_at timestamptz;
alter table recurring_rules add column if not exists deleted_at timestamptz;

-- #22: the incremental pull is `where user_id = ? and updated_at > ?`
create index if not exists idx_transactions_user_updated on transactions(user_id, updated_at);
create index if not exists idx_recurring_rules_user      on recurring_rules(user_id);

-- Replaces the FK cascade a tombstone no longer fires. Children's own
-- BEFORE UPDATE triggers bump updated_at, so other devices pull the subtree.
create or replace function tombstone_account_children() returns trigger as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update transactions    set deleted_at = new.deleted_at where account_id = new.id and deleted_at is null;
    update recurring_rules set deleted_at = new.deleted_at where account_id = new.id and deleted_at is null;
  end if;
  return new;
end; $$ language plpgsql;
drop trigger if exists accounts_tombstone_children on accounts;
create trigger accounts_tombstone_children after update of deleted_at on accounts
  for each row execute function tombstone_account_children();

-- Born dead: an offline device inserting into an account another device already
-- deleted must not create a live orphan (today the FK rejects it; now it can't).
create or replace function inherit_account_tombstone() returns trigger as $$
declare parent_deleted timestamptz;
begin
  select deleted_at into parent_deleted from accounts where id = new.account_id;
  if parent_deleted is not null then
    new.deleted_at := coalesce(new.deleted_at, parent_deleted);
  end if;
  return new;
end; $$ language plpgsql;
drop trigger if exists transactions_inherit_tombstone on transactions;
create trigger transactions_inherit_tombstone before insert or update of account_id on transactions
  for each row execute function inherit_account_tombstone();
drop trigger if exists recurring_rules_inherit_tombstone on recurring_rules;
create trigger recurring_rules_inherit_tombstone before insert or update of account_id on recurring_rules
  for each row execute function inherit_account_tombstone();

-- Not scheduled; run by hand. Retention must comfortably exceed the client's
-- RECONCILE_INTERVAL (24h): a device offline longer than this relies on the
-- periodic reconcile to notice purged rows.
create or replace function purge_tombstones(retention interval default interval '30 days')
returns table(rules bigint, transactions bigint, accounts bigint)
language plpgsql security definer set search_path = public as $$
begin
  with r as (delete from recurring_rules where deleted_at < now() - retention returning 1),
       t as (delete from transactions    where deleted_at < now() - retention returning 1),
       a as (delete from accounts        where deleted_at < now() - retention returning 1)
  select (select count(*) from r), (select count(*) from t), (select count(*) from a)
    into rules, transactions, accounts;
  return next;
end; $$;
revoke execute on function purge_tombstones(interval) from anon, authenticated;
```

Docs:

- `README.md:126-131`: add `005_tombstones.sql -- Soft-delete tombstones, cascade triggers, missing indexes, purge_tombstones()`; one-line note that 005 must run before deploying a client that includes tombstones.
- `CONTRIBUTING.md`: rewrite the `pullChanges` bullet (`:21`) for the incremental tombstone path plus the periodic reconcile and its meta key; `requestPush` bullet (`:18`) says deletes are tombstones, splits stay hard-deleted, server triggers cascade; conflict resolution (`:23`) adds "delete wins over a concurrent edit"; sync meta keys (`:24`) list the new key; soft-delete pattern (`:48`) says push writes `deleted_at` server-side; §4 retires `:163` (#18) and `:164` (#19), narrows the clock-skew bullet (`:151-157`) to the periodic pass, drops the obsolete "No schema migration system" bullet (`:166`), and adds the retention-vs-reconcile invariant, the deploy-order gotcha, and "a truly-emptied account whose tombstones were purged needs Reset & re-download, because an empty enumeration is never honoured for deletes".

Verify: `npm run format:check` (prettier covers md); SQL reviewed by a second agent; the user runs 005 in the Supabase SQL editor and confirms `\d transactions` shows the column, indexes, and triggers, and that `select * from purge_tombstones('0 seconds')` returns a row.

### W2 — Push tombstones

Owner: `lib/sync.ts` functions `serverUpdatedAt` (`:315-318`), `pushChanges` (`:325-449`), `pushTable` (`:451-497`) only. New `lib/__tests__/syncPushTombstones.test.ts`.

1. `pushTable` deleted loop (`:487-496`): `.update({ deleted_at: now }).eq('id', row.id).is('deleted_at', null)`; on `!error`, `DELETE FROM ${table} WHERE id = ? AND _sync_status = 'deleted'`.
2. `pushChanges` deleted-transactions loop (`:414-434`): batch ids in chunks of 200: `.update({ deleted_at: now }).in('id', batch).is('deleted_at', null)`; on success, best-effort `transaction_splits.delete().in('transaction_id', batch)`, then local `DELETE FROM transaction_splits WHERE transaction_id IN (...)` and `DELETE FROM transactions WHERE id IN (...) AND _sync_status = 'deleted'`. Parent first, splits second (today's order leaves a live parent with no splits if the parent write fails).
3. Remove the dead deleted-rules loop at `:436-448` (`pushTable('recurring_rules')` at `:334` already hard-deleted those rows locally, so its SELECT never returns anything).
4. Read-back: `.select('id, updated_at, deleted_at')` at `:351` and `:467`; add `serverDeletedAt(data)`. In both pending loops, if the server reports `deleted_at`: skip mark-synced and the split upload; delete locally with `WHERE id=? AND updated_at=? AND _sync_status='pending'` (splits first for transactions). A newer mid-flight edit stays pending and hits the tombstone again next push.
5. Comment block documenting "delete wins" and the trigger cascade interplay; push order stays accounts → rules → transactions (the client still pushes child tombstones and must not depend on the trigger; `.is('deleted_at', null)` makes them idempotent no-ops).

Tests (`syncPushTombstones.test.ts`, via `wireSyncMocks` and `serverNow`):

- tombstones a deleted transaction instead of hard-deleting it (remote `deleted_at` set, `updated_at === serverNow`, local row and splits gone).
- tombstones deleted accounts and rules via `pushTable`.
- treats a zero-row tombstone update as success (never pushed or already purged).
- does not re-stamp an already-tombstoned row (`updated_at` unchanged).
- drops a pending edit locally when its push lands on a tombstone.
- keeps a newer mid-flight edit pending when its push lands on a tombstone (via `onAfterUpsert`).
- tombstones the parent even when the remote split delete fails (`failWritesOn: transaction_splits`).
- batches transaction tombstones (450 deleted rows).
- existing `does not resurrect a row deleted mid-push` (`sync.test.ts:1070`) stays green.

### W3 — Pull tombstones, periodic reconcile, #19

Owner: `lib/sync.ts` functions `initialPull` (`:175-298`), `pullChanges` (`:499-524`), `pullTableFull` (`:526-592`), `planTransactionReconcile` and its interfaces (`:594-653`), `pullTransactions` (`:655-816`), plus a top-level exported `RECONCILE_INTERVAL_MS`. New `lib/__tests__/syncPullTombstones.test.ts`. One edit in `sync.test.ts:368-375` (that test passes `remote: []`; give it an unrelated remote id).

1. Export `pullChanges` "for direct testing" (mirrors `pushChanges`).
2. `initialPull`: `.is('deleted_at', null)` on the accounts, rules, and transactions selects (`:200-203`, `:214-217`, `:232-237`); set `last_txn_reconcile_at:${userId}` alongside the other two keys (`:281-283`).
3. `pullTableFull`: `const live = data.filter(r => !isTombstone(r))`; `remoteIds` from `live`; the upsert/force loop iterates `live` only. #19: if `data.length === 0 && localUpdatedById.size > 0`, warn and skip the delete loop.
4. `pullTransactions` step 1: `isTombstone(row) ? deleteLocalTransactionIfSynced(db, row.id) : (upsertRemoteTransaction + pulledTxnIds.push)`.
5. Step 2 gated by `last_txn_reconcile_at` (missing or older than `RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000`, compared against `pullStartedAt`). Enumeration (`:707-712`) and refresh batch (`:769-772`) add `.is('deleted_at', null)`. After a completed pass (no `reconError`, remote non-empty) set the key to `pullStartedAt`.
6. `planTransactionReconcile`: `if (remote.length === 0) return { toRefresh: [], toDelete: [] };` with a comment citing #19.
7. Existing `pullStartedAt`/`reconcilable` logic stays for the periodic pass only; the incremental tombstone path does not need it (a tombstone is an explicit per-id assertion, and any push onto that id lands on the tombstoned server row).

Tests (`syncPullTombstones.test.ts`):

- `initialPull` excludes tombstoned accounts, rules, transactions and their splits; sets `last_txn_reconcile_at`.
- incremental pull applies a tombstone to a synced local row and drops its splits (reconcile fresh, so only step 1 runs; assert the enumeration was never queried via a counting fake).
- incremental pull never drops a pending local edit on a tombstone.
- incremental pull ignores a tombstone for a row never stored locally.
- periodic reconcile is skipped while fresh; runs when stale or never run and deletes server-removed rows; advances the key to the pull-start snapshot.
- reconcile enumeration treats tombstoned rows as absent (tombstone older than cursor).
- empty enumeration never deletes (#19) and the key is not advanced.
- `planTransactionReconcile` never deletes when remote is empty (pure).
- `pullTableFull` routes an account tombstone to a scoped local delete (synced gone, pending kept); skips deletes on an empty remote read (#19).
- `upsertRemoteTransaction` and `forceUpsertRemoteTransaction` refuse tombstoned rows (guards from W0).
- existing `heals drift, pulls missing, deletes removed` (`sync.test.ts:457`), `pullTableFull self-heal` (`:587`) and the `resetLocalData` suites stay green (no key → reconcile runs).

### W4 — Realtime tombstones and scoped DELETE

Owner: `lib/hooks/useRealtimeSync.ts`, `lib/realtimeHandlers.ts` (new), `lib/__tests__/realtimeHandlers.test.ts` (new), one new §4 bullet in CONTRIBUTING noting the remaining #21 items (coordinate the paragraph position with W1; a one-line append is enough).

1. `lib/realtimeHandlers.ts`: `applyAccountEvent(db, payload)` and `applyTransactionEvent(db, payload)`, free of React and the query client. `DELETE` → `deleteLocal*IfSynced(payload.old.id)`; `INSERT`/`UPDATE` with `isTombstone(payload.new)` → `deleteLocal*IfSynced(payload.new.id)`; otherwise `upsertRemote*` as today. Imports the upserts from `./sync` (the hook already does) and helpers from `./tombstones`.
2. `useRealtimeSync.ts`: handlers call the new functions; invalidation logic unchanged (debouncing, split persistence, and the rules channel stay under #21).

Tests (`realtimeHandlers.test.ts`, fixture from W0 with the same `jest.mock('../supabase')`/`jest.mock('../db')` preamble as `sync.test.ts:9-14`):

- `UPDATE` with `deleted_at` deletes a synced local transaction and its splits; leaves a pending one untouched; inserts nothing for an unknown id (the resurrection case).
- `DELETE` is scoped to synced rows.
- `INSERT`/`UPDATE` without `deleted_at` upserts as before.
- account equivalents of the first three.

## Sequencing and merge

1. W0 on the integration branch; `npm test` green.
2. W1–W4 branch from that commit. Merge order back: W4, W3, W2, W1 (docs last so line references are final). `lib/sync.ts` hunks are non-adjacent by construction (W0: `:818-1086`; W2: `:315-497`; W3: `:175-298`, `:499-816`, top-of-file constant).
3. Integration pass by the lead: full gate, then a read-through of `pushChanges`/`pullTransactions` end to end.

## Verification

Per workstream: `npm ci && npm run typecheck && npm run lint && npm run format:check && npm test`, and once with `npx jest --maxWorkers=1` (the better-sqlite3 cross-realm caveat at `migrations.test.ts:53-64`).

Integration:

1. The CI gates in `.github/workflows/test.yml`: the above plus `npx expo export -p web` and `npm run electron:tsc`.
2. User runs `005_tombstones.sql` in the Supabase SQL editor (before deploying the client); confirms column, indexes, triggers; `select * from purge_tombstones('0 seconds')` on a throwaway user returns counts; `anon`/`authenticated` cannot call it.
3. Two-device manual check (web plus iOS, or two browser profiles): delete a transaction on A → vanishes on B via realtime and does not reappear on A; B edits T offline while A deletes T → after B reconnects T is gone on both and `select count(*) from transactions where id = ... and deleted_at is null` is 0; delete an account with rules and transactions on A → children carry `deleted_at` server-side and B clears them in one pull.
4. Network tab on a sync within 24 h of the last reconcile: no paged `select=id,updated_at` enumeration; it appears once after clearing `last_txn_reconcile_at` or after the interval.
5. Settings → "Reset & re-download from cloud" still works, sets all three meta keys, downloads no tombstones.
6. An older client build against the new schema: deletes still work, pulls succeed, no console errors.
7. `npm run e2e:web` locally if `.env.e2e` exists (CI skips without secrets, #16).

## Out of scope

- #20 `updated_at` on `transaction_splits` (needs the local migration ladder; independent).
- #21 remaining bullets: persisting split changes from realtime, the rules channel, invalidation debouncing.
- Scheduling `purge_tombstones` via `pg_cron`; it ships unscheduled with the retention invariant documented.

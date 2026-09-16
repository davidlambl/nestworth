-- Backlog #20: transaction_splits gets an updated_at, so push can tell whether
-- the split rows it marks 'synced' are the ones it uploaded.
--
-- Split sync is delete-then-reinsert: push deletes every remote split for a
-- transaction, reinserts the local ones, and then marks them 'synced'. Until
-- now that last step was `where transaction_id = ?` and nothing else, because
-- there was no per-row timestamp to compare. A split edit landing during the
-- network round trip therefore had its 'pending' status overwritten by the
-- reply to the PREVIOUS upload, and the next push never replayed it: the edit
-- was silently lost, and the local store disagreed with the server with nothing
-- to notice it. The parent transaction has been guarded that way since
-- tombstones shipped (id + the updated_at we read + still 'pending'); this
-- column is what lets the splits carry the same guard.
--
-- This SUPERSEDES the paragraph in 005_tombstones.sql that says splits
-- "deliberately do NOT get one ... no user_id ... and no updated_at, so there is
-- no cursor by which a tombstone on it could ever be pulled". That reasoning was
-- about `deleted_at`, and it still holds: splits still get no tombstone, they
-- still ride their parent, and they are still hard-deleted. `updated_at` here is
-- not a pull cursor. It exists for the push read-back's optimistic guard, and
-- (later) for #21's realtime split handler, which needs a per-row timestamp to
-- order events by.
--
-- DEPLOY ORDER: run this file BEFORE deploying a client build that includes it.
-- The new client sends `updated_at` in its split INSERT and selects it back;
-- against the old schema PostgREST rejects both with PGRST204/42703, which
-- fails the split upload, leaves the parent transaction 'pending' forever and
-- surfaces as "N pending changes" with no explanation. (pushChanges now
-- reports that case through setLastError, naming this file, instead of
-- retrying in silence.) The reverse order is safe: an old client omits the
-- column on insert and takes the default, and its `select *` pulls simply
-- ignore a column it does not map.
--
-- Idempotent: safe to run twice, in the style of 002/003/004/005.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- `not null default now()` rather than nullable: every existing row gets a
-- real timestamp in this statement, so the client's guard never has to reason
-- about a NULL it wrote itself, and an old client that omits the column on
-- INSERT still produces a valid row. Postgres 11+ stores the default in the
-- catalog for the existing rows, so this is not a table rewrite.
--
-- The client is still NULL-tolerant everywhere it compares this column: a split
-- pulled from a pre-006 server, or one the local backfill could not reach,
-- legitimately holds NULL locally, and a local NULL is sent as an ABSENT key
-- rather than an explicit null so it takes the default here.
alter table transaction_splits
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 2. The trigger that maintains it
-- ---------------------------------------------------------------------------
-- Same `update_updated_at()` the other three tables have used since
-- 001_initial.sql (which defines it with `create or replace`, so it is already
-- present). Splits are normally rewritten rather than updated in place, but an
-- out-of-band UPDATE -- a server-side correction, a fix in the SQL editor --
-- must move the timestamp too, or the client's guard compares against a value
-- the server has silently invalidated.
--
-- `drop trigger if exists` first: Postgres has no `create trigger if not
-- exists`, and this file must be safe to run twice (migrate.yml applies it in
-- one transaction with ON_ERROR_STOP).
drop trigger if exists transaction_splits_updated_at on transaction_splits;

create trigger transaction_splits_updated_at
  before update on transaction_splits
  for each row execute function update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. What deliberately does NOT change
-- ---------------------------------------------------------------------------
-- RLS: 001's splits policy is `for all using (exists (select 1 from
-- transactions t where t.id = transaction_splits.transaction_id and t.user_id =
-- auth.uid()))`, with no WITH CHECK, so Postgres reuses the USING expression for
-- writes. It names no columns of transaction_splits other than transaction_id,
-- so a new column changes nothing about who may read or write a split.
--
-- Realtime: 001 already publishes transaction_splits, and a publication covers
-- columns added later, so #21's future split handler will see `updated_at` in
-- the payload without another migration.
--
-- No index: nothing queries splits BY updated_at. They are fetched by
-- transaction_id (idx_transaction_splits_txn, 001) and pulled by piggybacking
-- on the parent; the column is read back per-row on the id the insert returned.

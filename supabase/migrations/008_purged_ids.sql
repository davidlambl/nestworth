-- Backlog #98: remember the ids purge_tombstones() removes and refuse to
-- re-insert them, so "delete wins over a concurrent edit" outlives the purge.
--
-- Delete wins because a tombstone survives a concurrent edit: the client's
-- upsert never carries deleted_at, PostgREST writes only the keys it is sent,
-- and the push reads the tombstone back and drops its local copy (005). Since
-- 007 schedules the purge, that guarantee has an expiry date. Once
-- purge_tombstones() has reclaimed the tombstone, 30 to 37 days after the
-- delete, nothing is left to conflict with, and a device that pushes a stale
-- pending edit to that row INSERTS it as live -- as hard deletes did -- and
-- every other device pulls it back. A reorder makes that the common case
-- rather than a corner: it rewrites sort_order on every active account, so one
-- tap on a device that has been away since before the deletes re-inserts every
-- account deleted elsewhere whose tombstone has been purged since, followed by
-- that device's pending children.
--
-- So the purge now writes down what it removes -- the id of every account,
-- transaction and rule it deletes, the children its account delete cascades
-- out included -- in purged_ids, and a BEFORE INSERT trigger on each of those
-- three tables refuses a recorded id with SQLSTATE 23503 and HINT 'purged'.
-- The client (isPurgedRowError in lib/sync.ts) takes that answer the way it
-- takes a read-back tombstone: it drops the local row, splits included, under
-- the same guard. The hint is the contract. A hint-less 23503 is what
-- inherit_account_tombstone raises for a row the server has never held (005,
-- section 4), and what the foreign key raises for a child of an account that
-- is gone; the client keeps those rows, because dropping them would destroy
-- what the user typed.
--
-- NO FALSE REFUSALS. A row created offline has a fresh id, which no purge ever
-- recorded, so it inserts as before. A live row is not recorded: the purge
-- records only rows it is about to delete, and it adopts any live child of a
-- dead account (005's sweep) before it records anything. The one exception is
-- a push that races the purge's own transaction (item 5 below), which can put
-- a row back live in the instant its id is recorded. The trigger is BEFORE
-- INSERT, and Postgres fires BEFORE INSERT for the proposed row even when
-- `insert ... on conflict do update` goes on to update, so every client upsert,
-- edits included, pays one primary-key lookup here; for a live row it finds
-- nothing and the upsert goes on exactly as before.
--
-- WHAT THIS DOES NOT COVER.
--   1. A record is kept for a year (purged_ids_retention, section 2), and each
--      run trims older ones: an edit pushed more than a year after the purge
--      re-inserts the row, as before.
--   2. An id purged before this file was applied was never recorded. Nothing
--      is old enough to purge before 2026-10-13, and the first scheduled run
--      that can delete anything is Sunday 2026-10-18 04:00 UTC (007's header),
--      so applying this before then -- with no purge run by hand meanwhile --
--      leaves no gap.
--   3. A row created offline under an account that has since been deleted and
--      purged has a fresh id, so it passes this trigger and meets the foreign
--      key instead: a hint-less 23503, and the row stays pending on that
--      device, retried on every push, with nothing in the UI saying why (the
--      born-dead bullet in CONTRIBUTING.md section 4). Resolving it (re-parent
--      or drop, with a Settings line) is client work for a follow-up.
--   4. transaction_splits gets no guard. A split has no tombstone of its own
--      and rides its parent (005, section 1), and every client uploads a
--      parent's splits only after the parent's own upsert succeeded, which
--      this trigger now refuses.
--   5. A push that races the purge itself. Under READ COMMITTED the push
--      cannot see a record the purge's transaction has not committed yet, so
--      the trigger lets it through. If its upsert then waits on the purge's
--      DELETE of that very row, Postgres retries the insert once the delete
--      commits WITHOUT firing the BEFORE INSERT triggers again, by either of
--      two routes. The unique check waits for the delete and rechecks
--      (check_exclusion_or_unique_constraint in execIndexing.c:
--      XactLockTableWait, then `goto retry`) -- a push whose pre-check runs
--      any time after the DELETE and before the purge commits. Or
--      ExecOnConflictUpdate gets TM_Deleted and ExecInsert goes back to
--      `vlock:` (nodeModifyTable.c) -- the DELETE lands between the pre-check
--      and the row lock. Either way the BEFORE ROW INSERT triggers fired
--      once, before `vlock:`, and the row goes back live while its id stays
--      recorded. Every later edit to it is then refused and dropped on the
--      device that makes it, and the next pull (accounts, rules) or the daily
--      reconcile (transactions) brings the row straight back to that device,
--      so the user sees an edit to one row that never sticks; the row can
--      still be deleted. It takes a pending edit at least 30 days stale
--      landing inside the weekly job's sub-second transaction, and it is no
--      regression: before this file the whole period after the purge was
--      open. The remedy is to let that id back in, as IF THIS FAILS below
--      shows:
--        delete from public.purged_ids where id = '<uuid>';
--      A `lock table ... in share row exclusive mode` in the purge would close
--      the window, but it would block every write to the three tables for the
--      whole run to close a sub-second weekly window, so it is not taken.
--
-- DEPLOY ORDER: run this file BEFORE merging the client that reads the hint.
-- The other order is harmless but useless: until this file lands no refusal
-- carries the hint, so the new client behaves exactly like the old one. An
-- OLD client against this file -- a TestFlight or desktop build not yet
-- upgraded -- gets a refusal instead of a resurrection: it treats the 23503
-- like any failed push and leaves the row pending, retried on every push, until
-- it is upgraded, and its "Reset & re-download" refuses to run over that
-- pending row meanwhile. That is the better failure: a stale edit stuck on one
-- device, instead of a deleted row revived on every device. Nothing can be
-- purged before 2026-10-13, and the schedule purges nothing before 2026-10-18,
-- so until then no client can meet the refusal.
--
-- This SUPERSEDES the paragraph "WHAT THE PURGE GIVES UP" in
-- 007_schedule_purge_tombstones.sql, and CONTRIBUTING.md's "delete wins only
-- while the tombstone exists": within the year above, delete now wins after
-- the purge too. 007 stays exactly as it was applied, and so does 005 -- but
-- 005 can no longer be replayed on its own: it drops and recreates
-- purge_tombstones() without the recording step, so re-run this file after
-- any replay of 005.
--
-- IF THIS FAILS. The file runs in one transaction, so a failure leaves the
-- database as it was. If section 2 is refused ("cannot change return type of
-- existing function", "cannot change name of input parameter ..."), the live
-- function no longer matches 005's definition: inspect it with
-- `\df+ public.purge_tombstones` in psql and bring section 2 in line with its
-- signature. Never add a second overload instead: 007's job runs
-- `select public.purge_tombstones()`, which two candidates with defaulted
-- parameters would make ambiguous. To let one id back in -- a row that must be
-- restored from a device's copy -- delete its record as postgres in the SQL
-- editor; the next push of that row inserts it:
--   delete from public.purged_ids where id = '<uuid>';
-- To see what the purges have recorded:
--   select table_name, count(*), min(purged_at), max(purged_at)
--     from public.purged_ids group by table_name;
--
-- Sources, read 2026-09-24:
--   https://www.postgresql.org/docs/current/trigger-definition.html -- "If
--     more than one trigger is defined for the same event on the same
--     relation, the triggers will be fired in alphabetical order by trigger
--     name" (section 4), and an INSERT with ON CONFLICT DO UPDATE can run
--     row-level BEFORE INSERT and then BEFORE UPDATE triggers.
--   https://www.postgresql.org/docs/current/sql-insert.html -- "the effects of
--     all per-row BEFORE INSERT triggers are reflected in excluded values":
--     they run before the conflict is resolved, whichever way it goes.
--   https://www.postgresql.org/docs/current/sql-createfunction.html -- CREATE
--     OR REPLACE keeps "the ownership and permissions of the function", assigns
--     every other property "the values specified or implied in the command",
--     and cannot change the return type, OUT parameters or the name of an input
--     parameter (section 2).
--   https://docs.postgrest.org/en/stable/references/errors.html -- a Postgres
--     error reaches the client as {code, message, details, hint}, with a
--     RAISE's HINT verbatim in `hint`; 23503 is answered with HTTP 409.
--   @supabase/postgrest-js 2.101.1 (the version this app ships),
--     src/PostgrestBuilder.ts -- a non-2xx body is JSON-parsed and returned as
--     `error` unchanged. A request-level failure is given a hint of its own
--     ('' for a fetch error, 'Request was aborted ...' for a timeout), so no
--     such failure ever carries `hint: 'purged'`.
--   https://supabase.com/docs/guides/database/postgres/row-level-security --
--     new tables in the public schema are granted to anon and authenticated
--     by default, and RLS with no policy returns them nothing (section 1).
--   https://supabase.com/docs/guides/database/database-advisors and
--     https://github.com/supabase/splinter (lints/) -- 0008
--     rls_enabled_no_policy (INFO; section 1), and 0028/0029, which WARN
--     about a security-definer function that anon or authenticated can
--     execute in an exposed schema, with no filter on the return type
--     (section 3).
--   https://github.com/postgres/postgres, REL_17_STABLE (item 5): the two
--     routes into the race. src/backend/executor/execIndexing.c ~775-850 --
--     check_exclusion_or_unique_constraint, called with CEOUC_WAIT for the
--     ON CONFLICT pre-check, waits for an in-progress deleter
--     (XactLockTableWait) and then rechecks (`goto retry`).
--     src/backend/executor/nodeModifyTable.c -- ExecOnConflictUpdate answers
--     a concurrently deleted conflict row (TM_Deleted) with `return false`,
--     which sends ExecInsert back to `vlock:`. ExecInsert fires the BEFORE
--     ROW INSERT triggers once, before that label, on either route.
--
-- Idempotent: safe to run twice, in the style of 005/006/007.

-- ---------------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------------
-- One row per purged id, keyed on (table_name, id) -- exactly the question the
-- trigger in section 3 asks, so every lookup is one probe of the primary key.
-- purged_at is what the one-year trim in section 2 reads.
--
-- Nothing in the app reads or writes this table, and nothing in it is any app
-- session's business. Its owner -- postgres, the role migrate.yml runs as --
-- works it through the two security-definer functions below. service_role
-- keeps ALL on it too, through Supabase's default privileges, and bypasses RLS;
-- that is harmless, since that key never ships in the app. It is deliberately
-- left out of the supabase_realtime publication. Supabase's Security Advisor
-- lists it under 0008 "RLS Enabled No Policy" (INFO): that is the design.
create table if not exists purged_ids (
  table_name text not null,
  id uuid not null,
  purged_at timestamptz not null default now(),
  primary key (table_name, id)
);

-- RLS with no policy: every row is invisible to anon and authenticated, even
-- through a grant. Enabling it again on a rerun is a no-op.
alter table purged_ids enable row level security;

-- And no grant either. Supabase's default privileges grant anon and
-- authenticated everything on each new table in public; take that back, so
-- the table is closed at both layers. Revoking what is not held is a no-op,
-- so a rerun passes.
revoke all on table purged_ids from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. purge_tombstones() records what it deletes
-- ---------------------------------------------------------------------------
-- 005's function with two steps added and nothing else changed. The same
-- signature, return type and OUT names, because CREATE OR REPLACE cannot
-- change any of them -- and must not: a function with a second defaulted
-- parameter would be a second OVERLOAD, and 007's argument-less job command
-- would become ambiguous. That is why the records' own retention is a constant
-- in the body rather than a parameter. The same security definer and
-- search_path, restated because a replacement resets every property it does
-- not state. The same orphan sweep, deletes and counts. CREATE OR REPLACE
-- keeps the owner and the ACL, so 005's revokes still stand.
--
-- The first new step records BEFORE deleting, while the rows can still be
-- read. For each child table the predicate is the delete's own, plus the rows
-- the account delete will take out through the FK cascade: those are removed
-- uncounted (005, section 5) and are exactly as dead. now() is fixed for the
-- whole transaction, so what is recorded and what is deleted are measured
-- against one horizon. (Only a write landing between the two statements could
-- add an unrecorded row to the delete set -- in practice a re-parent into an
-- account dead for longer than the retention, in that same instant -- and that
-- row would merely be unguarded, as every row was before this file.)
-- `on conflict do nothing` keeps the first purged_at of an id recorded twice.
--
-- The second new step trims records older than a year. A year is about twelve
-- times the tombstone retention -- far longer than any device plausibly holds a
-- pending edit before it syncs -- and the table grows by one small row per
-- deleted row until then. The same weekly run keeps it bounded.
create or replace function purge_tombstones(
  retention interval default interval '30 days'
)
returns table (
  purged_rules bigint,
  purged_transactions bigint,
  purged_accounts bigint
)
language plpgsql
-- As 005: a maintenance run has to reach every user's rows, and RLS is not
-- applied to the table owner.
security definer
-- As 005: mandatory under security definer, with pg_temp pinned last so a
-- caller's temporary table cannot shadow a table named below.
set search_path = public, pg_temp
as $$
declare
  -- How long a record is kept. Not a parameter; see the section comment. No
  -- variable here may be called purged_ids: it would shadow the table.
  purged_ids_retention constant interval := interval '1 year';
begin
  -- Unchanged from 005: adopt any live child left under a dead parent before
  -- reclaiming anything (005, section 5, says why).
  update transactions t
     set deleted_at = a.deleted_at
    from accounts a
   where a.id = t.account_id
     and a.deleted_at is not null
     and t.deleted_at is null;

  update recurring_rules r
     set deleted_at = a.deleted_at
    from accounts a
   where a.id = r.account_id
     and a.deleted_at is not null
     and r.deleted_at is null;

  -- New: record what the deletes below will remove, before they remove it.
  -- The second half of each child predicate is the FK cascade set.
  insert into purged_ids (table_name, id)
  select 'recurring_rules', r.id
    from recurring_rules r
   where r.deleted_at < now() - retention
      or exists (select 1
                   from accounts a
                  where a.id = r.account_id
                    and a.deleted_at < now() - retention)
  on conflict do nothing;

  insert into purged_ids (table_name, id)
  select 'transactions', t.id
    from transactions t
   where t.deleted_at < now() - retention
      or exists (select 1
                   from accounts a
                  where a.id = t.account_id
                    and a.deleted_at < now() - retention)
  on conflict do nothing;

  insert into purged_ids (table_name, id)
  select 'accounts', a.id
    from accounts a
   where a.deleted_at < now() - retention
  on conflict do nothing;

  -- Unchanged from 005: children first, parents last, each count taken from
  -- its own statement (005, section 5, says why).
  delete from recurring_rules where deleted_at < now() - retention;
  get diagnostics purged_rules = row_count;

  delete from transactions where deleted_at < now() - retention;
  get diagnostics purged_transactions = row_count;

  delete from accounts where deleted_at < now() - retention;
  get diagnostics purged_accounts = row_count;

  -- New: trim records past their own retention. Everything recorded above
  -- carries this run's now(), so none of it can go here.
  delete from purged_ids where purged_at < now() - purged_ids_retention;

  -- As 005: RETURNS TABLE makes the three names OUT parameters, so a bare
  -- RETURN NEXT emits their current values as the single result row.
  return next;
  return;
end;
$$;

-- Re-issued, though CREATE OR REPLACE kept 005's ACL and both are no-ops here,
-- so that anyone auditing the grants reads them next to the definition. PUBLIC
-- first, for 005's reason: a role-level revoke does not strip a privilege held
-- through PUBLIC.
revoke execute on function purge_tombstones(interval) from public;
revoke execute on function purge_tombstones(interval) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The guard
-- ---------------------------------------------------------------------------
-- Refuses a row whose id a purge recorded, with the SQLSTATE the client already
-- treats as "refused, keep it pending" -- 23503, as 005's born-dead refusal and
-- the foreign key use -- plus the hint that says this refusal means "deleted".
-- The client drops the row only when both are present.
--
-- security definer, because the caller cannot read purged_ids (section 1) and
-- a trigger function otherwise runs with the privileges of whoever issued the
-- statement: without it, EVERY client insert and upsert on the three tables
-- would fail on the lookup. It runs as its owner, who owns the table, with
-- search_path pinned and pg_temp last as everywhere in 005.
--
-- The table name is compared as text, not as tg_table_name itself. That is a
-- `name`, which compares under collation "C" while the column has the default
-- one, so Postgres cannot use the table_name half of the primary key and is
-- left with the id half alone: a scan of the whole index before PostgreSQL
-- 18, several index searches with its skip scan. A text variable takes the
-- default collation, and the lookup is one probe of both columns (EXPLAIN and
-- the index counters, checked on PostgreSQL 18).
--
-- No tg_op check: the triggers below fire on INSERT only.
create or replace function reject_purged_id() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tbl constant text := tg_table_name;
begin
  if exists (
    select 1
      from purged_ids
     where table_name = tbl
       and id = new.id
  ) then
    raise exception '% % was deleted and its tombstone has been purged',
                    tbl, new.id
      using errcode = '23503', hint = 'purged';
  end if;
  return new;
end;
$$;

-- EXECUTE revoked as 005 revokes it, but for the advisor, not for safety: a
-- trigger fires its function without checking EXECUTE, and a direct call
-- never runs the body either way -- it fails with 0A000 ("trigger functions
-- can only be called as triggers"), or, for a role this revokes, with 42501
-- before that. Supabase's Security Advisor lists every security-definer
-- function in an exposed schema that anon or authenticated can execute
-- (lints 0028 and 0029, which do not look at the return type), and this
-- would otherwise be listed twice. PUBLIC first, for 005's reason: a
-- role-level revoke does not strip a privilege held through PUBLIC. Both are
-- no-ops on a rerun, since CREATE OR REPLACE keeps the ACL.
revoke execute on function reject_purged_id() from public;
revoke execute on function reject_purged_id() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The triggers, named to fire first
-- ---------------------------------------------------------------------------
-- Postgres fires the triggers on one event in alphabetical order by name, so
-- the name is load-bearing. `<table>_guard_purged_id` sorts before every
-- BEFORE INSERT trigger 005 put on these tables (`*_inherit_tombstone`,
-- `*_normalize_deleted_at`; 001's `*_updated_at` fires on UPDATE only). The one
-- that matters is inherit_account_tombstone. A purged transaction or rule whose
-- account is tombstoned but not yet purged would meet ITS refusal first -- a
-- hint-less 23503, since the row no longer exists -- and the client would keep
-- the row pending forever instead of dropping it. Named `*_reject_*`, this
-- trigger would sort after `*_inherit_*` and lose exactly that case.
--
-- BEFORE INSERT only. An UPDATE cannot bring a purged row back -- it matches no
-- row -- and the client's tombstone push is an UPDATE that must keep matching
-- nothing and succeeding. `drop trigger if exists` first, as in 005 and 006:
-- there is no `create trigger if not exists`, and this file must be safe to
-- run twice.
drop trigger if exists accounts_guard_purged_id on accounts;
create trigger accounts_guard_purged_id
  before insert on accounts
  for each row execute function reject_purged_id();

drop trigger if exists transactions_guard_purged_id on transactions;
create trigger transactions_guard_purged_id
  before insert on transactions
  for each row execute function reject_purged_id();

drop trigger if exists recurring_rules_guard_purged_id on recurring_rules;
create trigger recurring_rules_guard_purged_id
  before insert on recurring_rules
  for each row execute function reject_purged_id();

-- Backlog #189: a transaction's or a recurring rule's account must belong to
-- the row's own user.
--
-- WHY. Each of the two tables has one row-level-security policy, 001's
-- `auth.uid() = user_id`, which looks at the row's own user and nothing else,
-- and a foreign key on account_id, which Postgres checks past row-level
-- security. So the server takes a transaction or a rule filed under ANOTHER
-- user's account: the policy sees the caller's own user_id, and the foreign key
-- finds the account. 005's inherit_account_tombstone() does not catch it
-- either: it is not security definer, so its read of accounts runs under the
-- caller's policy, finds no row, and lets the write through.
--
-- Several accounts sign in on one device in turn, and signing out wipes no
-- local rows, so another account's accounts stay on the device. Every creator
-- in the app has refused them since #177 (1.4.0), but a build without that
-- check -- a web tab loaded before 1.4.0 and not reloaded since, a TestFlight
-- or desktop build not yet upgraded -- files the signed-in user's row under the
-- other account's id when a screen still holds it. The row's owner never sees
-- it again (every list is of the user's own accounts since #177), and the
-- account's owner takes it with them -- not through 005's cascade, whose
-- function is not security definer: its UPDATEs run under the deleting user's
-- row-level security and never see another user's row. The row stays live
-- under the dead account until the weekly purge adopts it (stamps it, which
-- removes it from its owner's devices at their next pull) and, 30 days after
-- the account's delete, deletes the account, whose foreign key cascade takes
-- the row for good. Production held no such row when this file was written
-- (0 transactions and 0 rules, read 2026-10-23).
--
-- WHAT. A BEFORE INSERT OR UPDATE OF account_id, user_id trigger on both tables
-- refuses a row unless its account exists and belongs to the row's user:
-- SQLSTATE 23503, the foreign key's own code, and no hint. That is the answer
-- the app already handles as it should (lib/syncRefusals.ts, #115): the row is
-- kept, pending, and Settings lists it as one whose account it cannot be
-- uploaded under, with Move -- to one of the user's own accounts, after which
-- the next push inserts it -- and Discard. Any other class-23 code would be
-- listed as a refusal of the row's own data, with no Move; and the hint must
-- never be 'purged', which tells the app to drop the row (008) -- here, to
-- destroy what the user typed. One message for an account that is another
-- user's and for one that does not exist, so a caller writing its own rows
-- learns nothing about an account it cannot read. A caller writing a row in
-- ANOTHER user's name learns one thing: whether the account is that user's
-- (RLS then refuses the row, 42501) or not (this check, 23503), since this
-- check runs before RLS's. Both ids are random UUIDs, and the one place a
-- sign-in meets another user's ids is a device both use, which stores them.
--
-- security definer, so the check reads every account, whoever writes: it is a
-- question about the row (do its account's owner and its own user agree?),
-- never about the caller, which stays RLS's to answer. As an invoker-rights
-- function under the caller's policy it would see only the caller's accounts,
-- and would refuse with 23503 a well-formed row sent by a session signed in as
-- someone else -- an answer the app keeps as permanent, under that row's user,
-- where RLS's 42501 is transient. The owner, postgres, owns accounts and
-- bypasses row-level security (rolbypassrls; accounts is not FORCE ROW LEVEL
-- SECURITY: both read 2026-10-23), with search_path pinned and pg_temp last
-- as everywhere in 005 and 008.
--
-- `update of account_id, user_id`. PostgREST's upsert names every column of
-- the payload in its DO UPDATE SET list, so an edit pushed for an existing row
-- is checked twice -- BEFORE INSERT for the proposed row (Postgres fires it
-- even when ON CONFLICT goes on to update, as 005 notes), and this BEFORE
-- UPDATE OF -- two primary-key probes of accounts. A tombstone is an
-- `update ... set deleted_at`, which names neither column: a row filed under
-- another user's account before this file can still be deleted, and 005's
-- cascade and purge_tombstones()' adoption, which set deleted_at alone, never
-- meet this check.
--
-- WHAT THIS DOES NOT COVER.
--   1. Rows already there. Section 3 counts them, as postgres, and warns with
--      the counts in the run's log (0 when this file was written). Such a row
--      stays where it is: any write that names its account or its user is
--      refused from now on, while its tombstone still goes through. No screen
--      of a current build lists it (its account is in none of its owner's
--      lists), so only an edit an older build left pending meets this check,
--      and Settings lists it, to move; until then the purge can still take
--      it (WHY, above). Once the purge has adopted it, that edit is listed
--      all the same, and its Move lands on the tombstone, which the push then
--      drops: two steps where an edit of a tombstoned row is dropped at once.
--   2. An account whose own user_id changes. No app session can change it
--      (001's policy is both the USING and the WITH CHECK of every write to
--      accounts); postgres or the service role could, and this checks only
--      the child's write. A composite foreign key would refuse that too; it
--      was weighed and not chosen (the pull request that added this file
--      says why).
--   3. transaction_splits. A split has no user_id and rides its parent (005,
--      section 1); every client uploads a parent's splits only after the
--      parent's own upsert succeeded, which this trigger refuses.
--   4. accounts. An account's only owner is its own user_id, which 001's
--      policy already pins to the caller.
--   5. The born-dead race of 005, section 4: unchanged.
--   6. A row of the user's own under an account that is gone (purged): this
--      trigger now answers it, with its own words, before the foreign key
--      would -- the same code, no hint, so the app cannot tell the two apart
--      and treats it as before.
--
-- DEPLOY ORDER. No build depends on this file: every build already takes a
-- hint-less 23503 as a refusal of the row's account and leaves the row
-- pending. What each build does with a row this refuses: 1.4.0 and later
-- (#115) list it in Settings ("N change(s) can't be uploaded") to move or
-- discard, and none of them files a new one (#177); a build before 1.4.0
-- leaves it pending, retries it on every push and counts it among the changes
-- waiting to upload, with nothing saying why, and its "Reset & re-download"
-- refuses over it -- 005's born-dead row exactly -- until the device runs
-- 1.4.0 or later, which lists it. The owner dispatches this file through
-- migrate.yml (in the `migrate` environment, #190).
--
-- IF THIS FAILS. The file runs in one transaction, so a failure leaves the
-- database as it was, and running it again is safe. CREATE TRIGGER takes a
-- SHARE ROW EXCLUSIVE lock on each of the two tables (and on a rerun DROP
-- TRIGGER, finding the trigger, an ACCESS EXCLUSIVE one, which holds back
-- reads too), held until the file commits -- milliseconds. While it waits for
-- one, every write that arrives after it waits behind it, so section 0 gives
-- up after 3 s: "canceling statement due to lock timeout" (55P03) means
-- something held a table that long -- a transaction left open in the SQL
-- editor, the Sunday 04:00 UTC purge -- and the run changed nothing; dispatch
-- it again. The app's writes give up after their own 8 s (55P03, 57014),
-- which the 3 s keeps them inside, and are retried as transient failures. To
-- take this file off again, as postgres in the SQL editor:
--   drop trigger if exists transactions_guard_user_account
--     on public.transactions;
--   drop trigger if exists recurring_rules_guard_user_account
--     on public.recurring_rules;
--   drop function if exists public.reject_cross_user_account();
-- To list the rows filed under another user's account (section 3's query):
--   select 'transactions' as tbl, t.id, t.user_id, t.account_id,
--          a.user_id as account_user
--     from public.transactions t join public.accounts a on a.id = t.account_id
--    where a.user_id <> t.user_id
--   union all
--   select 'recurring_rules', r.id, r.user_id, r.account_id, a.user_id
--     from public.recurring_rules r
--     join public.accounts a on a.id = r.account_id
--    where a.user_id <> r.user_id;
--
-- Sources, read 2026-10-23:
--   https://www.postgresql.org/docs/17/ddl-rowsecurity.html -- "Referential
--     integrity checks, such as unique or primary key constraints and foreign
--     key references, always bypass row security"; "Table owners normally
--     bypass row security as well"; "Superusers and roles with the BYPASSRLS
--     attribute always bypass the row security system".
--   https://www.postgresql.org/docs/17/sql-createpolicy.html -- "WITH CHECK
--     expressions are enforced after BEFORE triggers are fired, and before any
--     actual data modifications are made": this trigger answers before RLS.
--   https://www.postgresql.org/docs/17/trigger-definition.html -- triggers on
--     one event fire "in alphabetical order by trigger name"; an INSERT with
--     ON CONFLICT DO UPDATE can run "row-level BEFORE INSERT and then BEFORE
--     UPDATE triggers".
--   https://www.postgresql.org/docs/17/sql-createtrigger.html -- a
--     column-specific trigger "will fire when any of its columns are listed as
--     targets in the UPDATE command's SET list", whatever the value.
--   https://www.postgresql.org/docs/17/sql-createfunction.html -- for a
--     security definer function, write pg_temp last in search_path, and revoke
--     the default PUBLIC execute privilege.
--   https://www.postgresql.org/docs/17/explicit-locking.html -- SHARE ROW
--     EXCLUSIVE is "Acquired by CREATE TRIGGER", and conflicts with the ROW
--     EXCLUSIVE lock writes take; locks are held until the transaction ends.
--   https://www.postgresql.org/docs/17/runtime-config-client.html --
--     lock_timeout aborts "any statement that waits longer than the specified
--     amount of time while attempting to acquire a lock"; "The time limit
--     applies separately to each lock acquisition attempt."
--   PostgreSQL REL_17_STABLE, src/backend/storage/lmgr/lock.c -- "If lock
--     requested conflicts with locks requested by waiters, must join wait
--     queue."
--   PostgREST v12.2.3, src/PostgREST/Query/QueryBuilder.hs -- an upsert's
--     "DO UPDATE SET" lists every inserted column (iCols).
--   lib/syncRefusals.ts (refusalKind) -- class 22 and 23 are permanent, 23503
--     is the 'account' kind unless its hint is 'purged'.
--
-- Idempotent: safe to run twice, in the style of 005 to 009.

-- ---------------------------------------------------------------------------
-- 0. A bound on every wait for a lock
-- ---------------------------------------------------------------------------
-- Postgres queues a lock request behind any WAITING request it conflicts with,
-- so while CREATE TRIGGER waits for the writes in flight on its table, every
-- app write that arrives meanwhile waits behind it. The role that runs this
-- file, postgres, has no lock_timeout, and the server's statement_timeout is
-- 2 minutes (both read 2026-10-23), against 8 s for the app's requests
-- (authenticator's lock_timeout): unbounded, a table held by one long
-- transaction would fail the app's writes to it for up to 2 minutes. 3 s
-- keeps them inside their 8 s and fails this run instead, with nothing
-- applied. LOCAL: this transaction only, so nothing outlives the file.
set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The check
-- ---------------------------------------------------------------------------
-- No tg_op test: the same question on an insert and on an update that names
-- the account or the user.
create or replace function reject_cross_user_account() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from accounts a
     where a.id = new.account_id
       and a.user_id = new.user_id
  ) then
    raise exception 'account % is not this user''s', new.account_id
      using errcode = '23503';
  end if;
  return new;
end;
$$;

-- As 008: for the advisor, not for safety. A trigger fires its function
-- without checking EXECUTE, and a direct call never runs the body. Supabase's
-- Security Advisor lists every security-definer function in an exposed schema
-- that anon or authenticated can execute (lints 0028 and 0029), and the
-- project's default privileges grant both of them EXECUTE on every function
-- postgres creates in public (pg_default_acl, read 2026-10-23). PUBLIC first:
-- a role-level revoke does not strip a privilege held through PUBLIC. Both
-- are no-ops on a rerun, since CREATE OR REPLACE keeps the ACL.
revoke execute on function reject_cross_user_account() from public;
revoke execute on function reject_cross_user_account() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The triggers, named to fire after 008's guard
-- ---------------------------------------------------------------------------
-- `<table>_guard_user_account` sorts after `<table>_guard_purged_id` (008) and
-- before `<table>_inherit_tombstone` (005). After 008's: a row whose id a
-- purge recorded is answered as purged -- the app drops it, delete wins --
-- even when it is also filed under another user's account; answered here
-- first, it would be listed, moved, and only then refused as purged. Before
-- 005's: for an app session no row is refused by both (005 reads only the
-- caller's accounts, so it never finds another user's); for the service role
-- or postgres, which read every account, a row under another user's
-- tombstoned account is, and this check's words come first -- the same code
-- and no hint, so the order changes no answer the app acts on.
drop trigger if exists transactions_guard_user_account on transactions;
create trigger transactions_guard_user_account
  before insert or update of account_id, user_id on transactions
  for each row execute function reject_cross_user_account();

drop trigger if exists recurring_rules_guard_user_account on recurring_rules;
create trigger recurring_rules_guard_user_account
  before insert or update of account_id, user_id on recurring_rules
  for each row execute function reject_cross_user_account();

-- ---------------------------------------------------------------------------
-- 3. What is already there
-- ---------------------------------------------------------------------------
-- Counted as postgres, past row-level security, and only reported: a row
-- already filed under another user's account is its owner's data, and moving
-- or deleting it is a decision for a person, not for this file (the query in
-- IF THIS FAILS lists them). The counts reach the run's log, which is public:
-- no ids.
do $$
declare
  n_transactions bigint;
  n_rules bigint;
begin
  select count(*) into n_transactions
    from transactions t
    join accounts a on a.id = t.account_id
   where a.user_id <> t.user_id;
  select count(*) into n_rules
    from recurring_rules r
    join accounts a on a.id = r.account_id
   where a.user_id <> r.user_id;
  if n_transactions + n_rules > 0 then
    raise warning '% transaction(s), % rule(s) under another user''s account',
      n_transactions, n_rules;
  end if;
end;
$$;

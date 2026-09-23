-- Backlog #88: run purge_tombstones() on a schedule -- weekly, through pg_cron.
--
-- 005_tombstones.sql shipped purge_tombstones() as a job to run by hand, and
-- nobody ever ran it. Nothing else removes a tombstone, so they have piled up
-- since tombstones reached production on 2026-09-13: on 2026-09-22 the shared
-- e2e user alone held 869 account rows, tombstones included -- every Playwright
-- run leaves its test accounts behind as tombstones. They cost more than disk.
-- The client pulls accounts and recurring_rules in full on every sync,
-- tombstones included, so each one is downloaded again on every pull, forever.
-- Real users' tombstones grow the same way, only slower. The function is also
-- the only thing that adopts a live child born under a dead parent (005,
-- section 4), so that sweep has never run either. A schedule is the fix that
-- cannot be forgotten.
--
-- This SUPERSEDES the paragraph in 005_tombstones.sql that calls the function
-- "Deliberately NOT scheduled (pg_cron is out of scope)", and the "rare
-- hand-run job" in its section 2. Nothing else about the function changes:
-- this file neither redefines it nor touches its grants, and 005 stays exactly
-- as it was applied.
--
-- WHY WEEKLY, AND WHY THE RETENTION STAYS AT 30 DAYS. The job calls the
-- function with no argument, so the retention is 005's default of 30 days,
-- about 30x the client's RECONCILE_INTERVAL_MS of 24h -- and CONTRIBUTING.md
-- section 4 says never to shorten it. The tombstone is the only incremental
-- signal that a row is gone; the retention is what lets every device that
-- syncs at least once a month pull it, and a device away for longer falls back
-- on its daily full reconcile. The cadence plays no part in that guarantee.
-- The function deletes only rows whose deleted_at is already older than the
-- retention, measured against server now() on a server-stamped deleted_at
-- (005, section 4b), so no cadence can purge a tombstone early: weekly just
-- means one is reclaimed 30 to 37 days after the delete. Weekly also keeps the
-- job as rare as 005 assumed when it left deleted_at unindexed, since every
-- run seq-scans all three tables. Sunday 04:00 is UTC: pg_cron schedules in
-- GMT unless cron.timezone says otherwise, and Supabase sets no cron.timezone.
--
-- WHAT THE PURGE GIVES UP. Delete wins over a concurrent edit only while the
-- tombstone exists. Once it is purged, 30 to 37 days after the delete, a
-- device that pushes a stale pending edit to that row re-inserts it as live,
-- as hard deletes did: the push upserts on id, the local row carries no
-- deleted_at, and no server row is left to keep a tombstone on. (A transaction
-- or rule whose account was purged too is refused with 23503 and stays pending
-- instead, unless the same device re-pushes that account first.) No purge had
-- ever run before this file, so until now that could not happen.
--
-- WHY NOT THE CLIENT. It cannot, by design. purge_tombstones() is `security
-- definer` and deletes across every user's rows, so 005 revoked EXECUTE from
-- public, anon and authenticated: no app session can call it, and the one key
-- that could, service_role, must never ship in the app. Retention is a server
-- policy in any case -- one clock, one horizon for every device -- not
-- something any single device could decide for the others.
--
-- WHO THE JOB RUNS AS. pg_cron runs a job "with the same permissions as the
-- current user", i.e. the role that called cron.schedule. Through migrate.yml
-- (the Session pooler string in SUPABASE_DB_URL) or the SQL editor, that is
-- `postgres`, the role migrate.yml applied 005 as (run 34785508758), so it owns
-- purge_tombstones(): 005's revokes never touch the owner's EXECUTE, and the
-- security-definer body runs as that owner, exactly as a run by hand does. The
-- job's command is schema-qualified because a job runs with its role's default
-- search_path, not this file's. Section 3 checks that this role can execute
-- the function before anything is scheduled.
--
-- DEPLOY ORDER: none. This is server-only and no client build depends on it,
-- so it can land before or after any client. Applying it deletes nothing by
-- itself: it enables the extension and registers the job, and the first purge
-- happens at the next Sunday 04:00 UTC. No tombstone predates 005 (2026-09-13),
-- so none is past the retention before 2026-10-13, and the first run that can
-- delete anything is Sunday 2026-10-18.
--
-- IF THIS FAILS. The file runs in one transaction, so a failure leaves the
-- database as it was. If it fails at the create or in section 2, try enabling
-- pg_cron from the dashboard (Integrations -> Cron) and dispatching again:
-- `if not exists` then skips the create. If it fails in section 3, 005 is
-- missing or the connecting role cannot execute the function -- fix that before
-- anything is scheduled. If the project refuses pg_cron outright, the fallback
-- is a scheduled GitHub workflow (`on: schedule`, cron '0 4 * * 0') running
-- `select * from public.purge_tombstones();` through the same SUPABASE_DB_URL
-- secret. That would print the three counts in its log, but GitHub disables
-- scheduled workflows in a public repository after 60 days without activity --
-- which is why it is the fallback and not the plan.
--
-- One failure the dashboard cannot fix: if postgres has ever been the grantor
-- of a privilege on cron.job -- running the SQL tab of Supabase's install page
-- verbatim makes it one (section 2) -- section 1 fails with "dependent
-- privileges exist" on every attempt, because the after-create script runs
-- even when `if not exists` skips the create. Inspect
--   select relacl from pg_class where oid = 'cron.job'::regclass;
-- where every entry ending in /postgres was granted by postgres and blocks the
-- script's revoke. As postgres, `revoke all on table cron.job from postgres;`
-- removes the ones it granted itself and only those (revoke any others from
-- their grantees the same way), then dispatch again.
--
-- To look at the job, run the purge by hand, or stop it (SQL editor, as
-- postgres):
--   select * from cron.job where jobname = 'purge-tombstones';
--   select jobid, status, return_message, start_time, end_time
--     from cron.job_run_details
--    where username = current_user
--      and command = 'select public.purge_tombstones()'
--    order by start_time desc limit 10;
--   select * from public.purge_tombstones();  -- DELETES remote data
--   select cron.unschedule('purge-tombstones');
-- The run history is keyed on the command, not the jobid: every rerun of this
-- file makes a new jobid, and filtering on the current one would hide earlier
-- runs, failures included. cron.job_run_details records each run's status and
-- timing, not the three counts the function returns; a run by hand is the way
-- to see those. A failed run alerts nobody -- that table is the only place it
-- shows. So check the first Sunday run after applying this (2026-09-27 04:00
-- UTC, if it is applied before then) with the query above and expect status
-- 'succeeded': it is the first time the job's own path runs -- its connection,
-- its role, EXECUTE on the function -- even though nothing is old enough to
-- delete until 2026-10-18. Supabase notes the table is never cleaned up
-- automatically; at one row a week that is not worth a job of its own.
-- Disabling the pg_cron extension permanently deletes every job, this one
-- included.
--
-- Sources, read 2026-09-22 and 2026-09-23:
--   https://supabase.com/docs/guides/cron/install -- the create statement
--     (section 1) and the two grants (section 2).
--   https://supabase.com/docs/guides/cron/quickstart -- cron.schedule with an
--     existing job name "will replace the existing job via upsert"; the
--     cron.job_run_details records "are not cleaned up automatically".
--   https://github.com/citusdata/pg_cron -- the README: jobs run "with the same
--     permissions as the current user", schedules are in GMT by default;
--     src/job_metadata.c: the upsert, and who may unschedule what (section 4).
--   https://github.com/supabase/postgres -- Supabase's Postgres image:
--     pg_cron 1.6.4 in current images; supautils pins pg_cron to pg_catalog;
--     `postgres` is NOSUPERUSER BYPASSRLS; and the pg_cron after-create script
--     behind section 2. supabase/supautils runs that script after every CREATE
--     EXTENSION: in src/supautils.c at 3.4.3, the version the image pins, and
--     in src/extensions.c on master since a 2026-09-17 refactor.
--
-- Idempotent: safe to run twice, in the style of 005/006.

-- ---------------------------------------------------------------------------
-- 1. The extension
-- ---------------------------------------------------------------------------
-- Supabase's documented statement, plus `if not exists`. The schema clause
-- changes nothing: pg_cron is not relocatable, its control file already says
-- `schema = pg_catalog`, and supautils rewrites any schema option for pg_cron
-- to pg_catalog on this platform anyway, so leaving the clause out would land
-- in the same place. It stays because it is what Supabase prescribes. The
-- extension's objects live in the `cron` schema its install script creates.
--
-- postgres is not a superuser on Supabase. pg_cron is one of supautils'
-- "privileged extensions": supautils runs the create as the superuser on
-- postgres's behalf, then runs the platform's pg_cron after-create script --
-- which is what section 2 has to respect.
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------------
-- 2. The grants Supabase prescribes -- only where they are missing
-- ---------------------------------------------------------------------------
-- Supabase's install page follows the create with
--   grant usage on schema cron to postgres;
--   grant all privileges on all tables in schema cron to postgres;
-- On a hosted project both are already in place when the create returns: the
-- after-create script grants postgres USAGE and ALL WITH GRANT OPTION, then
-- cuts cron.job back to SELECT and takes TRIGGER off cron.job_run_details.
--
-- Issuing them again anyway is not a harmless no-op, which is why they sit
-- behind a guard. Run by postgres, the table grant adds a second, self-granted
-- entry on cron.job (grantor postgres) that hangs off the platform's grant
-- option. The same after-create script narrows cron.job with `revoke all on
-- table cron.job from postgres` and no CASCADE, and a revoke that would orphan
-- such an entry fails with "dependent privileges exist". supautils runs that
-- script after EVERY create extension pg_cron, including the one `if not
-- exists` turns into a no-op -- so the second run of this very file would fail
-- on it. Guarded, the grants run only where postgres has no USAGE on cron at
-- all. There, run as postgres, they fail loudly (it holds no grant option to
-- pass on), which is the right outcome: cron.schedule below would fail the
-- same way.
do $$
begin
  if not has_schema_privilege('postgres', 'cron', 'usage') then
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The job must be able to run the function
-- ---------------------------------------------------------------------------
-- cron.schedule stores the command as text and never checks it. A database
-- without 005, or a scheduling role that cannot execute the function, would
-- therefore register a job that fails every Sunday with nobody told. This
-- turns both into a failed dispatch: has_function_privilege raises "function
-- ... does not exist" when 005 is missing, and the exception below fires when
-- the role lacks EXECUTE. It checks current_user because the job runs as the
-- role that schedules it. What it cannot check is the job's own connection,
-- which first runs on the Sunday after this is applied (see the header).
do $$
begin
  if not has_function_privilege('public.purge_tombstones(interval)',
                                'execute') then
    raise exception 'role % cannot execute public.purge_tombstones(interval)',
                    current_user;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The job
-- ---------------------------------------------------------------------------
-- Unschedule, then schedule. cron.schedule with an existing name already
-- upserts (`on conflict on constraint jobname_username_uniq`), but the upsert
-- rewrites only the schedule, command and database: a job someone switched
-- off by hand (cron.alter_job(..., active := false)) would stay off. Deleting
-- and re-inserting makes a rerun of this file restore exactly the job below,
-- whatever was done to it since.
--
-- The unschedule reads cron.job rather than calling cron.unschedule(name),
-- which raises "could not find valid entry for job" when there is none -- the
-- first run would abort on it. It is limited to this role's own job, the one
-- row the schedule below would otherwise upsert. postgres is BYPASSRLS, so it
-- sees every role's jobs past pg_cron's per-user policy, but pg_cron lets a
-- role unschedule another role's job only with DELETE on cron.job, which
-- postgres does not have: without the filter, a same-named job belonging to
-- another role would fail the whole file.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'purge-tombstones'
   and username = current_user;

-- Sundays at 04:00 UTC. No argument, on purpose: the retention lives in one
-- place, the function's default.
select cron.schedule(
  'purge-tombstones',
  '0 4 * * 0',
  $$select public.purge_tombstones()$$
);

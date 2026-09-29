-- Backlog #152 (and #23's "capture the storage bucket RLS policy in
-- supabase/migrations/"): let a signed-in user write, overwrite, read and
-- remove the receipts in their own folder of the private `receipts` bucket.
--
-- WHY. Storage runs every request from the app as the `authenticated` role
-- against row-level security on storage.objects, and that table has RLS on and,
-- until this file, no policy at all: on 2026-09-29 the project had 0 policies
-- on storage.objects, 0 objects in any bucket and 0 transactions with a
-- receipt_path. So no receipt upload has ever succeeded, on any platform --
-- useReceiptPhoto's upload was refused before the attach behind it could run.
-- The dashboard-managed policy #23 assumed never existed; this file is the
-- first, and the repo is now where the bucket's rules live.
--
-- WHAT. One folder per user, one level deep. An object's key must be exactly
-- `<caller's auth.uid()>/<file name>`, which is how the client builds every
-- key: `<user id>/<transaction id>.<ext>` (lib/receiptObject.ts). Four
-- policies, one per command the client needs, on the same condition:
--   select  Storage checks the hook's upload, an upsert, by running its
--           INSERT ... ON CONFLICT DO UPDATE ... RETURNING * as the caller
--           before it writes anything, and that reads the new row and any row
--           it conflicts with: without this policy even a first upload is
--           refused ("new row violates row-level security policy"). The
--           removal's DELETE ... RETURNING * reads it too.
--   insert  the upload.
--   update  `upsert: true`: a second photo attached to the same
--           transaction under the same extension overwrites the object in
--           place (INSERT ... ON CONFLICT DO UPDATE); one under another
--           extension is a second object, and the first is left behind.
--           Every type outside lib/receiptObject.ts's table shares `bin`.
--   delete  the hook's best-effort removal of an upload whose attach was
--           refused (#138), and #23's future "remove a receipt".
-- `using` and `with check` carry the same condition, so an update cannot move
-- an object into another user's folder, or deeper into one's own.
-- auth.uid() sits in a sub-select, so Postgres evaluates it once per
-- statement rather than once per row. Scoped to `authenticated`: anon gets
-- nothing, and service_role bypasses RLS anyway.
-- storage.foldername(name) is every segment of the key but the last, so
-- comparing the whole array, not just its first element, refuses a key the
-- client never builds -- no folder, someone else's, or a deeper path. That
-- includes every key the builds before #152 make on web and in the desktop
-- app, which take the tail of a blob: URL as the extension:
-- `<user>/<txn>.app/<uuid>` from a deployed host, `<user>/<txn>.1:49217/<uuid>`
-- from Electron's server, `<user>/<txn>.blob:http:/localhost:8081/<uuid>` from
-- a dev server. Those uploads stay refused, as every upload was before this
-- file. #23 widens the condition if its viewer needs another layout.
--
-- WHAT THIS FILE MUST NOT DO. storage.objects belongs to
-- supabase_storage_admin, and postgres is neither its owner nor a member of
-- that role. RLS is already on there, and `alter table storage.objects ...` in
-- any form fails with "must be owner of table objects" -- and, the file being
-- one transaction, would take the policies down with it. Nothing here alters
-- the table, grants anything or touches storage.buckets.
--
-- WHO CAN RUN IT. Supabase's supautils extension lets postgres create, alter
-- and drop policies on a fixed list of tables it does not own, storage.objects
-- among them; ALTER TABLE stays refused. migrate.yml connects as postgres
-- through the session pooler, the connection 007's CREATE EXTENSION already
-- went through supautils on. This is the first policy statement it runs on a
-- table postgres does not own. If the dispatch fails with "must be owner of
-- table objects" anyway, nothing was applied (one transaction, stop on
-- error): paste this file into the SQL editor, which also runs as postgres,
-- and keep the file as the record.
--
-- DEPLOY ORDER: the usual one -- dispatch this file, then merge the client
-- (the dispatch can run from the PR's branch, as 008's did). No client needs
-- it to work: without it every upload is refused, as it always has been, and
-- #138 reports that refusal on the sync indicator. The builds before #152 on
-- web and in the desktop app stay refused (WHAT, above). iOS build 12 (1.1.9)
-- builds the right key, `<user>/<txn>.jpg`, but hands storage-js a Blob,
-- which React Native's FormData cannot send: with this file applied its
-- upload succeeds, by every account read with an empty body. So attach
-- receipts on iOS only once a build carrying #152 is installed.
--
-- To look at the policies, or take them off again (SQL editor, as postgres):
--   select policyname, cmd, roles, qual, with_check
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects';
--   drop policy if exists "Users read own receipts" on storage.objects;
--   -- ... and the other three below, by name.
--
-- Sources, read 2026-09-29:
--   https://supabase.com/docs/guides/storage/security/access-control -- the
--     policy shapes; upsert "additionally" needs SELECT and UPDATE.
--   https://supabase.com/docs/guides/troubleshooting/storage-error-403-forbidden-new-row-violates-row-level-security-policy-on-upload-a94384
--     -- an INSERT without a matching SELECT policy fails on its RETURNING.
--   https://supabase.com/docs/guides/storage/schema/helper-functions --
--     storage.foldername().
--   https://supabase.com/docs/guides/troubleshooting/realtime-must-be-owner-of-table-messages
--     -- supautils' policy delegation, and ALTER TABLE refused.
--   https://github.com/supabase/postgres (ansible/files/postgresql_config/
--     supautils.conf.j2) -- supautils.policy_grants lists storage.objects for
--     postgres.
--   https://github.com/orgs/supabase/discussions/34270 -- the storage schema
--     restrictions of 2025-04-21 keep "create RLS policies" on storage.objects.
--   https://github.com/supabase/storage (src/storage/database/pg.ts,
--     src/storage/uploader.ts) -- the upsert (INSERT ... ON CONFLICT DO
--     UPDATE ... RETURNING *) an upload is checked with as the caller before
--     it is written, and the removal (DELETE ... RETURNING *), which these
--     policies must admit; storage.foldername() in
--     migrations/tenant/0060-optimize-existing-functions-again.sql.
--
-- Idempotent: every policy is dropped if it exists and created again, so a
-- rerun restores exactly the four below.

-- ---------------------------------------------------------------------------
-- 1. Read: the upload's RETURNING, an upsert's conflicting row, the removal's
--    RETURNING, and #23's future signed URLs.
-- ---------------------------------------------------------------------------
drop policy if exists "Users read own receipts" on storage.objects;
create policy "Users read own receipts"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'receipts'
    and storage.foldername(name) = array[(select auth.uid()::text)]
  );

-- ---------------------------------------------------------------------------
-- 2. Upload
-- ---------------------------------------------------------------------------
drop policy if exists "Users upload own receipts" on storage.objects;
create policy "Users upload own receipts"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'receipts'
    and storage.foldername(name) = array[(select auth.uid()::text)]
  );

-- ---------------------------------------------------------------------------
-- 3. Overwrite (`upsert: true`)
-- ---------------------------------------------------------------------------
drop policy if exists "Users overwrite own receipts" on storage.objects;
create policy "Users overwrite own receipts"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'receipts'
    and storage.foldername(name) = array[(select auth.uid()::text)]
  )
  with check (
    bucket_id = 'receipts'
    and storage.foldername(name) = array[(select auth.uid()::text)]
  );

-- ---------------------------------------------------------------------------
-- 4. Remove
-- ---------------------------------------------------------------------------
drop policy if exists "Users remove own receipts" on storage.objects;
create policy "Users remove own receipts"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'receipts'
    and storage.foldername(name) = array[(select auth.uid()::text)]
  );

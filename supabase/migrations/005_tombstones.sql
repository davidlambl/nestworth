-- Backlog #18: server-side tombstones so pulls can be incremental.
-- Also closes #22 (the indexes the sync query shapes were missing).
--
-- Deletes used to be hard DELETEs, so a device could only learn that another
-- device had removed a row by enumerating every remote (id, updated_at) on
-- every sync. Stamping `deleted_at` instead turns a delete into an ordinary
-- UPDATE, which the client's existing `updated_at > cursor` incremental pull
-- already sees -- so the per-sync cost becomes proportional to what changed
-- rather than to total history.
--
-- DEPLOY ORDER: run this file BEFORE deploying a client build that includes
-- tombstones. Against the old schema the new client's `.is('deleted_at', null)`
-- reads bail out safely, but its `.update({ deleted_at: ... })` fails outright
-- and local deletes stay queued forever. The reverse is fine: an old client on
-- the new schema keeps hard-deleting, which new clients notice via the periodic
-- reconcile (it just keeps showing rows other devices tombstoned until it is
-- upgraded).
--
-- Idempotent: safe to run twice, in the style of 002/003/004.

-- ---------------------------------------------------------------------------
-- 1. The tombstone column
-- ---------------------------------------------------------------------------
-- Nullable with no default, so this is a catalog-only change on all three
-- tables: no rewrite, and every existing row reads back as `deleted_at is null`,
-- which is the encoding for "live".
--
-- `transaction_splits` deliberately does NOT get one. It has no user_id (its
-- RLS goes through the parent transaction) and no updated_at, so there is no
-- cursor by which a tombstone on it could ever be pulled. Splits ride their
-- parent: they stay hard-deleted, and purge_tombstones reaches them through the
-- `on delete cascade` from transactions.
alter table accounts        add column if not exists deleted_at timestamptz;
alter table transactions    add column if not exists deleted_at timestamptz;
alter table recurring_rules add column if not exists deleted_at timestamptz;

-- No RLS change is needed, and that is worth stating rather than assuming.
-- 001's policies are `for all using (auth.uid() = user_id)` with no WITH CHECK,
-- and Postgres reuses the USING expression as the WITH CHECK when one is
-- omitted. Neither side mentions deleted_at, so an owner can still SELECT their
-- own tombstoned rows -- which is the only reason a tombstone is pullable at
-- all -- and can still write the stamp, since user_id does not change. The
-- splits policy is an EXISTS over the parent transaction, and a tombstone
-- leaves that parent row in place, so the client's best-effort remote split
-- delete keeps working against a tombstoned parent.
--
-- Realtime needs no change either: 001 already publishes all three tables, a
-- publication covers columns added later, and an UPDATE's `new` image is the
-- full row regardless of replica identity -- so `payload.new.deleted_at`
-- reaches the client that must act on it.

-- ---------------------------------------------------------------------------
-- 2. Indexes (#22)
-- ---------------------------------------------------------------------------
-- The incremental transaction pull is `where user_id = ? and updated_at > ?`.
-- 001 indexed transactions by account_id and txn_date only, so that query had
-- to scan the user's entire history every sync -- which would have made this
-- migration's whole point moot.
create index if not exists idx_transactions_user_updated
  on transactions (user_id, updated_at);

-- The rules pull is `where user_id = ?`; 001 indexed recurring_rules by
-- account_id only.
create index if not exists idx_recurring_rules_user
  on recurring_rules (user_id);

-- No index on deleted_at, deliberately. NULL is the overwhelming majority
-- value, so a plain btree on it could never be selective enough to be chosen
-- for the `deleted_at is null` reads; a partial `where deleted_at is not null`
-- index would serve only purge_tombstones, a rare hand-run job that is happy to
-- seq-scan. Narrowing idx_transactions_user_updated itself to live rows would
-- be actively wrong: the incremental pull MUST see tombstoned rows, because
-- that is the whole mechanism by which a delete propagates.

-- ---------------------------------------------------------------------------
-- 3. Cascade: tombstoning an account tombstones its children
-- ---------------------------------------------------------------------------
-- A tombstone is an UPDATE, so the FK's `on delete cascade` no longer fires.
-- Without this trigger, deleting an account on device A would leave all of its
-- transactions and rules live on the server, and device B would keep pulling
-- and showing every one of them under an account it no longer has.
--
-- Each child write trips that child's own `*_updated_at` BEFORE UPDATE trigger
-- from 001, bumping updated_at. That is what pushes the entire subtree past the
-- other devices' cursors, so one incremental pull clears the lot.
--
-- `and deleted_at is null` keeps a repeated tombstone from re-stamping children
-- that are already dead, which would bump their updated_at again and
-- re-broadcast the whole subtree to every device for nothing.
create or replace function tombstone_account_children() returns trigger
language plpgsql
-- pg_temp pinned last: when it is not listed it is searched FIRST for table
-- names, so a caller-created pg_temp.transactions could otherwise shadow the
-- real table this writes to.
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update transactions
       set deleted_at = new.deleted_at
     where account_id = new.id and deleted_at is null;
    update recurring_rules
       set deleted_at = new.deleted_at
     where account_id = new.id and deleted_at is null;
  end if;
  return new;
end;
$$;

-- `of deleted_at` so that ordinary account edits -- including every client
-- upsert, whose payload never carries deleted_at -- skip this entirely.
-- It cannot recurse: the body writes only to transactions and recurring_rules,
-- and nothing on those tables writes back to accounts. Two devices tombstoning
-- the same account cannot both cascade either: the second UPDATE blocks on the
-- account row, then re-checks the client's `.is('deleted_at', null)` filter and
-- matches nothing.
drop trigger if exists accounts_tombstone_children on accounts;
create trigger accounts_tombstone_children
  after update of deleted_at on accounts
  for each row execute function tombstone_account_children();

-- ---------------------------------------------------------------------------
-- 4. Born dead: children written into an already-tombstoned account
-- ---------------------------------------------------------------------------
-- An offline device can queue a transaction into an account that another device
-- has since deleted. Under hard deletes the FK rejected that insert outright;
-- under tombstones the parent row still exists, so the insert succeeds and
-- creates a LIVE orphan beneath a dead account -- a row every device pulls
-- forever with no account to file it under. So a genuinely new child is
-- rejected with 23503, reproducing the FK violation the hard delete used to
-- raise; an existing child is stamped instead, so an edit racing an account
-- delete still loses to the delete. See the body for why that split matters.
--
-- `coalesce` so an explicit deleted_at in the payload is never overwritten, and
-- `update of account_id` so re-parenting a row into a dead account is caught
-- too. That same clause means a client upsert of an existing transaction trips
-- this (PostgREST puts account_id in the DO UPDATE set list), which costs one
-- PK lookup and is exactly the backstop that keeps "delete wins over a
-- concurrent edit" true for an account-level delete.
--
-- The parent read deliberately takes NO row lock. A `for share` here would
-- close a millisecond-wide race -- a child inserted while the parent's
-- tombstone is still uncommitted is born live, since READ COMMITTED cannot see
-- an uncommitted stamp -- but it would buy that with a genuine deadlock:
-- re-parenting a child locks the child row and then wants the account, while
-- accounts_tombstone_children holds the account and then wants the child rows.
-- The offline case this trigger exists for involves a long-committed tombstone
-- and is closed completely. The narrow concurrent-commit window is swept by
-- purge_tombstones below, NOT by the client's periodic reconcile: that reconcile
-- only deletes local rows ABSENT from the remote enumeration, and an orphan born
-- live is present and live, so it would be pulled down forever rather than
-- cleaned up.
create or replace function inherit_account_tombstone() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  parent_deleted timestamptz;
  already_exists boolean;
begin
  select deleted_at into parent_deleted from accounts where id = new.account_id;
  if parent_deleted is null then
    return new;
  end if;

  -- A row the server has never seen must be REJECTED, not stamped.
  --
  -- Stamping it looks harmless server-side but is destructive on the client:
  -- push reads the row back, sees deleted_at, and hard-deletes its local copy as
  -- "the server says this is deleted". For a row the server already held that is
  -- the intended `delete wins over a concurrent edit` rule. For a row created
  -- offline and pushed for the FIRST time it is pure data loss -- the server
  -- never had it, so no pull can bring it back, and the user's typed-in
  -- transactions vanish with no error. Raising 23503 restores exactly what the
  -- pre-tombstone FK did: the push fails, the client leaves the row 'pending',
  -- and the data stays on the device.
  --
  -- The existence check is what makes this safe to do in a BEFORE INSERT
  -- trigger. Postgres fires BEFORE INSERT for the proposed row even when
  -- `insert ... on conflict do update` ends up taking the UPDATE path, so an
  -- unconditional raise here would also reject every ordinary push of an edit to
  -- an already-tombstoned row -- stranding it 'pending' forever instead of
  -- letting the client retire its local copy.
  if tg_op = 'INSERT' then
    execute format('select exists (select 1 from %I where id = $1)', tg_table_name)
      into already_exists
      using new.id;
    if not already_exists then
      raise exception 'account % is deleted', new.account_id
        using errcode = '23503';
    end if;
  end if;

  new.deleted_at := coalesce(new.deleted_at, parent_deleted);
  return new;
end;
$$;

drop trigger if exists transactions_inherit_tombstone on transactions;
create trigger transactions_inherit_tombstone
  before insert or update of account_id on transactions
  for each row execute function inherit_account_tombstone();

drop trigger if exists recurring_rules_inherit_tombstone on recurring_rules;
create trigger recurring_rules_inherit_tombstone
  before insert or update of account_id on recurring_rules
  for each row execute function inherit_account_tombstone();

-- ---------------------------------------------------------------------------
-- 4b. deleted_at is stamped by the server, never by the client
-- ---------------------------------------------------------------------------
-- The client sends its own clock in the tombstone UPDATE. Trusting it makes the
-- purge retention meaningless: purge_tombstones compares deleted_at against
-- server now(), so a device whose clock is far behind writes tombstones that are
-- already past the retention window and can be reclaimed before other devices
-- ever sync them -- and a device whose clock is ahead keeps its tombstones
-- long past it. 001 already refuses to trust the client for updated_at for the
-- same reason; this is the same rule for the same failure.
--
-- Only the NULL -> non-NULL transition is stamped, so re-running a tombstone
-- (a retried push, or the cascade landing on a row the client already stamped)
-- does not keep pushing the purge horizon away.
create or replace function normalize_deleted_at() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null
     and (tg_op = 'INSERT' or old.deleted_at is null) then
    new.deleted_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists accounts_normalize_deleted_at on accounts;
create trigger accounts_normalize_deleted_at
  before insert or update of deleted_at on accounts
  for each row execute function normalize_deleted_at();

drop trigger if exists transactions_normalize_deleted_at on transactions;
create trigger transactions_normalize_deleted_at
  before insert or update of deleted_at on transactions
  for each row execute function normalize_deleted_at();

drop trigger if exists recurring_rules_normalize_deleted_at on recurring_rules;
create trigger recurring_rules_normalize_deleted_at
  before insert or update of deleted_at on recurring_rules
  for each row execute function normalize_deleted_at();

-- ---------------------------------------------------------------------------
-- 5. purge_tombstones -- reclaim the space, run by hand
-- ---------------------------------------------------------------------------
-- Deliberately NOT scheduled (pg_cron is out of scope). Retention must
-- comfortably exceed the client's RECONCILE_INTERVAL_MS of 24h: the tombstone
-- is the only incremental signal that a row is gone, so purging one before
-- every device has pulled it leaves those devices showing the row until their
-- next full reconcile. 30 days is ~30x that interval.
--
-- Children first, parents last. The FK is `on delete cascade`, so deleting an
-- account also deletes its transactions and rules -- doing accounts first would
-- silently swallow those rows out of the per-table counts this returns. Going
-- last also lets the account delete mop up any live orphan left by the
-- uncommitted-tombstone race noted in section 4.
--
-- Three sequential statements rather than the one multi-CTE statement this was
-- first drafted as. Sibling data-modifying CTEs share a snapshot and run in no
-- defined order, so the children-before-parents ordering that the counts above
-- rely on would be incidental rather than guaranteed; a plain statement runs to
-- completion, FK cascades included, before the next one starts, and
-- GET DIAGNOSTICS then reports exactly what each one removed.
--
-- The OUT parameters are named `purged_*` rather than after their tables
-- because RETURNS TABLE turns those names into variables: calling them
-- `transactions` and `accounts` would shadow the very tables these DELETEs name.
drop function if exists purge_tombstones(interval);
create function purge_tombstones(retention interval default interval '30 days')
returns table (
  purged_rules bigint,
  purged_transactions bigint,
  purged_accounts bigint
)
language plpgsql
-- A maintenance run has to reach every user's rows, and RLS is not applied to
-- the table owner, so security definer is what makes this work at all -- the
-- per-auth.uid() policies would otherwise scope it to whoever happened to call.
security definer
-- Mandatory under security definer, with pg_temp pinned last for the same
-- table-shadowing reason as above -- the stakes are higher here, since these
-- are unqualified DELETEs.
set search_path = public, pg_temp
as $$
begin
  -- Adopt any live child left under a dead parent before reclaiming anything.
  -- inherit_account_tombstone rejects a child written into an account that was
  -- ALREADY tombstoned, but it deliberately takes no row lock on the parent (a
  -- `for share` there would deadlock against accounts_tombstone_children), so a
  -- child committed in the instant before the parent's tombstone becomes visible
  -- is born live. Without this sweep that row outlives its account forever and
  -- every device keeps pulling it down with no account to file it under.
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

  delete from recurring_rules where deleted_at < now() - retention;
  get diagnostics purged_rules = row_count;

  delete from transactions where deleted_at < now() - retention;
  get diagnostics purged_transactions = row_count;

  delete from accounts where deleted_at < now() - retention;
  get diagnostics purged_accounts = row_count;

  -- RETURNS TABLE makes the three names OUT parameters, so a bare RETURN NEXT
  -- emits their current values as the single result row.
  return next;
  return;
end;
$$;

-- Revoking from anon/authenticated ALONE would be a silent no-op: CREATE
-- FUNCTION grants EXECUTE to PUBLIC by default, and a role-level revoke does
-- not strip a privilege held via PUBLIC. Both roles would still be able to call
-- a security-definer function that deletes across every user's data. Revoke
-- PUBLIC first; the explicit role revokes are kept so the intent is legible to
-- anyone auditing the grants later.
revoke execute on function purge_tombstones(interval) from public;
revoke execute on function purge_tombstones(interval) from anon, authenticated;

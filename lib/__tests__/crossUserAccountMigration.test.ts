// supabase/migrations/010_cross_user_account_guard.sql (#189), as text.
//
// jest cannot run PL/pgSQL, so what the migration does was measured in PGlite
// against 001-006, 008 and 010 (the unit's probes); these pins keep the
// choices those measurements depend on from drifting in a later edit: the
// trigger names that put the check after 008's purge guard, the SQLSTATE and
// the missing hint the app classifies, the security definer with its pinned
// search_path, the revokes, the lock bound, the file's statements themselves
// (none added that undoes another), and the workflow's default file. Each is
// a pin, green from the start; a mutant of the text turns its test red.
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts).
import { load } from 'js-yaml';

const DIR = path.join(__dirname, '../../supabase/migrations');
const FILE = '010_cross_user_account_guard.sql';
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');
/** The SQL without its comments, lower-cased, whitespace collapsed. */
const code = (name: string) =>
  read(name).replace(/--.*$/gm, '').toLowerCase().replace(/\s+/g, ' ');
const sql = code(FILE);
const TABLES = ['transactions', 'recurring_rules'];
/** Postgres fires a table's triggers on one event in byte order of their names. */
const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

describe("migration 010: a row filed under another user's account is refused (#189)", () => {
  it.each(TABLES)(
    'creates the check on %s for an insert and for an update that names the account or the user, and drops it first, so a rerun passes',
    (table) => {
      const name = `${table}_guard_user_account`;
      const drop = `drop trigger if exists ${name} on ${table};`;
      const create = `create trigger ${name} before insert or update of account_id, user_id on ${table} for each row execute function reject_cross_user_account();`;
      expect(sql).toContain(drop);
      expect(sql).toContain(create);
      expect(sql.indexOf(drop)).toBeLessThan(sql.indexOf(create));
    }
  );

  it.each(TABLES)(
    "fires on %s after 008's purge guard and before 005's inherit_account_tombstone",
    (table) => {
      const names = ['005_tombstones.sql', '008_purged_ids.sql', FILE].flatMap(
        (file) =>
          [
            ...code(file).matchAll(
              /create trigger (\w+) before [^;]*? on (\w+) /g
            ),
          ]
            .filter((m) => m[2] === table)
            .map((m) => m[1])
      );
      const order = [...new Set(names)].sort(byteOrder);
      const at = (n: string) => order.indexOf(`${table}_${n}`);

      expect(at('guard_user_account')).toBe(at('guard_purged_id') + 1);
      expect(at('inherit_tombstone')).toBe(at('guard_user_account') + 1);
    }
  );

  it("refuses with the foreign key's SQLSTATE and no hint, from a security definer function whose search_path is pinned with pg_temp last", () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function reject_cross_user_account()'),
      sql.indexOf('$$;') + 3
    );
    expect(fn).toContain('returns trigger language plpgsql security definer');
    expect(fn).toContain('set search_path = public, pg_temp as $$');
    expect(fn).toContain(
      'where a.id = new.account_id and a.user_id = new.user_id'
    );
    expect(fn).toContain("using errcode = '23503';");
    // A hint of 'purged' would make the app drop the row (008); none at all.
    expect(fn).not.toContain('hint');
    expect(fn.match(/raise exception/g)).toHaveLength(1);
  });

  // The whole body, so no edit can turn the check over (every row of the
  // user's own refused), drop the row (`return null`: every write silently
  // skipped, which PostgREST's single() then reports as PGRST116, retried
  // forever), add a condition (a live account: an edit of a row under the
  // user's own tombstoned account refused instead of stamped by 005, so delete
  // no longer wins), or exempt a role -- each measured in PGlite, and none
  // caught by the pins above.
  it("checks exactly that the account exists and is the row user's, and otherwise passes the row on unchanged", () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function reject_cross_user_account()'),
      sql.indexOf('$$;') + 3
    );
    expect(fn).toBe(
      'create or replace function reject_cross_user_account() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$ ' +
        'begin if not exists ( select 1 from accounts a where a.id = new.account_id and a.user_id = new.user_id ) ' +
        "then raise exception 'account % is not this user''s', new.account_id using errcode = '23503'; end if; return new; end; $$;"
    );
  });

  it("reports the rows already filed under another user's account by their counts alone: migrate.yml's log is public", () => {
    // To the end of the file, so a later block that prints ids is in it too.
    const block = sql.slice(sql.lastIndexOf('do $$'));
    expect(block).toContain(
      "raise warning '% transaction(s), % rule(s) under another user''s account', n_transactions, n_rules;"
    );
    expect(block.match(/raise /g)).toHaveLength(1);
    expect(block).toContain(
      'select count(*) into n_transactions from transactions t join accounts a on a.id = t.account_id where a.user_id <> t.user_id;'
    );
    expect(block).toContain(
      'select count(*) into n_rules from recurring_rules r join accounts a on a.id = r.account_id where a.user_id <> r.user_id;'
    );
  });

  // Section 3 whole, as the function's body above: it counts and reports, and
  // nothing added inside it passes -- a delete, an update, an `execute` of any
  // text. Moving or deleting such a row is a person's decision.
  it('only counts and reports in section 3: nothing in it moves, deletes or runs anything else', () => {
    expect(sql.slice(sql.lastIndexOf('do $$')).trim()).toBe(
      'do $$ declare n_transactions bigint; n_rules bigint; begin ' +
        'select count(*) into n_transactions from transactions t join accounts a on a.id = t.account_id where a.user_id <> t.user_id; ' +
        'select count(*) into n_rules from recurring_rules r join accounts a on a.id = r.account_id where a.user_id <> r.user_id; ' +
        "if n_transactions + n_rules > 0 then raise warning '% transaction(s), % rule(s) under another user''s account', n_transactions, n_rules; end if; end; $$;"
    );
  });

  it('revokes EXECUTE from PUBLIC first, then from anon and authenticated', () => {
    const fromPublic = sql.indexOf(
      'revoke execute on function reject_cross_user_account() from public;'
    );
    const fromRoles = sql.indexOf(
      'revoke execute on function reject_cross_user_account() from anon, authenticated;'
    );
    expect(fromPublic).toBeGreaterThan(-1);
    expect(fromRoles).toBeGreaterThan(fromPublic);
  });

  it("bounds every wait for a lock under the app's 8 s, before its first statement", () => {
    // A waiting CREATE TRIGGER holds every app write to its table behind it,
    // and the role migrate.yml connects as has no lock_timeout of its own.
    expect(sql).toMatch(/^\s*set local lock_timeout = '3s';/);
  });

  it('runs inside one transaction: nothing that migrate.yml cannot run there', () => {
    expect(sql).not.toMatch(/concurrently|\bcommit\b|\bbegin;/);
  });

  // The file statement by statement, each dollar-quoted body elided (pinned
  // whole: the function's and section 3's, above). The other pins find the
  // statements they want; this one also refuses one more, which could undo
  // them -- a later `alter function ... security invoker`, a `grant execute`
  // to anon or authenticated, a `disable trigger`, a second `set local
  // lock_timeout` -- or a last statement left without its semicolon, which
  // psql still runs at the end of the file.
  it('runs exactly these statements, in this order, and nothing else', () => {
    const statements = sql
      .replace(/\$(\w*)\$.*?\$\1\$/g, '<body>')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "set local lock_timeout = '3s'",
      'create or replace function reject_cross_user_account() returns trigger language plpgsql security definer set search_path = public, pg_temp as <body>',
      'revoke execute on function reject_cross_user_account() from public',
      'revoke execute on function reject_cross_user_account() from anon, authenticated',
      ...TABLES.flatMap((table) => [
        `drop trigger if exists ${table}_guard_user_account on ${table}`,
        `create trigger ${table}_guard_user_account before insert or update of account_id, user_id on ${table} for each row execute function reject_cross_user_account()`,
      ]),
      'do <body>',
    ]);
  });

  it('is what the migration workflow offers by default: the newest file in supabase/migrations', () => {
    const workflow = load(
      fs.readFileSync(
        path.join(__dirname, '../../.github/workflows/migrate.yml'),
        'utf8'
      )
    ) as any;
    const newest = fs
      .readdirSync(DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort()
      .pop();

    // Not `newest === FILE`: the next migration's own pull request moves the
    // default, and this pin follows it without an edit here.
    expect(fs.readdirSync(DIR)).toContain(FILE);
    expect(workflow.on.workflow_dispatch.inputs.migration.default).toBe(newest);
  });
});

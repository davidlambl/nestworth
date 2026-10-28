#!/usr/bin/env node
// The migration rehearsal (#93): applies a migration a second time to the
// local Supabase stack's database, with the command migrate.yml applies it
// with, and checks that the second application changed nothing. From 005 on
// every migration must be safe to run twice (sync-engine.md), and until this
// check the first time that was tried was on production.
//
//   npx supabase db start         # Postgres alone; every migration from empty
//   npx supabase db reset --local # the same again, after editing a migration
//   npm run db:rehearse           # the newest migration, a second time
//   npm run db:rehearse -- --file 011_name.sql
//
// The test workflow's "Migration rehearsal" job runs the first and the third
// on every push. CONTRIBUTING.md section 3 has the recipe.
//
// It refuses any database but the local stack's before it runs psql: the
// connection string must name 127.0.0.1, localhost or ::1, with no query
// string, no fragment and no second "@", and psql gets it rebuilt from the
// parts that were checked, never as given (libpq reads a "#", a "?" before
// an "@" or a second "@" otherwise than the URL parser here, and would
// connect to the host it read). psql runs without the PG* environment
// variables, which could send it to another address (PGHOSTADDR, or a
// PGSERVICE entry's hostaddr). It reads no secret and needs none; the local
// password is the CLI's public default. Exit status 0 when the rehearsal
// passed, 1 when it was refused or failed.

const { Buffer } = require('buffer');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * The local stack's database: `[db] port` in supabase/config.toml, and the
 * password every local Supabase stack uses.
 */
const DEFAULT_DB_URL =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * How migrate.yml applies a file to production:
 * `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`.
 * One transaction, stopped at the first error, ~/.psqlrc ignored.
 */
const APPLY_FLAGS = ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction'];

const MIGRATIONS_DIR = 'supabase/migrations';

/** migrate.yml refuses these: applied by hand before it existed, never replayable. */
const NOT_REPLAYABLE = /^00[1-4]_/;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A failed second application stays in the database, as it would on production. */
const RESET_HINT =
  'The local database keeps what the second application did: `npx supabase db reset --local` before the next rehearsal.';

/** Each migration the CLI applied, as the file name it applied it from. */
const APPLIED_SQL = `select version || '_' || coalesce(name, '') || '.sql'
  from supabase_migrations.schema_migrations order by version`;

/**
 * What the migrations own, one line per object, so that two readings can be
 * compared line by line: the schema of public (tables, columns, constraints,
 * indexes, views, enums, functions and who may execute them, table grants),
 * the triggers and policies of public, auth and storage, the publications,
 * the extensions and the cron jobs. A cron job's id is left out: every apply
 * of 007 makes a new one. Each line is built with format(), which prints a
 * NULL as an empty field: in a || chain one NULL makes the whole line NULL,
 * which psql prints as an empty line the comparison never sees (a pg_cron
 * job scheduled without a name has a NULL jobname).
 */
const CATALOG_SQL = `select line from (
  select format('table %s rls=%s force=%s', c.oid::regclass, c.relrowsecurity, c.relforcerowsecurity) as line
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  union all
  select format('column %s.%s %s null=%s default=%s', table_name, column_name, data_type, is_nullable, column_default)
    from information_schema.columns where table_schema = 'public'
  union all
  select format('constraint %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select format('index %s %s', indexname, indexdef) from pg_indexes where schemaname = 'public'
  union all
  select format('view %s %s', viewname, md5(definition)) from pg_views where schemaname = 'public'
  union all
  select format('enum %s %s', t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder))
    from pg_type t join pg_enum e on e.enumtypid = t.oid
   where t.typnamespace = 'public'::regnamespace group by t.typname
  union all
  select format('function %s %s owner=%s definer=%s config=%s', p.oid::regprocedure, md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner), p.prosecdef, array_to_string(p.proconfig, ','))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
  union all
  select format('execute %s %s=%s', p.oid::regprocedure, r.name, has_function_privilege(r.name, p.oid, 'execute'))
    from pg_proc p cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(name)
   where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
  union all
  select format('grant %s %s %s', table_name, grantee, privilege_type)
    from information_schema.role_table_grants where table_schema = 'public'
  union all
  select format('trigger %s %s enabled=%s', t.tgrelid::regclass, pg_get_triggerdef(t.oid), t.tgenabled)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace)
  union all
  select format('policy %s.%s %s %s %s %s using=%s check=%s', schemaname, tablename, policyname, permissive, cmd, roles, qual, with_check)
    from pg_policies where schemaname in ('public', 'auth', 'storage')
  union all
  select format('publication %s %s.%s', pubname, schemaname, tablename) from pg_publication_tables
  union all
  select format('extension %s %s %s', extname, extversion, extnamespace::regnamespace) from pg_extension
  union all
  select format('cron %s %s %s %s %s active=%s', jobname, schedule, command, username, database, active) from cron.job
) catalog order by line`;

/**
 * The connection string psql gets for `url`, when `url` names the local
 * stack's database; else an error. psql gets the parts this check read, put
 * together again, never `url` as given, because libpq reads a connection
 * string otherwise than the URL parser here: it has no fragment, so
 * "#?hostaddr=..." is a parameter to it; it ends the user part at the first
 * "@", even after a "?", where the URL parser ends it at the last; and after
 * that "@" it reads a list of hosts. So a query string, a fragment and a
 * second "@" are refused (a parameter can also name a host, hostaddr or
 * service), and so is a "%" not followed by two hex digits, or a "%00":
 * psql would refuse it and repeat that part, a password perhaps, in its
 * error. A message never repeats the string: a mistaken one could hold a
 * real password.
 */
function localDbUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'the database URL is not a single-host postgresql:// connection string'
    );
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('the database URL must start with postgresql://');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `refusing host "${parsed.hostname}": the rehearsal runs against the local stack only (127.0.0.1, localhost or ::1)`
    );
  }
  if (/[?#]/.test(url)) {
    throw new Error(
      'the database URL may carry no query string and no fragment: libpq, which has no fragments, reads what follows a "?" as connection parameters, and a host, hostaddr or service among them would send psql elsewhere'
    );
  }
  if (url.split('@').length > 2) {
    throw new Error(
      'the database URL holds more than one "@": libpq ends the user part at the first one and this check at the last, so the two read different hosts (write an "@" in a password as %40)'
    );
  }
  const { username, password, pathname } = parsed;
  if (
    [username, password, pathname].some((part) =>
      /%(?![0-9a-f]{2})|%00/i.test(part)
    )
  ) {
    throw new Error(
      'the database URL holds a "%" that is not followed by two hex digits, or a "%00": psql would refuse it and repeat that part in its error'
    );
  }
  const user =
    username || password ? `${username}${password ? `:${password}` : ''}@` : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${user}${parsed.hostname}${port}${pathname}`;
}

/** Byte order, as the CLI sorts the migrations it applies. */
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The `.sql` files in `dir`, in the order the CLI applies them. */
function listMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort(byteOrder);
}

/**
 * The problems that make a rehearsal of `file` mean something other than
 * "its second application, where production will apply it": a file up to it
 * that the CLI did not apply (it skips a name not shaped `<digits>_<name>.sql`
 * and only warns, or the stack predates the file), a newer migration already
 * applied, or one this checkout does not have.
 */
function checkApplied(files, applied, file) {
  const upTo = files.slice(0, files.indexOf(file) + 1);
  const problems = [];
  const missing = upTo.filter((name) => !applied.includes(name));
  const newer = applied.filter(
    (name) => files.includes(name) && !upTo.includes(name)
  );
  const unknown = applied.filter((name) => !files.includes(name));
  if (missing.length > 0) {
    problems.push(
      `not applied from empty: ${missing.join(', ')}. The CLI applies only files named <digits>_<name>.sql (it skips any other name with a warning), and a stack started before the file existed needs \`npx supabase db reset --local\`.`
    );
  }
  if (newer.length > 0) {
    problems.push(
      `the local database already holds ${newer.join(', ')}, which production applies after ${file}: \`npx supabase db reset --local --version ${file.split('_')[0]}\` first.`
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `the local database holds ${unknown.join(', ')}, which this checkout does not have: \`npx supabase db reset --local\` starts it again from this checkout's files.`
    );
  }
  return problems;
}

/** The file to apply a second time: the one asked for, else the newest. */
function pickMigration(files, requested) {
  const file = requested ?? files[files.length - 1];
  if (!file) {
    throw new Error(`no migrations in ${MIGRATIONS_DIR}`);
  }
  if (!files.includes(file)) {
    throw new Error(`${MIGRATIONS_DIR}/${file} does not exist`);
  }
  if (NOT_REPLAYABLE.test(file)) {
    throw new Error(
      `${file} predates migrate.yml and is not safe to replay; it is applied from empty only`
    );
  }
  return file;
}

/** The lines one reading has and the other lacks, duplicates counted. */
function compareCatalog(before, after) {
  const count = (lines) => {
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const left = count(before);
  const right = count(after);
  const only = (a, b) =>
    [...a].flatMap(([line, n]) =>
      Array(Math.max(0, n - (b.get(line) ?? 0))).fill(line)
    );
  return { removed: only(left, right), added: only(right, left) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--file' || flag === '--db-url') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      options[flag === '--file' ? 'file' : 'dbUrl'] = value;
      i += 1;
    } else {
      throw new Error(
        `unknown argument ${flag}; usage: npm run db:rehearse [-- --file <name>.sql] [-- --db-url <local URL>]`
      );
    }
  }
  return options;
}

/**
 * The environment psql runs in: this process's without the libpq variables
 * (PGHOST, PGHOSTADDR, PGPORT, PGSERVICE, PGSERVICEFILE, PGPASSWORD, ...).
 * libpq takes every parameter the connection string leaves out from them, and
 * a `hostaddr` is the address it connects to whatever host the string names:
 * `PGHOSTADDR`, or a `PGSERVICE` entry with one, would send the rehearsal to
 * another server than the 127.0.0.1 localDbUrl checked. Without them the
 * checked string alone says where psql connects.
 */
function psqlEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('PG'))
  );
}

/**
 * Runs psql: what it wrote to stdout and to stderr (where the server's
 * notices go), or an error carrying both when it could not run or exited
 * non-zero.
 *
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, spawn?: typeof spawnSync }} [deps]
 * @returns {{ stdout: string, stderr: string }}
 */
function runPsql(args, { env = process.env, spawn = spawnSync } = {}) {
  const result = spawn('psql', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: psqlEnv(env),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(`psql exited with ${result.status}`), {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function lines(text) {
  return text.split('\n').filter((line) => line.length > 0);
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  psql = runPsql,
  write = (line) => console.log(line),
} = {}) {
  const annotate = env.GITHUB_ACTIONS === 'true';
  const fail = (message) => {
    write(
      annotate
        ? `::error title=Migration rehearsal::${escapeData(message)}`
        : `Migration rehearsal failed: ${message}`
    );
    return 1;
  };
  let options;
  let url;
  try {
    options = parseArgs(argv);
    url = localDbUrl(options.dbUrl ?? DEFAULT_DB_URL);
  } catch (e) {
    return fail(e.message);
  }
  const query = (sql) =>
    lines(
      psql(['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql, url])
        .stdout
    );
  const files = listMigrations(path.join(cwd, MIGRATIONS_DIR));
  let file;
  let before;
  try {
    file = pickMigration(files, options.file);
    const problems = checkApplied(files, query(APPLIED_SQL), file);
    if (problems.length > 0) return fail(problems.join('\n'));
    before = query(CATALOG_SQL);
  } catch (e) {
    return fail(describe(e));
  }
  write(
    `Every migration up to ${file} was applied from empty. Applying it a second time, as migrate.yml applies it:`
  );
  try {
    const { stdout, stderr } = psql([
      url,
      ...APPLY_FLAGS,
      '-f',
      `${MIGRATIONS_DIR}/${file}`,
    ]);
    // The command tags, then the notices: what the owner reads beside the
    // log of the production run.
    lines(stdout + stderr).forEach(write);
  } catch (e) {
    return fail(
      `the second application of ${file} failed:\n${describe(e)}\n${RESET_HINT}`
    );
  }
  let after;
  try {
    after = query(CATALOG_SQL);
  } catch (e) {
    return fail(`${describe(e)}\n${RESET_HINT}`);
  }
  const { removed, added } = compareCatalog(before, after);
  if (removed.length > 0 || added.length > 0) {
    return fail(
      [
        `the second application of ${file} changed the database:`,
        ...removed.map((line) => `- ${line}`),
        ...added.map((line) => `+ ${line}`),
        RESET_HINT,
      ].join('\n')
    );
  }
  const summary = `${file} applied a second time without an error and without a change (${before.length} catalog lines compared).`;
  write(summary);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Migration rehearsal\n\n${summary}\n`
    );
  }
  return 0;
}

/** What psql said, or why it could not run. */
function describe(e) {
  if (e?.code === 'ENOENT') {
    return 'psql is not on PATH: install the PostgreSQL client tools';
  }
  const said = [e?.stdout, e?.stderr].filter(Boolean).join('').trim();
  if (/connection to server .* failed/i.test(said)) {
    return `${said}\nIs the local stack running? \`npx supabase db start\` starts it.`;
  }
  return said || String(e?.message ?? e);
}

/** A message as a workflow command's data: `%`, CR and LF escaped. */
function escapeData(message) {
  return message
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(`Migration rehearsal failed: ${e?.message ?? e}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  APPLIED_SQL,
  APPLY_FLAGS,
  CATALOG_SQL,
  DEFAULT_DB_URL,
  MIGRATIONS_DIR,
  checkApplied,
  compareCatalog,
  listMigrations,
  localDbUrl,
  main,
  pickMigration,
  runPsql,
};

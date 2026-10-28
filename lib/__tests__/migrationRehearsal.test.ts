// scripts/rehearse-migration.js (#93), the rehearsal the "Migration
// rehearsal" job and CONTRIBUTING's recipe run: it applies a migration a
// second time to the local stack's database with migrate.yml's psql command
// and fails when that errs or changes the catalog. It must refuse any
// database but the local one before it runs anything, refuse a rehearsal the
// CLI made meaningless (a file it skipped), and never replay 001-004. psql is
// a stand-in here; the measured runs against a real local stack are in the
// pull request.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CATALOG_SQL,
  DEFAULT_DB_URL,
  checkApplied,
  compareCatalog,
  listMigrations,
  localDbUrl,
  main,
  pickMigration,
  runPsql,
} from '../../scripts/rehearse-migration';

const FILES = [
  '001_initial.sql',
  '005_tombstones.sql',
  '009_receipt_storage_policies.sql',
  '010_cross_user_account_guard.sql',
];

describe('localDbUrl', () => {
  it.each([
    DEFAULT_DB_URL,
    'postgresql://postgres:postgres@localhost:54322/postgres',
    'postgres://postgres:postgres@[::1]:54322/postgres',
    'postgresql://127.0.0.1:54322/postgres',
    'postgresql://postgres:pa%40ss@127.0.0.1:54322/postgres',
  ])('takes the local stack: %s', (url) => {
    expect(localDbUrl(url)).toBe(url);
  });

  it('hands psql the parts it checked, rebuilt, never the string it was given', () => {
    // libpq's URI prefix is case-sensitive: given as it is, this string is a
    // database name on libpq's default socket, not 127.0.0.1.
    expect(
      localDbUrl('POSTGRESQL://postgres:postgres@127.0.0.1:54322/postgres')
    ).toBe(DEFAULT_DB_URL);
  });

  it.each([
    [
      'a hosted database',
      'postgresql://postgres:s3cret@db.abcdefghijklmnop.supabase.co:5432/postgres',
    ],
    [
      'the session pooler',
      'postgresql://postgres.abcdefghijklmnop:s3cret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    ],
    [
      'a look-alike host',
      'postgresql://postgres:s3cret@127.0.0.1.example.com:5432/postgres',
    ],
    [
      'a local name in the user part',
      'postgresql://127.0.0.1:s3cret@db.abcdefghijklmnop.supabase.co/postgres',
    ],
    [
      'a host parameter',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres?host=db.abcdefghijklmnop.supabase.co',
    ],
    [
      'a hostaddr parameter',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres?hostaddr=10.0.0.1',
    ],
    [
      'a service',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres?service=production',
    ],
    [
      'any other parameter',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres?sslmode=disable',
    ],
    // libpq has no fragments: it reads "#?hostaddr=..." as parameters.
    [
      'a fragment',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres#?hostaddr=10.0.0.1',
    ],
    [
      'a fragment without a query',
      'postgresql://postgres:s3cret@127.0.0.1:54322/postgres#s3cret',
    ],
    // libpq ends the user part at the first "@", even after a "?".
    [
      'a query string libpq reads as the user part',
      'postgresql://127.0.0.1?:s3cret@db.abcdefghijklmnop.supabase.co:5432/postgres',
    ],
    // ...and then reads a list of hosts; this check reads the last "@".
    [
      'a second "@"',
      'postgresql://postgres:s3cret@db.abcdefghijklmnop.supabase.co,@127.0.0.1:54322/postgres',
    ],
    [
      'a list of hosts',
      'postgresql://postgres:s3cret@127.0.0.1:54322,db.abcdefghijklmnop.supabase.co:5432/postgres',
    ],
    ['a socket directory', 'postgresql:///postgres?host=/tmp'],
    ['another scheme', 'https://127.0.0.1:54322/postgres'],
    // psql's own error would repeat the part it cannot decode.
    [
      'a "%" without two hex digits in the password',
      'postgresql://postgres:s3cret%zz@127.0.0.1:54322/postgres',
    ],
    [
      'a "%00" in the password',
      'postgresql://postgres:s3cret%00@127.0.0.1:54322/postgres',
    ],
    [
      'a "%" without two hex digits in the user',
      'postgresql://s3cret%zz@127.0.0.1:54322/postgres',
    ],
    [
      'a "%" without two hex digits in the database name',
      'postgresql://postgres@127.0.0.1:54322/s3cret%zz',
    ],
  ])('refuses %s, without repeating the string', (_what, url) => {
    let message = '';
    try {
      localDbUrl(url);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('s3cret');
  });
});

describe('listMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-list-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the .sql files in byte order, as the CLI applies them', () => {
    // Byte order, not numeric: 9_ comes after 010_ and 10_. And not the
    // UTF-16 order of a default sort: U+FF5E (EF BD 9E in UTF-8) comes
    // before U+1D11E (F0 9D 84 9E) as bytes, after it in UTF-16.
    for (const name of [
      '9_b.sql',
      '10_d.sql',
      '010_c.sql',
      '011-misnamed.sql',
      'README.md',
      '012_e.sql.bak',
      '013_\u{1d11e}.sql',
      '013_～.sql',
    ]) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    expect(listMigrations(dir)).toEqual([
      '010_c.sql',
      '011-misnamed.sql',
      '013_～.sql',
      '013_\u{1d11e}.sql',
      '10_d.sql',
      '9_b.sql',
    ]);
  });
});

describe('pickMigration', () => {
  it('takes the newest file in byte order, as the CLI applies them', () => {
    expect(pickMigration(FILES, undefined)).toBe(
      '010_cross_user_account_guard.sql'
    );
  });

  it('takes the file asked for', () => {
    expect(pickMigration(FILES, '009_receipt_storage_policies.sql')).toBe(
      '009_receipt_storage_policies.sql'
    );
  });

  it('refuses a file that is not there, and an empty directory', () => {
    expect(() => pickMigration(FILES, '011_missing.sql')).toThrow(
      'supabase/migrations/011_missing.sql does not exist'
    );
    expect(() => pickMigration([], undefined)).toThrow('no migrations');
  });

  it('never replays 001-004, which migrate.yml refuses too', () => {
    expect(() => pickMigration(FILES, '001_initial.sql')).toThrow(
      'predates migrate.yml'
    );
    expect(() =>
      pickMigration(['004_exclude_from_total.sql'], undefined)
    ).toThrow('predates migrate.yml');
  });
});

describe('checkApplied', () => {
  const NEWEST = '010_cross_user_account_guard.sql';

  it('has nothing to say when the CLI applied every file up to the one rehearsed', () => {
    expect(checkApplied(FILES, FILES, NEWEST)).toEqual([]);
    expect(
      checkApplied(FILES, FILES.slice(0, 3), '009_receipt_storage_policies.sql')
    ).toEqual([]);
  });

  it('names a file the CLI skipped, which no rehearsal can prove anything about', () => {
    const files = [...FILES, '011-misnamed.sql'];
    const [problem] = checkApplied(files, FILES, '011-misnamed.sql');
    expect(problem).toContain('not applied from empty: 011-misnamed.sql');
    expect(problem).toContain('<digits>_<name>.sql');
  });

  it('names a newer migration already applied, which production applies after the one rehearsed', () => {
    const [problem] = checkApplied(
      FILES,
      FILES,
      '009_receipt_storage_policies.sql'
    );
    expect(problem).toContain(
      `the local database already holds ${NEWEST}, which production applies after 009_receipt_storage_policies.sql`
    );
    expect(problem).toContain('npx supabase db reset --local --version 009');
  });

  it('names a migration the database holds and this checkout lacks', () => {
    const [problem] = checkApplied(
      FILES,
      [...FILES, '011_elsewhere.sql'],
      NEWEST
    );
    expect(problem).toContain('the local database holds 011_elsewhere.sql');
    expect(problem).toContain('npx supabase db reset --local');
  });
});

describe('compareCatalog', () => {
  it('finds nothing between two equal readings, whatever their order', () => {
    expect(compareCatalog(['a', 'b'], ['b', 'a'])).toEqual({
      removed: [],
      added: [],
    });
  });

  it('counts a line that appears once more, as a second trigger or index would', () => {
    expect(compareCatalog(['a', 'b'], ['a', 'b', 'b', 'c'])).toEqual({
      removed: [],
      added: ['b', 'c'],
    });
    expect(compareCatalog(['a', 'a'], ['a'])).toEqual({
      removed: ['a'],
      added: [],
    });
  });
});

describe('the catalog reading', () => {
  it('covers what a migration here creates, and leaves out the cron job id', () => {
    for (const kind of [
      'table',
      'column',
      'constraint',
      'index',
      'view',
      'enum',
      'function',
      'execute',
      'grant',
      'trigger',
      'policy',
      'publication',
      'extension',
      'cron',
    ]) {
      expect(CATALOG_SQL).toContain(`format('${kind} `);
    }
    expect(CATALOG_SQL).not.toContain('jobid');
    expect(CATALOG_SQL).toContain(
      "schemaname in ('public', 'auth', 'storage')"
    );
  });

  it('reads the fields a second application could change', () => {
    for (const field of [
      // row level security switched off, or forced
      'c.relrowsecurity',
      'c.relforcerowsecurity',
      // a function's body, owner, security and settings (its search_path)
      'md5(pg_get_functiondef(p.oid))',
      'pg_get_userbyid(p.proowner)',
      'p.prosecdef',
      'p.proconfig',
      // a trigger's definition, whether it fires, and auth's and storage's
      'pg_get_triggerdef(t.oid)',
      't.tgenabled',
      "c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace)",
    ]) {
      expect(CATALOG_SQL).toContain(field);
    }
  });

  it('builds every line with format(), so that a NULL field cannot drop a line', () => {
    // One NULL in a || chain makes the whole line NULL, which psql prints as
    // an empty line and the comparison never sees: a pg_cron job scheduled
    // without a name (its jobname is NULL) twice would pass. format() prints
    // a NULL as an empty field.
    expect(CATALOG_SQL).not.toContain('||');
  });
});

describe('runPsql', () => {
  it('runs psql without the libpq variables, so the checked string alone says where it connects', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: '1\n', stderr: '' }));
    const args = ['-X', '-c', 'select 1', DEFAULT_DB_URL];
    expect(
      runPsql(args, {
        env: {
          PATH: '/usr/bin',
          HOME: '/home/someone',
          PGHOSTADDR: '10.0.0.1',
          PGSERVICE: 'production',
          PGSERVICEFILE: '/etc/pg_service.conf',
          PGHOST: 'db.abcdefghijklmnop.supabase.co',
          PGPASSWORD: 's3cret',
        },
        spawn: spawn as any,
      })
    ).toEqual({ stdout: '1\n', stderr: '' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'psql',
      args,
      expect.objectContaining({
        env: { PATH: '/usr/bin', HOME: '/home/someone' },
      })
    );
  });
});

describe('main', () => {
  let dir: string;
  let lines: string[];
  let calls: string[][];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-migration-'));
    fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
    for (const file of FILES) {
      fs.writeFileSync(path.join(dir, 'supabase', 'migrations', file), '');
    }
    lines = [];
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const NOTICE =
    'NOTICE:  trigger "transactions_guard_user_account" for relation "transactions" does not exist, skipping';

  /** A psql that answers from the scripts below, recording every call. */
  const fakePsql =
    ({
      applied = FILES,
      catalogs = [['trigger a'], ['trigger a']],
      apply = () => ({
        stdout: 'DROP TRIGGER\nCREATE TRIGGER\n',
        stderr: `${NOTICE}\n`,
      }),
    }: {
      applied?: string[];
      catalogs?: string[][];
      apply?: () => { stdout: string; stderr: string };
    } = {}) =>
    (args: string[]) => {
      calls.push(args);
      const sql = args[args.indexOf('-c') + 1];
      if (args.includes('-c') && sql.includes('schema_migrations')) {
        return { stdout: applied.join('\n') + '\n', stderr: '' };
      }
      if (args.includes('-c')) {
        return {
          stdout: (catalogs.shift() ?? []).join('\n') + '\n',
          stderr: '',
        };
      }
      return apply();
    };

  type Psql = (args: string[]) => { stdout: string; stderr: string };
  const run = (
    psql: Psql,
    over: { argv?: string[]; env?: Record<string, string> } = {}
  ) =>
    main({
      argv: over.argv ?? [],
      env: (over.env ?? {}) as any,
      cwd: dir,
      psql,
      write: (line: string) => lines.push(line),
    });

  it("applies the newest file once more with migrate.yml's flags, between two catalog readings", async () => {
    const summary = path.join(dir, 'summary.md');
    expect(
      await run(fakePsql(), { env: { GITHUB_STEP_SUMMARY: summary } })
    ).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[2]).toEqual([
      DEFAULT_DB_URL,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '--single-transaction',
      '-f',
      'supabase/migrations/010_cross_user_account_guard.sql',
    ]);
    for (const query of [calls[0], calls[1], calls[3]]) {
      expect(query.slice(0, 7)).toEqual([
        '-X',
        '-A',
        '-t',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
      ]);
      expect(query[query.length - 1]).toBe(DEFAULT_DB_URL);
    }
    // The command tags, then the server's notices, as the production run's
    // log shows them.
    expect(lines).toEqual([
      'Every migration up to 010_cross_user_account_guard.sql was applied from empty. Applying it a second time, as migrate.yml applies it:',
      'DROP TRIGGER',
      'CREATE TRIGGER',
      NOTICE,
      '010_cross_user_account_guard.sql applied a second time without an error and without a change (1 catalog lines compared).',
    ]);
    expect(fs.readFileSync(summary, 'utf8')).toContain(
      '010_cross_user_account_guard.sql applied a second time'
    );
  });

  it.each([
    'postgresql://postgres:s3cret@db.abcdefghijklmnop.supabase.co:5432/postgres',
    'postgresql://postgres:s3cret@127.0.0.1:54322/postgres#?hostaddr=10.0.0.1',
    'postgresql://postgres:s3cret@db.abcdefghijklmnop.supabase.co,@127.0.0.1:54322/postgres',
  ])(
    'refuses a database that is not the local stack before running psql at all: %s',
    async (url) => {
      const code = await run(fakePsql(), { argv: ['--db-url', url] });
      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(lines.join('\n')).not.toContain('s3cret');
    }
  );

  it('hands psql the connection string it checked, rebuilt, in every call', async () => {
    expect(
      await run(fakePsql(), {
        argv: [
          '--db-url',
          'POSTGRESQL://postgres:postgres@127.0.0.1:54322/postgres',
        ],
      })
    ).toBe(0);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call).toContain(DEFAULT_DB_URL);
      expect(call.join(' ')).not.toContain('POSTGRESQL://');
    }
  });

  it('refuses before applying anything when the CLI skipped a file', async () => {
    fs.writeFileSync(
      path.join(dir, 'supabase', 'migrations', '011-misnamed.sql'),
      ''
    );
    expect(await run(fakePsql())).toBe(1);
    expect(calls).toHaveLength(1);
    expect(lines.join('\n')).toContain(
      'not applied from empty: 011-misnamed.sql'
    );
  });

  it('fails, with what psql said, when the second application errs', async () => {
    const psql = fakePsql({
      apply: () => {
        throw Object.assign(new Error('psql exited with 3'), {
          stdout: '',
          stderr: 'ERROR:  policy "x" for table "accounts" already exists\n',
        });
      },
    });
    expect(await run(psql, { env: { GITHUB_ACTIONS: 'true' } })).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^::error title=Migration rehearsal::/);
    expect(lines[1]).toContain(
      'policy "x" for table "accounts" already exists'
    );
    expect(lines[1]).toContain('npx supabase db reset --local');
  });

  it('escapes a workflow command and says how to start a stack that is not running', async () => {
    const psql = () => {
      throw Object.assign(new Error('psql exited with 2'), {
        stdout: '',
        stderr:
          'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused (100%)\n',
      });
    };
    expect(await run(psql, { env: { GITHUB_ACTIONS: 'true' } })).toBe(1);
    expect(lines).toEqual([
      '::error title=Migration rehearsal::psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused (100%25)%0AIs the local stack running? `npx supabase db start` starts it.',
    ]);
  });

  it('fails readably, saying the database changed, when the catalog cannot be read after the second application', async () => {
    let reads = 0;
    const psql = (args: string[]) => {
      if (
        args.includes('-c') &&
        args[args.indexOf('-c') + 1].includes('schema_migrations')
      ) {
        return { stdout: FILES.join('\n') + '\n', stderr: '' };
      }
      if (args.includes('-c')) {
        reads += 1;
        if (reads === 2) {
          throw Object.assign(new Error('psql exited with 2'), {
            stdout: '',
            stderr: 'ERROR:  relation "cron.job" does not exist\n',
          });
        }
        return { stdout: 'trigger a\n', stderr: '' };
      }
      return { stdout: 'DO\n', stderr: '' };
    };
    expect(await run(psql)).toBe(1);
    expect(lines[lines.length - 1]).toBe(
      'Migration rehearsal failed: ERROR:  relation "cron.job" does not exist\nThe local database keeps what the second application did: `npx supabase db reset --local` before the next rehearsal.'
    );
  });

  it('fails, naming each line, when the second application changes the catalog', async () => {
    const psql = fakePsql({
      catalogs: [['index a'], ['index a', 'index probe_1']],
    });
    expect(await run(psql)).toBe(1);
    expect(lines[lines.length - 1]).toContain('+ index probe_1');
  });

  it('fails, naming the line, when the second application removes something', async () => {
    const psql = fakePsql({
      catalogs: [['index a', 'policy p'], ['index a']],
    });
    expect(await run(psql)).toBe(1);
    expect(lines[lines.length - 1]).toContain('- policy p');
  });

  it('rehearses the file asked for, on a database that stops at it', async () => {
    expect(
      await run(fakePsql({ applied: FILES.slice(0, 3) }), {
        argv: ['--file', '009_receipt_storage_policies.sql'],
      })
    ).toBe(0);
    expect(calls[2][calls[2].length - 1]).toBe(
      'supabase/migrations/009_receipt_storage_policies.sql'
    );
  });
});

// The "Migration rehearsal" job in .github/workflows/test.yml (#93) applies
// every migration from empty to a local Supabase database on the runner and
// the newest a second time, before the owner applies it to production with
// migrate.yml. Its one invariant: it cannot reach the hosted project. It
// names no secret and no environment, may only read the repository, and runs
// no CLI command that talks to a hosted project (login, link, db push, a
// --linked or --db-url target). It always runs, so a pull request cannot
// skip it. The rehearsal applies a file the way migrate.yml does, and the CLI
// it runs is the version package.json pins.
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts); no
// dependency is added for this pin.
import { load } from 'js-yaml';
import { APPLY_FLAGS, DEFAULT_DB_URL } from '../../scripts/rehearse-migration';

const ROOT = path.join(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workflow = load(read('.github/workflows/test.yml')) as any;
const job = workflow.jobs.migrations;
const jobText = JSON.stringify(job);

/**
 * The `key = value` lines of one `[section]` of supabase/config.toml (no TOML
 * parser is in the tree; the file uses flat sections only).
 */
function tomlSection(name: string): Record<string, string> {
  const values: Record<string, string> = {};
  let current = '';
  for (const raw of read('supabase/config.toml').split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
    } else if (current === name && /^[a-z_]+\s*=/.test(line)) {
      const [key, ...rest] = line.split('=');
      values[key.trim()] = rest.join('=').trim();
    }
  }
  return values;
}

describe('the Migration rehearsal job (#93)', () => {
  it('runs on every push and pull request, never skipped', () => {
    expect(job.name).toBe('Migration rehearsal');
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  });

  it('names no secret and no environment, and may only read the repository', () => {
    // Every way of reading the secrets context names it, in any case, as
    // GitHub reads it: in the job as parsed (a YAML escape or alias spells it
    // there too) and in the workflow-level env every job inherits.
    expect(jobText).not.toMatch(/\bsecrets\b/i);
    expect(job.environment).toBeUndefined();
    expect(workflow.env).toBeUndefined();
    expect(job.permissions).toEqual({ contents: 'read' });
  });

  it("sets one variable, the switch that turns the CLI's telemetry off", () => {
    expect(job.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: '1' });
  });

  it('runs no command that talks to a hosted project', () => {
    for (const step of job.steps) {
      const run = String(step.run ?? '');
      expect(run).not.toMatch(
        /\b(login|link|push|pull|projects|secrets|--linked|--db-url|--project-ref)\b/
      );
    }
    expect(jobText).not.toMatch(/supabase\.(co|com)\b/i);
    expect(jobText).not.toMatch(/SUPABASE_(ACCESS_TOKEN|DB_PASSWORD|DB_URL)/);
  });

  it('starts a local database from empty, then rehearses the newest migration', () => {
    expect(
      job.steps.map((step: any) => step.uses?.replace(/@.*$/, '') ?? step.run)
    ).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci',
      'npx supabase db start',
      'npm run db:rehearse',
    ]);
    expect(job.steps[0].with).toEqual({ 'persist-credentials': false });
  });

  it('runs on the Node version every other job runs on', () => {
    const nodeOf = (each: any) =>
      each.steps.find((step: any) => /setup-node/.test(step.uses ?? ''))?.with[
        'node-version'
      ];
    expect(nodeOf(job)).toBe(nodeOf(workflow.jobs.check));
  });
});

describe('the rehearsal matches migrate.yml', () => {
  it('applies a file with the flags migrate.yml applies it with', () => {
    const migrate = load(read('.github/workflows/migrate.yml')) as any;
    const apply = migrate.jobs.apply.steps.find(
      (step: any) => step.name === 'Apply the migration'
    );
    const command =
      /psql "\$DATABASE_URL" (.+?) -f "supabase\/migrations\/\$MIGRATION"/.exec(
        apply.run.replace(/\\\n\s*/g, ' ')
      );
    expect(command?.[1].trim().split(/\s+/)).toEqual(APPLY_FLAGS);
  });
});

describe('the local stack the job starts', () => {
  it('connects where supabase/config.toml puts the database', () => {
    expect(new URL(DEFAULT_DB_URL).port).toBe(tomlSection('db').port);
    expect(tomlSection('db').major_version).toBe('17');
  });

  it('is the CLI version package.json pins, exactly', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(pkg.devDependencies.supabase).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/supabase'].version).toBe(
      pkg.devDependencies.supabase
    );
    expect(pkg.scripts['db:rehearse']).toBe(
      'node scripts/rehearse-migration.js'
    );
  });

  it("holds the receipts bucket 009's policies are about, private as on the hosted project", () => {
    expect(tomlSection('storage.buckets.receipts')).toEqual({
      public: 'false',
    });
    expect(tomlSection('storage').enabled).toBe('true');
    expect(tomlSection('auth').enabled).toBe('true');
  });

  it('keeps the Data API grants 001 relies on, and starts from an empty database', () => {
    // An explicit false revokes the Data API grants that 001 relies on.
    expect(tomlSection('api').auto_expose_new_tables).toBe('true');
    expect(tomlSection('db.seed').enabled).toBe('false');
  });

  it('signs a new user in at once, though the sign-up screen expects a confirmation email', () => {
    expect(tomlSection('auth.email').enable_confirmations).toBe('false');
  });
});

// .github/workflows/migrate.yml applies a migration with SUPABASE_DB_URL, the
// project's Postgres connection string for its owner role: it reads and
// writes every table and every user's rows. Since #190 it is a secret of the
// `migrate` environment, whose one deployment rule is the branch main, so no
// other branch's run can read it. That rule lives on GitHub, not in this
// repository, and a branch can edit this file but not the environment. What
// is pinned here is the shape a reviewed change on main could loosen: the job
// runs in that environment, the secret reaches the two steps that connect and
// nothing else, no other workflow names the secret or the environment, and
// the job's one action runs from a commit, keeps no credentials and may only
// read the repository.
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts); no
// dependency is added for this pin.
import { load } from 'js-yaml';

const DIR = path.join(__dirname, '../../.github/workflows');
const text = fs.readFileSync(path.join(DIR, 'migrate.yml'), 'utf8');
const workflow = load(text) as any;
const job = workflow.jobs.apply;

describe('the migration workflow (#190)', () => {
  it('runs only when a person dispatches it', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('runs its one job in the migrate environment', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['apply']);
    expect(job.environment).toBe('migrate');
  });

  it('gives SUPABASE_DB_URL to the two steps that connect, and to nothing else', () => {
    // Every way of reading the secrets context names it: secrets.NAME,
    // secrets['NAME'], toJSON(secrets), `secrets: inherit`, in any case
    // (GitHub reads context and secret names case-insensitively). The word
    // is in the file twice, in those two steps' expressions, and nowhere
    // else: in the text as written, and in the workflow as GitHub reads it,
    // where a YAML escape or alias can spell it anywhere.
    expect(text.match(/\bsecrets\b/gi)).toHaveLength(2);
    expect(JSON.stringify(workflow).match(/\bsecrets\b/gi)).toHaveLength(2);
    expect(workflow.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(
      job.steps
        .filter((step: any) => /secrets/i.test(JSON.stringify(step)))
        .map((step: any) => [step.name, step.env.DATABASE_URL])
    ).toEqual([
      ['Check the connection', '${{ secrets.SUPABASE_DB_URL }}'],
      ['Apply the migration', '${{ secrets.SUPABASE_DB_URL }}'],
    ]);
  });

  it('says where the secret belongs when a run finds none', () => {
    const check = job.steps.find(
      (step: any) => step.name === 'Check the connection'
    );
    expect(check.run).toContain(
      '::error::SUPABASE_DB_URL is not set in the migrate environment'
    );
  });

  it('is the only workflow that names the secret or runs in the environment', () => {
    // Secret and environment names are not case sensitive on GitHub, a YAML
    // escape can spell either, and a job that chooses its environment in an
    // expression could choose this one. A secret name built in an expression
    // is beyond a text check; once no repository secret has the name, only a
    // job in the environment can read it, and that is what the second check
    // refuses.
    const others = fs
      .readdirSync(DIR)
      .filter((name) => /\.ya?ml$/.test(name) && name !== 'migrate.yml');
    expect(others.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const name of others) {
      const other = fs.readFileSync(path.join(DIR, name), 'utf8');
      const parsed = load(other) as any;
      if (/SUPABASE_DB_URL/i.test(other + JSON.stringify(parsed))) {
        found.push(name);
      }
      const jobs = parsed.jobs ?? {};
      for (const [id, each] of Object.entries<any>(jobs)) {
        const environment = String(
          each.environment?.name ?? each.environment ?? ''
        );
        if (/migrate|\$\{\{/i.test(environment)) {
          found.push(`${name} ${id}: ${environment}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('may read the repository and nothing more, and runs one action: the checkout, pinned to a commit, keeping no credentials', () => {
    // The runner holds the secret for the whole job, and an action the job
    // runs can read the runner's memory: a tag can be moved to a commit that
    // does. The same hardening as sweep-receipts.yml's.
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(workflow.permissions).toBeUndefined();
    const actions = job.steps.filter((step: any) => step.uses);
    expect(actions.map((step: any) => step.uses.replace(/@.*$/, ''))).toEqual([
      'actions/checkout',
    ]);
    expect(actions[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(actions[0].with).toEqual({ 'persist-credentials': false });
  });
});

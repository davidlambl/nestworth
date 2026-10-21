// .github/workflows/sweep-receipts.yml (#176) holds the one secret in the
// repository that bypasses RLS on every user's data. What keeps it to the
// sweep is the workflow's shape, pinned here: it runs on its schedule or by
// hand, never for a pull request (whose code nobody has reviewed); it can
// read the repository and nothing more; the key reaches the sweep step alone,
// after an install that runs no install script; and a weekly run reads its
// mode from the repository variable, a manual one from its own input.
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts); no
// dependency is added for this pin.
import { load } from 'js-yaml';

const FILE = path.join(__dirname, '../../.github/workflows/sweep-receipts.yml');
const workflow = load(fs.readFileSync(FILE, 'utf8')) as any;
const job = workflow.jobs.sweep;
const sweepStep = job.steps.find((step: any) => step.name === 'Sweep');

describe('the receipt sweep workflow (#176)', () => {
  it('runs weekly and by hand, and for nothing else', () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(workflow.on.schedule).toEqual([{ cron: '17 5 * * 0' }]);
    expect(workflow.on.workflow_dispatch.inputs.mode).toMatchObject({
      required: true,
      default: 'dry-run',
      type: 'choice',
      options: ['dry-run', 'apply'],
    });
  });

  it('may read the repository and nothing more', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['sweep']);
    expect(job.permissions).toBeUndefined();
  });

  it('gives the key to the sweep step alone, in the receipt_sweep environment, after an install that runs no script', () => {
    const text = fs.readFileSync(FILE, 'utf8');
    expect(text.match(/secrets\.RECEIPT_SWEEP_SECRET_KEY/g)).toHaveLength(1);
    expect(sweepStep.env.RECEIPT_SWEEP_SECRET_KEY).toBe(
      '${{ secrets.RECEIPT_SWEEP_SECRET_KEY }}'
    );
    expect(workflow.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(job.environment).toBe('receipt_sweep');
    expect(sweepStep.run).toBe('node scripts/sweep-receipts.js');
    const install = job.steps.find((step: any) =>
      /npm ci/.test(step.run ?? '')
    );
    expect(install.run).toMatch(/^npm ci --ignore-scripts\b/);
    const checkout = job.steps.find((step: any) =>
      String(step.uses).startsWith('actions/checkout@')
    );
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('pins every action it runs to a commit, and reads no secret but the URL and the key', () => {
    const actions = job.steps.filter((step: any) => step.uses);
    expect(actions).toHaveLength(2);
    for (const step of actions) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const text = fs.readFileSync(FILE, 'utf8');
    expect([...new Set(text.match(/secrets\.\w+/g))].sort()).toEqual([
      'secrets.EXPO_PUBLIC_SUPABASE_URL',
      'secrets.RECEIPT_SWEEP_SECRET_KEY',
    ]);
    // Every way of reading the secrets context names it: secrets.NAME,
    // secrets['NAME'], toJSON(secrets), `secrets: inherit`. The word is in
    // the file twice, in the Sweep step's two expressions, and nowhere else.
    expect(text.match(/\bsecrets\b/g)).toHaveLength(2);
  });

  it('runs these four steps and no other, each with only these settings', () => {
    // An action's commit is pinned above; here, which action, and what else
    // each step is given.
    expect(
      job.steps.map((step: any) => ({
        ...step,
        uses: step.uses?.replace(/@.*$/, ''),
      }))
    ).toEqual([
      { uses: 'actions/checkout', with: { 'persist-credentials': false } },
      {
        uses: 'actions/setup-node',
        with: { 'node-version': 22, cache: 'npm' },
      },
      { run: 'npm ci --ignore-scripts --no-audit --no-fund' },
      {
        name: 'Sweep',
        env: {
          RECEIPT_SWEEP_MODE:
            "${{ github.event_name == 'workflow_dispatch' && inputs.mode || vars.RECEIPT_SWEEP_MODE }}",
          SUPABASE_URL: '${{ secrets.EXPO_PUBLIC_SUPABASE_URL }}',
          RECEIPT_SWEEP_SECRET_KEY: '${{ secrets.RECEIPT_SWEEP_SECRET_KEY }}',
        },
        run: 'node scripts/sweep-receipts.js',
      },
    ]);
  });

  it("reads a weekly run's mode from the repository variable and a manual run's from its input", () => {
    expect(sweepStep.env.RECEIPT_SWEEP_MODE).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode || vars.RECEIPT_SWEEP_MODE }}"
    );
    expect(sweepStep.env.SUPABASE_URL).toBe(
      '${{ secrets.EXPO_PUBLIC_SUPABASE_URL }}'
    );
  });

  it('runs one sweep at a time, never cancelling one under way, and gives up after 15 minutes', () => {
    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}',
      'cancel-in-progress': false,
    });
    expect(job['timeout-minutes']).toBe(15);
  });
});

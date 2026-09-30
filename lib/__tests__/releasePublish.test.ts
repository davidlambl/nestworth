import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPublish } from '../../scripts/release/publish';
import { fakeIo } from '../testing/releaseFakes';

// The Publish release workflow's steps, run in the workflow's order against
// an in-memory origin that answers git and gh.

const V118 = 'a1b2c3d'.padEnd(40, '5');
const V119 = 'a0d8d03'.padEnd(40, '1');
const R = '904f8ac'.padEnd(40, '2'); // the squash commit of release/1.1.10
const N = 'abcdef0'.padEnd(40, '3'); // a later commit on main
const TIP = 'fedcba9'.padEnd(40, '4'); // release/1.1.10's own commit

type Run = {
  id: number;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
};

let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

// main: V118 (1.1.8) … V119 (1.1.9) … R (1.1.10, the release commit) … N.
function origin() {
  return {
    heads: { main: N, 'release/1.1.10': TIP } as Record<string, string>,
    tags: { 'v1.1.8': V118, 'v1.1.9': V119 } as Record<string, string>,
    versions: {
      [V118]: ['1.1.8', '1.1.7', '1.1.8'],
      [V119]: ['1.1.9', '1.1.8', '1.1.9'],
      [R]: ['1.1.10', '1.1.9', '1.1.10'],
      [N]: ['1.1.10', '1.1.10', '1.1.10'],
    } as Record<string, [string, string, string]>, // package, parent, app
    onMain: new Set([V118, V119, R, N]),
    trees: { [TIP]: 'tree-1.1.10', [R]: 'tree-1.1.10' } as Record<
      string,
      string
    >,
    firstParentLog: [R, V119, V118],
    tests: {} as Record<string, string>,
    testflightRuns: [] as Run[],
    releases: {} as Record<string, string>,
    apiIgnoresFilters: false,
    // git calls in the branch step that fail, keyed by their first words.
    failing: {} as Record<string, string>,
    tipMissingLocally: false,
    // A push to release/1.1.10 that lands after the step has read its tip.
    pushMidStep: '',
  };
}
type Origin = ReturnType<typeof origin>;

function connect(o: Origin) {
  let nextRun = 700;
  let tagging = '';
  return fakeIo(
    (command: string, args: string[]) => {
      const words = [command, ...args].join(' ');
      for (const [start, stderr] of Object.entries(o.failing)) {
        if (words.startsWith(start)) return { status: 128, stdout: '', stderr };
      }
      if (words.startsWith('git ls-remote --heads origin refs/heads/')) {
        const name = args[3].replace('refs/heads/', '');
        return o.heads[name] ? `${o.heads[name]}\t${args[3]}\n` : '';
      }
      if (words.startsWith('git cat-file -e ')) {
        return { status: o.tipMissingLocally ? 1 : 0, stdout: '', stderr: '' };
      }
      if (words === 'git ls-remote --heads --tags origin') {
        return [
          ...Object.entries(o.heads).map(
            ([name, sha]) => `${sha}\trefs/heads/${name}`
          ),
          ...Object.entries(o.tags).flatMap(([name, sha]) => [
            `${'9'.repeat(40)}\trefs/tags/${name}`,
            `${sha}\trefs/tags/${name}^{}`,
          ]),
        ].join('\n');
      }
      if (command === 'git' && args[0] === 'show') {
        const [, sha, parent, file] =
          /^([0-9a-f]{40})(\^?):(.+)$/.exec(args[1]) ?? [];
        const v = o.versions[sha];
        if (!v) return { status: 128, stdout: '', stderr: 'bad object' };
        if (file === 'app.json')
          return JSON.stringify({ expo: { version: v[2] } });
        return JSON.stringify({ version: parent ? v[1] : v[0] });
      }
      if (words.startsWith('git log -1 --format=%s ')) {
        return args[3] === R ? 'chore: release 1.1.10 (#170)' : 'a commit';
      }
      if (
        words ===
        'git log --first-parent --format=%H origin/main -- package.json'
      ) {
        return o.firstParentLog.join('\n');
      }
      if (words.startsWith('git merge-base --is-ancestor ')) {
        return {
          status: o.onMain.has(args[2]) ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
      if (command === 'git' && args.includes('--annotate')) {
        tagging = args[args.length - 1];
        return '';
      }
      if (words.startsWith('git push origin refs/tags/')) {
        o.tags[args[2].replace('refs/tags/', '')] = tagging;
        return '';
      }
      if (
        command === 'git' &&
        args[0] === 'push' &&
        args.includes('--delete')
      ) {
        const ref = args[args.length - 1];
        const name = ref.replace('refs/heads/', '');
        const lease = args.find((a) => a.startsWith('--force-with-lease='));
        if (lease && lease.split(':')[1] !== o.heads[name]) {
          return {
            status: 1,
            stdout: '',
            stderr: ` ! [rejected]        (delete) -> ${name} (stale info)\nerror: failed to push some refs to 'origin'`,
          };
        }
        delete o.heads[name];
        return '';
      }
      if (words.startsWith('git rev-parse ') && args[1].endsWith('^{tree}')) {
        if (o.pushMidStep) {
          o.heads['release/1.1.10'] = o.pushMidStep;
          o.pushMidStep = '';
        }
        return o.trees[args[1].replace('^{tree}', '')] ?? 'tree-other';
      }
      if (words.startsWith('gh release view ')) {
        const url = o.releases[args[2]];
        return url
          ? `${url}\n`
          : { status: 1, stdout: '', stderr: 'release not found' };
      }
      if (words.startsWith('gh release create ')) {
        o.releases[args[2]] =
          `https://github.com/davidlambl/nestworth/releases/tag/${args[2]}`;
        return `${o.releases[args[2]]}\n`;
      }
      return '';
    },
    (args: string[], body: unknown) => {
      const target = args[args.length - 1];
      if (target.includes('/test.yml/runs?')) {
        const sha = /head_sha=([0-9a-f]+)/.exec(target)?.[1] ?? '';
        return {
          workflow_runs: [
            {
              id: 1,
              head_sha: sha,
              event: 'push',
              head_branch: 'main',
              status: 'completed',
              conclusion: o.tests[sha] ?? 'success',
              created_at: '2026-09-30T08:00:00Z',
              html_url:
                'https://github.com/davidlambl/nestworth/actions/runs/1',
            },
          ],
        };
      }
      if (target.includes('/testflight.yml/runs?')) {
        const sha = /head_sha=([0-9a-f]+)/.exec(target)?.[1];
        const branch = /branch=([^&]+)/.exec(target)?.[1];
        return {
          workflow_runs: o.testflightRuns.filter(
            (r) =>
              o.apiIgnoresFilters ||
              (sha ? r.head_sha === sha : r.head_branch === branch)
          ),
        };
      }
      if (target.endsWith('/testflight.yml/dispatches')) {
        const { ref } = body as { ref: string };
        nextRun += 1;
        const run = {
          id: nextRun,
          head_sha: o.tags[ref],
          head_branch: ref,
          status: 'queued',
          conclusion: null,
          created_at: '2026-09-30T09:00:00Z',
          html_url: `https://github.com/davidlambl/nestworth/actions/runs/${nextRun}`,
        };
        o.testflightRuns.push(run);
        return { workflow_run_id: run.id, html_url: run.html_url };
      }
      return null;
    }
  );
}

const automatic = (over: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: 'davidlambl/nestworth',
  GITHUB_REF: 'refs/heads/main',
  RUNNER_TEMP: temp,
  EVENT_NAME: 'workflow_run',
  RUN_CONCLUSION: 'success',
  RUN_EVENT: 'push',
  RUN_HEAD_BRANCH: 'main',
  RUN_HEAD_SHA: R,
  TESTS_RUN_URL: 'https://github.com/davidlambl/nestworth/actions/runs/1',
  ...over,
});
const dispatch = (over: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: 'davidlambl/nestworth',
  GITHUB_REF: 'refs/heads/main',
  RUNNER_TEMP: temp,
  EVENT_NAME: 'workflow_dispatch',
  VERSION_INPUT: '1.1.10',
  TESTFLIGHT: 'true',
  DRY_RUN: 'false',
  ...over,
});

// The workflow: find, then the rest only when find says there is a release.
function publish(o: Origin, env: Record<string, string>) {
  const w = connect(o);
  const steps = createPublish({ env, io: w.io, cwd: temp });
  steps.find();
  if (w.outputs.release === 'true') {
    steps.tag();
    steps.testflight();
    steps.release();
    steps.branch();
  }
  return w;
}

type Io = ReturnType<typeof connect>;
const tagged = (w: Io) =>
  w.calls.some((c) => c[0] === 'git' && c.includes('--annotate'));
const pushed = (w: Io) => w.ran('git', 'push');
const dispatched = (w: Io) => w.calls.some((c) => c.includes('POST'));
const created = (w: Io) => w.ran('gh', 'release', 'create');
const deleted = (w: Io) =>
  w.calls.some(
    (c) => c[0] === 'git' && c[1] === 'push' && c.includes('--delete')
  );

describe('Publish release', () => {
  it('publishes a release commit: tag, TestFlight for the tag, the Release, the branch', () => {
    const o = origin();
    const w = publish(o, automatic());
    expect(w.calls).toContainEqual([
      'git',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag',
      '--annotate',
      'v1.1.10',
      '--message',
      'Release 1.1.10',
      R,
    ]);
    expect(w.calls).toContainEqual([
      'git',
      'push',
      'origin',
      'refs/tags/v1.1.10',
    ]);
    expect(w.calls).toContainEqual([
      'gh',
      'api',
      '--method',
      'POST',
      'repos/davidlambl/nestworth/actions/workflows/testflight.yml/dispatches',
      '{"ref":"v1.1.10","inputs":{"mode":"build-and-submit"},"return_run_details":true}',
    ]);
    expect(w.calls).toContainEqual([
      'gh',
      'release',
      'create',
      'v1.1.10',
      '--repo',
      'davidlambl/nestworth',
      '--verify-tag',
      '--title',
      'v1.1.10',
      '--generate-notes',
      '--notes-start-tag',
      'v1.1.9',
    ]);
    expect(w.calls).toContainEqual([
      'git',
      'push',
      `--force-with-lease=refs/heads/release/1.1.10:${TIP}`,
      'origin',
      '--delete',
      'refs/heads/release/1.1.10',
    ]);
    expect(w.text()).toContain(
      '- Branch: deleted `release/1.1.10`; it was exactly what was released.'
    );
    expect(w.text()).toContain('Next, on the Mac with the screen unlocked');
  });

  it('changes nothing when it runs again for the same commit', () => {
    const o = origin();
    publish(o, automatic());
    const again = publish(o, automatic());
    expect(
      tagged(again) || pushed(again) || dispatched(again) || created(again)
    ).toBe(false);
    expect(again.text()).toContain(
      'TestFlight: not dispatched: a TestFlight run for this commit is still queued'
    );
    expect(again.text()).not.toContain('Next, on the Mac');
    expect(again.text()).not.toMatch(/\.\.$/m);
  });

  it('a dry run never tags, pushes, dispatches, releases or deletes', () => {
    const o = origin();
    const w = publish(o, dispatch({ DRY_RUN: 'true' }));
    expect(w.outputs.release).toBe('true');
    expect(tagged(w) || pushed(w) || dispatched(w) || created(w)).toBe(false);
    const text = w.text();
    expect(text).toContain(
      '## Publish release v1.1.10: dry run, nothing changed'
    );
    expect(text).toContain('- Tag: would create `v1.1.10` at `904f8ac`.');
    expect(text).toContain(
      '- TestFlight: would dispatch `build-and-submit` for `v1.1.10`'
    );
    expect(text).toContain(
      '- GitHub Release: would create `v1.1.10`, notes generated since v1.1.9.'
    );
    expect(text).toContain(
      '- Branch: would delete `release/1.1.10`; it is exactly what was released.'
    );
  });

  it('counts only runs of this commit or this tag when deciding on TestFlight', () => {
    const o = origin();
    // A run of another commit, answered as if the API had ignored the filter.
    o.apiIgnoresFilters = true;
    o.testflightRuns.push({
      id: 5,
      head_sha: N,
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-29T09:00:00Z',
      html_url: 'https://github.com/davidlambl/nestworth/actions/runs/5',
    });
    expect(dispatched(publish(o, automatic()))).toBe(true);
  });

  it('never rebuilds a release that already built, even on a dispatch with testflight ticked', () => {
    const o = origin();
    o.testflightRuns.push({
      id: 36265014517,
      head_sha: V119,
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-28T20:00:00Z',
      html_url:
        'https://github.com/davidlambl/nestworth/actions/runs/36265014517',
    });
    // A backfill of v1.1.9's Release after v1.1.10 is out, testflight left
    // ticked: nothing is rebuilt, and the Release does not take Latest.
    o.tags['v1.1.10'] = R;
    const w = publish(o, dispatch({ VERSION_INPUT: '1.1.9' }));
    expect(dispatched(w)).toBe(false);
    expect(w.text()).toContain(
      'TestFlight: not dispatched: TestFlight already built this commit'
    );
    expect(w.calls).toContainEqual([
      'gh',
      'release',
      'create',
      'v1.1.9',
      '--repo',
      'davidlambl/nestworth',
      '--verify-tag',
      '--title',
      'v1.1.9',
      '--generate-notes',
      '--notes-start-tag',
      'v1.1.8',
      '--latest=false',
    ]);
  });

  it('dispatched for an untagged version that a revert brought back, finds its genuine release commit', () => {
    // The reviewer's repro: 1.2.1 released at 6c6bc49 but never tagged, 1.2.2
    // released and tagged, then 1.2.2's bump reverted at 0477103. Before, the
    // search found the revert and refused it as a downgrade.
    const V120 = '971a355'.padEnd(40, '7');
    const BUMP = '6c6bc49'.padEnd(40, '8');
    const V122 = 'bb22222'.padEnd(40, '9');
    const REVERT = '0477103'.padEnd(40, 'a');
    const o = origin();
    o.heads.main = REVERT;
    o.tags = { 'v1.2.0': V120, 'v1.2.2': V122 };
    o.versions = {
      [V120]: ['1.2.0', '1.1.9', '1.2.0'],
      [BUMP]: ['1.2.1', '1.2.0', '1.2.1'],
      [V122]: ['1.2.2', '1.2.1', '1.2.2'],
      [REVERT]: ['1.2.1', '1.2.2', '1.2.1'],
    };
    o.onMain = new Set([V120, BUMP, V122, REVERT]);
    o.firstParentLog = [REVERT, V122, BUMP, V120];
    const w = publish(o, dispatch({ VERSION_INPUT: '1.2.1', DRY_RUN: 'true' }));
    expect(w.outputs.release).toBe('true');
    expect(w.text()).toContain('Release commit `6c6bc49`');
    expect(w.text()).toContain('- Tag: would create `v1.2.1` at `6c6bc49`.');
    // Not marked Latest: v1.2.2 is newer.
    expect(w.text()).toContain('not marked Latest (v1.2.2 is newer)');
  });

  it('refuses a dispatch for a tag that is not on main', () => {
    const o = origin();
    o.onMain.delete(V119);
    const w = connect(o);
    expect(() =>
      createPublish({
        env: dispatch({ VERSION_INPUT: '1.1.9' }),
        io: w.io,
        cwd: temp,
      }).find()
    ).toThrow('v1.1.9 points at a0d8d03, which is not on main.');
  });

  it('refuses a dispatch run off main', () => {
    const w = connect(origin());
    expect(() =>
      createPublish({
        env: dispatch({ GITHUB_REF: 'refs/heads/feat' }),
        io: w.io,
        cwd: temp,
      }).find()
    ).toThrow(
      'Publish release is dispatched from main only; this run is on refs/heads/feat.'
    );
  });

  it('keeps a release branch that holds more than was released', () => {
    const o = origin();
    o.trees[TIP] = 'tree-with-an-extra-commit';
    const w = publish(o, automatic());
    expect(deleted(w)).toBe(false);
    expect(o.heads['release/1.1.10']).toBe(TIP);
    expect(w.text()).toContain(
      `- Branch: \`release/1.1.10\` (at \`fedcba9\`) is not exactly what was released; left as it is.`
    );
  });

  it('keeps a same-named branch that is on main but is not the release', () => {
    // release/1.1.10 pointing at an older main commit: on main, but its tree
    // is not the release commit's, so it is not the merged release branch.
    const o = origin();
    o.heads['release/1.1.10'] = V119;
    o.trees[V119] = 'tree-1.1.9';
    const w = publish(o, automatic());
    expect(deleted(w)).toBe(false);
    expect(o.heads['release/1.1.10']).toBe(V119);
  });

  it('keeps the branch when a push lands between the check and the delete', () => {
    const o = origin();
    const LATER = '1a2b3c4'.padEnd(40, '6');
    o.pushMidStep = LATER;
    const w = publish(o, automatic());
    expect(o.heads['release/1.1.10']).toBe(LATER);
    expect(w.annotations).toContainEqual([
      'warning',
      expect.stringContaining(
        'release/1.1.10 was left on origin: origin refused the deletion'
      ),
    ]);
    expect(w.text()).toContain('(stale info)');
  });

  it.each([
    ['git ls-remote --heads origin', 'listing origin failed', false],
    ['git fetch', 'fetching it failed', true],
    ['git rev-parse', 'reading the trees failed', false],
    ['git push --force-with-lease', 'origin refused the deletion', false],
  ] as const)(
    'a failing `%s` in the branch step is a warning with its reason, after the release is out',
    (failing, reason, tipMissingLocally) => {
      const o = origin();
      o.tipMissingLocally = tipMissingLocally;
      o.failing[failing] = `fatal: ${failing} went wrong`;
      const w = publish(o, automatic());
      // The run stays green (publish returned), the release is out, and the
      // summary gives the reason and still the desktop step.
      expect(created(w)).toBe(true);
      expect(w.annotations).toContainEqual([
        'warning',
        `release/1.1.10 was left on origin: ${reason} (fatal: ${failing} went wrong).`,
      ]);
      expect(w.text()).toContain(
        `- Branch: \`release/1.1.10\` left as it is: ${reason} (fatal: ${failing} went wrong).`
      );
      expect(w.text()).toContain('Next, on the Mac with the screen unlocked');
      expect(o.heads['release/1.1.10']).toBe(TIP);
    }
  );

  it('exits quietly for a commit that is not a release', () => {
    const w = publish(origin(), automatic({ RUN_HEAD_SHA: N }));
    expect(w.outputs.release).toBe('false');
    expect(w.summary).toEqual([]);
    expect(w.ran('gh')).toBe(false);
  });
});

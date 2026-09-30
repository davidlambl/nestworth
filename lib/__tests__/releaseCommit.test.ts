import {
  checkBumpDiff,
  findReleaseCommit,
  releaseCommit,
  tagDecision,
  testflightDecision,
  workflowRunDecision,
} from '../../scripts/release/commit';

const SHA = 'e'.repeat(40);
const ELSEWHERE = '9'.repeat(40);

const pkg = (version: string) =>
  JSON.stringify({ name: 'nestworth', version }, null, 2);
const app = (version: string) =>
  JSON.stringify({ expo: { name: 'Nestworth', version } }, null, 2);

describe('checkBumpDiff', () => {
  const BUMP = '1\t1\tapp.json\n2\t2\tpackage-lock.json\n1\t1\tpackage.json';
  const STAGED = 'M  app.json\nM  package-lock.json\nM  package.json';

  it('passes exactly what npm version and the hook change', () => {
    expect(() =>
      checkBumpDiff({ numstat: BUMP, status: STAGED })
    ).not.toThrow();
  });

  it('refuses a lockfile that npm rewrote', () => {
    expect(() =>
      checkBumpDiff({
        numstat: BUMP.replace('2\t2\tpackage-lock', '40\t38\tpackage-lock'),
        status: STAGED,
      })
    ).toThrow('package-lock.json changes 40 added/38 removed lines, not 2/2');
  });

  it('refuses a missing file and an extra one', () => {
    expect(() =>
      checkBumpDiff({
        numstat: '2\t2\tpackage-lock.json\n1\t1\tpackage.json\n3\t0\tREADME.md',
        status: STAGED,
      })
    ).toThrow('app.json did not change; README.md changed too');
  });

  it('refuses anything else left in the checkout', () => {
    expect(() =>
      checkBumpDiff({ numstat: BUMP, status: `${STAGED}\n?? notes.txt` })
    ).toThrow('the checkout also has "?? notes.txt"');
    expect(() =>
      checkBumpDiff({
        numstat: BUMP,
        status: 'MM app.json\nM  package-lock.json\nM  package.json',
      })
    ).toThrow('the checkout also has "MM app.json"');
  });
});

describe('workflowRunDecision', () => {
  it('acts on a green Tests run of a push to main', () => {
    expect(
      workflowRunDecision({
        conclusion: 'success',
        event: 'push',
        headBranch: 'main',
      }).act
    ).toBe(true);
  });

  it("ignores a fork's pull request whose head branch is also called main", () => {
    expect(
      workflowRunDecision({
        conclusion: 'success',
        event: 'pull_request',
        headBranch: 'main',
      })
    ).toEqual({
      act: false,
      reason: 'the Tests run was a pull_request on main, not a push to main',
    });
  });

  it('ignores a run that was not green', () => {
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      expect(
        workflowRunDecision({ conclusion, event: 'push', headBranch: 'main' })
          .act
      ).toBe(false);
    }
  });
});

describe('releaseCommit', () => {
  it('is a release commit when package.json moves and app.json agrees', () => {
    expect(
      releaseCommit({
        packageJson: pkg('1.1.10'),
        parentPackageJson: pkg('1.1.9'),
        appJson: app('1.1.10'),
      })
    ).toEqual({ release: true, version: '1.1.10', previous: '1.1.9' });
  });

  it('is not one when the version stays', () => {
    expect(
      releaseCommit({
        packageJson: pkg('1.1.9'),
        parentPackageJson: pkg('1.1.9'),
        appJson: app('1.1.9'),
      })
    ).toEqual({ release: false, reason: 'package.json stays at 1.1.9' });
  });

  it('fails loudly when app.json does not carry the new version', () => {
    expect(() =>
      releaseCommit({
        packageJson: pkg('1.1.10'),
        parentPackageJson: pkg('1.1.9'),
        appJson: app('1.1.9'),
      })
    ).toThrow(
      "package.json moves to 1.1.10 but app.json's expo.version is 1.1.9"
    );
  });

  it('never publishes a version that moves backward', () => {
    const verdict = releaseCommit({
      packageJson: pkg('1.1.9'),
      parentPackageJson: pkg('1.1.10'),
      appJson: app('1.1.9'),
    });
    expect(verdict.release).toBe(false);
    expect(verdict.warning).toBe(true);
    expect(verdict.reason).toContain('moves backward, 1.1.10 to 1.1.9');
  });

  it('fails on a version that is not X.Y.Z, and on unreadable JSON', () => {
    expect(() =>
      releaseCommit({
        packageJson: pkg('1.2.0-beta.1'),
        parentPackageJson: pkg('1.1.9'),
        appJson: app('1.2.0-beta.1'),
      })
    ).toThrow('which is not an X.Y.Z version');
    expect(() =>
      releaseCommit({
        packageJson: '{',
        parentPackageJson: pkg('1.1.9'),
        appJson: app('1.1.9'),
      })
    ).toThrow('package.json is not valid JSON');
  });

  it('is not one for a commit without a parent', () => {
    expect(
      releaseCommit({
        packageJson: pkg('1.0.0'),
        parentPackageJson: null,
        appJson: app('1.0.0'),
      }).release
    ).toBe(false);
  });
});

describe('findReleaseCommit', () => {
  const history = [
    { sha: 'c3', version: '1.1.10', parentVersion: '1.1.10' },
    { sha: 'c2', version: '1.1.10', parentVersion: '1.1.9' },
    { sha: 'c1', version: '1.1.9', parentVersion: '1.1.8' },
  ];

  it('finds the commit that moved package.json to the version', () => {
    expect(findReleaseCommit(history, '1.1.10')?.sha).toBe('c2');
    expect(findReleaseCommit(history, '1.1.9')?.sha).toBe('c1');
    expect(findReleaseCommit(history, '1.2.0')).toBeNull();
  });

  it('takes the newest such commit when the version was bumped twice', () => {
    // 1.1.10 bumped, reverted, bumped again: the last bump is the release.
    const rebumped = [
      { sha: 'c5', version: '1.1.10', parentVersion: '1.1.9' },
      { sha: 'c4', version: '1.1.9', parentVersion: '1.1.10' },
      ...history.slice(1),
    ];
    expect(findReleaseCommit(rebumped, '1.1.10')?.sha).toBe('c5');
    // c4 moved the version DOWN to 1.1.9: a revert, not 1.1.9's release.
    expect(findReleaseCommit(rebumped, '1.1.9')?.sha).toBe('c1');
  });

  it('passes over the revert of a later release, back to an untagged version', () => {
    // 1.2.1 released (never tagged), a feature, 1.2.2 released, then 1.2.2's
    // bump reverted: main is back at 1.2.1, and 1.2.1's release commit is
    // still the bump, not the revert.
    const history = [
      { sha: 'revert', version: '1.2.1', parentVersion: '1.2.2' },
      { sha: 'bump-1.2.2', version: '1.2.2', parentVersion: '1.2.1' },
      { sha: 'feature', version: '1.2.1', parentVersion: '1.2.1' },
      { sha: 'bump-1.2.1', version: '1.2.1', parentVersion: '1.2.0' },
    ];
    expect(findReleaseCommit(history, '1.2.1')?.sha).toBe('bump-1.2.1');
    expect(findReleaseCommit(history.slice(0, 1), '1.2.1')).toBeNull();
  });
});

describe('tagDecision', () => {
  it('creates a missing tag and leaves one at the release commit alone', () => {
    expect(tagDecision({ tag: 'v1.1.10', sha: SHA, tagCommit: null })).toEqual({
      action: 'create',
    });
    expect(tagDecision({ tag: 'v1.1.10', sha: SHA, tagCommit: SHA })).toEqual({
      action: 'exists',
    });
  });

  it('fails when the tag is somewhere else', () => {
    expect(() =>
      tagDecision({ tag: 'v1.1.10', sha: SHA, tagCommit: ELSEWHERE })
    ).toThrow(
      'v1.1.10 already exists on origin at 9999999, not at the release commit eeeeeee'
    );
  });
});

describe('testflightDecision', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 7,
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-30T10:00:00Z',
    html_url: 'https://github.com/davidlambl/nestworth/actions/runs/7',
    ...over,
  });

  it('dispatches on the first automatic publish of a release commit', () => {
    expect(
      testflightDecision({ event: 'workflow_run', testflight: true, runs: [] })
    ).toEqual({
      dispatch: true,
      reason: 'the first publish of this release commit',
    });
  });

  it('never dispatches automatically once any build of the commit has started', () => {
    for (const [earlier, reason] of [
      [run(), 'TestFlight already built this commit'],
      [
        run({ conclusion: 'failure' }),
        'TestFlight already ran for this commit and ended "failure"',
      ],
      [
        run({ status: 'in_progress', conclusion: null }),
        'a TestFlight run for this commit is still in progress',
      ],
    ] as const) {
      const decision = testflightDecision({
        event: 'workflow_run',
        testflight: true,
        runs: [earlier],
      });
      expect(decision.dispatch).toBe(false);
      expect(decision.reason).toContain(reason);
    }
  });

  it('never rebuilds on a manual request once a build of the commit succeeded', () => {
    // v1.1.9's own TestFlight run: dispatched from main at the tag's commit.
    const v119 = run({
      id: 36265014517,
      head_branch: 'main',
      html_url:
        'https://github.com/davidlambl/nestworth/actions/runs/36265014517',
    });
    expect(
      testflightDecision({
        event: 'workflow_dispatch',
        testflight: true,
        runs: [v119],
      })
    ).toEqual({
      dispatch: false,
      reason:
        'TestFlight already built this commit: https://github.com/davidlambl/nestworth/actions/runs/36265014517; ' +
        'to build it again on purpose, run TestFlight from the tag',
    });
    // v1.1.6's shape: a cancelled build-and-submit, then a submit that worked.
    expect(
      testflightDecision({
        event: 'workflow_dispatch',
        testflight: true,
        runs: [
          run({
            id: 1,
            conclusion: 'cancelled',
            created_at: '2026-09-24T10:00:00Z',
          }),
          run({ id: 2, created_at: '2026-09-24T12:00:00Z' }),
        ],
      }).dispatch
    ).toBe(false);
  });

  it('retries a failed or cancelled build on a manual request', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
      expect(
        testflightDecision({
          event: 'workflow_dispatch',
          testflight: true,
          runs: [run({ conclusion })],
        })
      ).toEqual({ dispatch: true, reason: 'requested (testflight=true)' });
    }
    expect(
      testflightDecision({
        event: 'workflow_dispatch',
        testflight: false,
        runs: [],
      })
    ).toEqual({ dispatch: false, reason: 'not requested (testflight=false)' });
  });

  it('does not start a second build while one of the commit is running', () => {
    const decision = testflightDecision({
      event: 'workflow_dispatch',
      testflight: true,
      runs: [run({ status: 'queued', conclusion: null })],
    });
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toContain('is still queued');
  });

  it('gives reasons without a final full stop, for the summary to add one', () => {
    for (const event of ['workflow_run', 'workflow_dispatch']) {
      for (const runs of [
        [],
        [run()],
        [run({ conclusion: 'failure' })],
        [run({ status: 'queued', conclusion: null })],
      ]) {
        const { reason } = testflightDecision({
          event,
          testflight: true,
          runs,
        });
        expect(reason.endsWith('.')).toBe(false);
      }
    }
  });
});

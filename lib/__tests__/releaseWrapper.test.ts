import fs from 'fs';
import os from 'os';
import path from 'path';

import { runRelease } from '../../scripts/release';
import { fakeIo } from '../testing/releaseFakes';

// `npm run release`, driven with a recording fake for gh and git: the
// dispatch, following that run, the artifact, and the pull request.

let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-wrapper-'));
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

type Options = {
  dryRun?: boolean;
  runDetails?: boolean;
  watchStatus?: number;
  downloadStatus?: number;
  prStatus?: number;
};

// gh as GitHub would answer: the dispatch makes run 42 (with its details
// unless runDetails is false), and the run's artifact is what the Release
// workflow uploads.
function github({
  dryRun = false,
  runDetails = true,
  watchStatus = 0,
  downloadStatus = 0,
  prStatus = 0,
}: Options = {}) {
  let dispatchedYet = false;
  const w = fakeIo(
    (command: string, args: string[]) => {
      const words = [command, ...args].join(' ');
      if (words === 'git remote get-url origin') {
        return 'https://github.com/davidlambl/nestworth.git\n';
      }
      if (words.startsWith('gh run watch 42 ')) {
        return { status: watchStatus, stdout: '', stderr: '' };
      }
      if (words.startsWith('gh run download 42 ')) {
        if (downloadStatus !== 0) {
          return {
            status: downloadStatus,
            stdout: '',
            stderr: 'no artifact matches',
          };
        }
        const dir = args[args.indexOf('--dir') + 1];
        fs.writeFileSync(
          path.join(dir, 'release.json'),
          JSON.stringify({
            version: '1.1.10',
            tag: 'v1.1.10',
            branch: 'release/1.1.10',
            title: 'chore: release 1.1.10',
            dryRun,
            compareUrl:
              'https://github.com/davidlambl/nestworth/compare/main...release/1.1.10?quick_pull=1&title=chore%3A%20release%201.1.10',
          })
        );
        fs.writeFileSync(path.join(dir, 'pr-body.md'), '## Release 1.1.10\n');
        return '';
      }
      if (words.startsWith('gh pr create ')) {
        return prStatus === 0
          ? 'https://github.com/davidlambl/nestworth/pull/170\n'
          : {
              status: prStatus,
              stdout: '',
              stderr: 'GraphQL: something went wrong',
            };
      }
      return '';
    },
    (args: string[]) => {
      const target = args[args.length - 1];
      if (target.endsWith('/release.yml/dispatches')) {
        dispatchedYet = true;
        return runDetails
          ? {
              workflow_run_id: 42,
              html_url:
                'https://github.com/davidlambl/nestworth/actions/runs/42',
            }
          : null;
      }
      if (target.includes('/release.yml/runs?')) {
        return {
          workflow_runs: dispatchedYet
            ? [{ id: 42 }, { id: 17 }]
            : [{ id: 17 }],
        };
      }
      return null;
    }
  );
  return w;
}

const logs: string[] = [];
const release = (w: ReturnType<typeof github>, argv: string[], env = {}) =>
  runRelease({
    argv,
    env,
    io: w.io,
    tmpdir: temp,
    sleep: async () => {},
    log: (line: string) => {
      logs.push(line);
    },
  });

beforeEach(() => {
  logs.length = 0;
});

describe('npm run release', () => {
  it('dispatches the Release workflow on main and follows the run it started', async () => {
    const w = github();
    await release(w, ['patch']);
    expect(w.calls).toContainEqual([
      'gh',
      'api',
      '--method',
      'POST',
      'repos/davidlambl/nestworth/actions/workflows/release.yml/dispatches',
      '{"ref":"main","inputs":{"version":"patch","dry_run":"false"},"return_run_details":true}',
    ]);
    expect(w.ran('gh', 'run', 'watch', '42')).toBe(true);
    expect(w.ran('gh', 'run', 'download', '42')).toBe(true);
  });

  it("opens the pull request with the owner's gh and the body the run wrote", async () => {
    const w = github();
    await release(w, ['patch']);
    const pr = w.calls.find((c) => c[0] === 'gh' && c[1] === 'pr');
    expect(pr?.slice(0, 11)).toEqual([
      'gh',
      'pr',
      'create',
      '--repo',
      'davidlambl/nestworth',
      '--base',
      'main',
      '--head',
      'release/1.1.10',
      '--title',
      'chore: release 1.1.10',
    ]);
    expect(pr?.[12]).toMatch(/nestworth-release-.+\/pr-body\.md$/);
    expect(logs.join('\n')).toContain(
      'Opened https://github.com/davidlambl/nestworth/pull/170'
    );
  });

  it('never opens a pull request for a dry run, including one npm swallowed', async () => {
    for (const [argv, env] of [
      [['patch', '--dry-run'], {}],
      [['patch'], { npm_config_dry_run: 'true' }],
    ] as const) {
      const w = github({ dryRun: true });
      await release(w, [...argv], env);
      expect(w.calls).toContainEqual(
        expect.arrayContaining([
          '{"ref":"main","inputs":{"version":"patch","dry_run":"true"},"return_run_details":true}',
        ])
      );
      expect(w.ran('gh', 'pr')).toBe(false);
    }
    expect(logs.join('\n')).toContain('Dry run: nothing was pushed.');
  });

  it('finds the new run by listing when the dispatch answers without it', async () => {
    const w = github({ runDetails: false });
    await release(w, ['minor']);
    expect(w.ran('gh', 'run', 'watch', '42')).toBe(true);
  });

  it('stops at a failed run, before downloading anything', async () => {
    const w = github({ watchStatus: 1 });
    await expect(release(w, ['patch'])).rejects.toThrow(
      'The Release run did not succeed: https://github.com/davidlambl/nestworth/actions/runs/42.'
    );
    expect(w.ran('gh', 'run', 'download')).toBe(false);
  });

  it('says how to open the pull request by hand when gh could not', async () => {
    const w = github({ prStatus: 1 });
    await expect(release(w, ['patch'])).rejects.toThrow(
      /release\/1\.1\.10 is pushed, but the pull request did not open \(GraphQL: something went wrong\)\. Open it with the link from the run's summary:\n {2}https:\/\/github\.com\/davidlambl\/nestworth\/compare\/main\.\.\.release\/1\.1\.10\?quick_pull=1&title=chore%3A%20release%201\.1\.10\nor run:\n {2}gh pr create --repo davidlambl\/nestworth --base main --head release\/1\.1\.10 --title 'chore: release 1\.1\.10' --body-file \S+\/pr-body\.md/
    );
  });

  it("points at the run's summary when the artifact does not download", async () => {
    const w = github({ downloadStatus: 1 });
    await expect(release(w, ['patch'])).rejects.toThrow(
      "its branch is pushed: open the pull request from the link in the run's summary, https://github.com/davidlambl/nestworth/actions/runs/42"
    );
  });
});

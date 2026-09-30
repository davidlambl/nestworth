import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrepare } from '../../scripts/release/prepare';
import { fakeIo, type RunOptions } from '../testing/releaseFakes';

// The Release workflow's steps, driven against a temporary checkout with a
// recording fake in place of git, npm and gh.

const MAIN = '6211479'.padEnd(40, '0');
const COMMIT = 'c'.repeat(40);
const V119 = 'a0d8d03'.padEnd(40, '1');
const LS_REMOTE = [
  `${MAIN}\trefs/heads/main`,
  `${'e'.repeat(40)}\trefs/tags/v1.1.8`,
  `${'e'.repeat(39)}f\trefs/tags/v1.1.8^{}`,
  `${'d'.repeat(40)}\trefs/tags/v1.1.9`,
  `${V119}\trefs/tags/v1.1.9^{}`,
].join('\n');
const STAGED = 'M  app.json\nM  package-lock.json\nM  package.json';

let cwd: string;
let temp: string;

const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(path.join(cwd, file), `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prepare-'));
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prepare-temp-'));
  writeJson('package.json', { name: 'nestworth', version: '1.1.9' });
  writeJson('app.json', { expo: { name: 'Nestworth', version: '1.1.9' } });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(temp, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: 'davidlambl/nestworth',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '42',
  GITHUB_REF: 'refs/heads/main',
  RUNNER_TEMP: temp,
  VERSION_INPUT: 'patch',
  DRY_RUN: 'false',
  ...over,
});

// git, npm and gh as a clean checkout of main at 1.1.9 would answer. `dirty`
// makes the first `git status` report a stray change; `hook: false` makes
// `npm version` leave app.json alone, as under ignore-scripts.
function world({ dirty = false, hook = true } = {}) {
  let bumped = false;
  let committed = false;
  return fakeIo(
    (command: string, args: string[], options: RunOptions) => {
      const words = [command, ...args].join(' ');
      if (words === 'git ls-remote --heads --tags origin') return LS_REMOTE;
      if (words === 'git status --porcelain') {
        if (bumped) return STAGED;
        return dirty ? ' M README.md' : '';
      }
      if (words === 'git rev-parse HEAD') return committed ? COMMIT : MAIN;
      if (words === 'npm version patch --no-git-tag-version') {
        bumped = true;
        const dir = options.cwd ?? '';
        const write = (file: string, edit: (j: any) => void) => {
          const json = JSON.parse(
            fs.readFileSync(path.join(dir, file), 'utf8')
          );
          edit(json);
          fs.writeFileSync(path.join(dir, file), JSON.stringify(json));
        };
        write('package.json', (p) => {
          p.version = '1.1.10';
        });
        if (hook) {
          write('app.json', (a) => {
            a.expo.version = '1.1.10';
          });
        }
        return '';
      }
      if (words === 'node scripts/sync-app-version.js') {
        const file = path.join(options.cwd ?? '', 'app.json');
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        json.expo.version = '1.1.10';
        fs.writeFileSync(file, JSON.stringify(json));
        return '';
      }
      if (words === 'git diff --cached --numstat') {
        return '1\t1\tapp.json\n2\t2\tpackage-lock.json\n1\t1\tpackage.json';
      }
      if (args.includes('commit')) {
        committed = true;
        return '';
      }
      return '';
    },
    (args: string[]) => {
      if (args[0].includes('/actions/workflows/test.yml/runs')) {
        return {
          workflow_runs: [
            {
              id: 9,
              head_sha: MAIN,
              event: 'push',
              head_branch: 'main',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-09-30T08:00:00Z',
              html_url:
                'https://github.com/davidlambl/nestworth/actions/runs/9',
            },
          ],
        };
      }
      if (args.includes('repos/davidlambl/nestworth/releases/generate-notes')) {
        return {
          name: 'v1.1.10',
          body: "## What's Changed\n* fix: a thing (#158)\n\n**Full Changelog**: https://github.com/davidlambl/nestworth/compare/v1.1.9...v1.1.10",
        };
      }
      return null;
    }
  );
}

describe('the Release steps', () => {
  it('validate refuses a run on any ref but main, and a bad version', () => {
    const w = world();
    expect(() =>
      createPrepare({
        env: env({ GITHUB_REF: 'refs/heads/feat' }),
        io: w.io,
        cwd,
      }).validate()
    ).toThrow(
      'A release is prepared from main only; this run is on refs/heads/feat.'
    );
    expect(() =>
      createPrepare({
        env: env({ VERSION_INPUT: 'v1.2.0' }),
        io: w.io,
        cwd,
      }).validate()
    ).toThrow('without the "v"');
  });

  it('ci refuses a commit whose Tests run is not green', () => {
    const w = fakeIo(
      () => MAIN,
      () => ({
        workflow_runs: [
          {
            id: 9,
            head_sha: MAIN,
            event: 'push',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'failure',
            created_at: '2026-09-30T08:00:00Z',
            html_url: 'https://github.com/davidlambl/nestworth/actions/runs/9',
          },
        ],
      })
    );
    expect(() => createPrepare({ env: env(), io: w.io, cwd }).ci()).toThrow(
      'ended "failure"'
    );
  });

  it('bump refuses a checkout that is not clean, before npm runs', () => {
    const w = world({ dirty: true });
    expect(() => createPrepare({ env: env(), io: w.io, cwd }).bump()).toThrow(
      'The checkout is not clean: M README.md'
    );
    expect(w.ran('npm')).toBe(false);
    expect(w.ran('git', 'switch')).toBe(false);
  });

  it('bump commits exactly the version change, as the bot, on release/X.Y.Z', () => {
    const w = world();
    createPrepare({ env: env(), io: w.io, cwd }).bump();
    expect(w.calls).toContainEqual([
      'git',
      'switch',
      '--create',
      'release/1.1.10',
    ]);
    expect(w.calls).toContainEqual([
      'git',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '--quiet',
      '--message',
      'chore: release 1.1.10',
      '--message',
      'Prepared by the Release workflow (`patch`): https://github.com/davidlambl/nestworth/actions/runs/42',
    ]);
    const state = JSON.parse(
      fs.readFileSync(path.join(temp, 'release-pr', 'release.json'), 'utf8')
    );
    expect(state).toMatchObject({
      version: '1.1.10',
      branch: 'release/1.1.10',
      baseSha: MAIN,
      commitSha: COMMIT,
      previousTag: 'v1.1.9',
      previousTagSha: V119,
      dryRun: false,
    });
  });

  it('bump runs the version hook itself when npm skipped it', () => {
    const w = world({ hook: false });
    createPrepare({ env: env(), io: w.io, cwd }).bump();
    expect(w.ran('node', 'scripts/sync-app-version.js')).toBe(true);
    expect(readJson('app.json').expo.version).toBe('1.1.10');
  });

  it('a dry run is never pushed, even if the workflow ran the push step', () => {
    const w = world();
    const steps = createPrepare({
      env: env({ DRY_RUN: 'true' }),
      io: w.io,
      cwd,
    });
    steps.bump();
    steps.body();
    steps.push();
    steps.summary();
    expect(w.ran('git', 'push')).toBe(false);
    expect(w.text()).toContain('## Release 1.1.10: dry run, nothing pushed');
  });

  it('a real run pushes exactly the release branch, and links its pull request', () => {
    const w = world();
    const steps = createPrepare({ env: env(), io: w.io, cwd });
    steps.bump();
    steps.body();
    steps.push();
    steps.summary();
    expect(w.calls.filter((c) => c[0] === 'git' && c[1] === 'push')).toEqual([
      [
        'git',
        'push',
        'origin',
        'refs/heads/release/1.1.10:refs/heads/release/1.1.10',
      ],
    ]);
    const body = fs.readFileSync(
      path.join(temp, 'release-pr', 'pr-body.md'),
      'utf8'
    );
    expect(body).toContain('### Changes since v1.1.9 (`a0d8d03`)');
    expect(w.text()).toContain(
      '**[Open the pull request](https://github.com/davidlambl/nestworth/compare/main...release/1.1.10?quick_pull=1&title=chore%3A%20release%201.1.10&body='
    );
  });
});

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { releaseDesktop } from '../../scripts/release-desktop';
import { fakeIo, type RunOptions } from '../testing/releaseFakes';

// `npm run release:desktop`, driven with fakes for git, npm and the macOS
// tools, in temporary directories standing in for the checkout, $HOME and
// $TMPDIR. The build writes a real file, so the copy and its hash are real.

const TAGGED = '904f8ac'.padEnd(40, '2'); // v1.1.10
const V119 = 'a0d8d03'.padEnd(40, '1'); // v1.1.9
const RELEASE = '971a355'.padEnd(40, '3'); // 1.2.0, merged, not tagged yet
const IOREG_UNLOCKED =
  '    |   "IOConsoleLocked" = No\n' +
  '    |   "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes})\n';
const NOTARIZED =
  'Nestworth.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: David Lambl (P9KK9LA3ZV)\n';

let root: string;
let home: string;
let tmp: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-desktop-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'release-desktop-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-desktop-tmp-'));
  fs.writeFileSync(
    path.join(root, '.env.local'),
    'EXPO_PUBLIC_SUPABASE_URL=x\n'
  );
});

afterEach(() => {
  for (const dir of [root, home, tmp]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dest = (version = '1.1.10') =>
  path.join(home, 'nestworth-builds', `Nestworth-${version}-arm64.dmg`);

type Mac = {
  ioreg?: string;
  spctl?: string;
  notarytool?: number;
  // origin's tags, and main's first-parent package.json history, newest
  // first, as [commit, version, parent's version].
  tags?: Record<string, string>;
  main?: [string, string, string][];
  // The version the stub build produces.
  building?: string;
  // A local tag that differs from origin's: git refuses a `--tags` fetch.
  localTagConflict?: boolean;
  // Commits origin has that this clone does not (until their tag is fetched).
  notLocal?: string[];
};

// The Mac and origin as they would answer. When the worktree is removed, it
// records whether the filed copy existed then and matched the built dmg.
function mac({
  ioreg = IOREG_UNLOCKED,
  spctl = NOTARIZED,
  notarytool = 0,
  tags = { 'v1.1.10': TAGGED },
  main = [[TAGGED, '1.1.10', '1.1.9']],
  building = '1.1.10',
  localTagConflict = false,
  notLocal = [],
}: Mac = {}) {
  const missing = new Set(notLocal);
  const seen = {
    worktree: '',
    removedAfterVerifiedCopy: null as boolean | null,
    childEnvs: [] as (Record<string, string | undefined> | undefined)[],
  };
  const w = fakeIo((command: string, args: string[], options: RunOptions) => {
    const words = [command, ...args].join(' ');
    if (words === 'git rev-parse --show-toplevel') return `${root}\n`;
    if (command === 'git' && args[0] === 'fetch') {
      if (args.includes('--tags') && localTagConflict) {
        return {
          status: 1,
          stdout: '',
          stderr:
            ' ! [rejected]        v1.1.10    -> v1.1.10  (would clobber existing tag)',
        };
      }
      const tagRef = args.find((a) => a.startsWith('refs/tags/'));
      if (tagRef) missing.delete(tags[tagRef.replace('refs/tags/', '')]);
      return '';
    }
    if (words.startsWith('git cat-file -e ')) {
      const commit = args[2].replace('^{commit}', '');
      return { status: missing.has(commit) ? 1 : 0, stdout: '', stderr: '' };
    }
    if (words === 'git ls-remote --tags origin') {
      return Object.entries(tags)
        .map(
          ([tag, sha]) =>
            `${'9'.repeat(40)}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}\n`
        )
        .join('');
    }
    if (words === 'git show origin/main:package.json') {
      return JSON.stringify({ version: main[0][1] });
    }
    if (
      words === 'git log --first-parent --format=%H origin/main -- package.json'
    ) {
      return main.map(([commit]) => commit).join('\n');
    }
    if (command === 'git' && args[0] === 'show') {
      const [, commit, parent] =
        /^([0-9a-f]{40})(\^?):package\.json$/.exec(args[1]) ?? [];
      const row = main.find(([c]) => c === commit);
      if (!row) return { status: 128, stdout: '', stderr: 'bad object' };
      return JSON.stringify({ version: parent ? row[2] : row[1] });
    }
    if (words === 'ioreg -n Root -d1') return ioreg;
    if (words.startsWith('xcrun notarytool history')) {
      return {
        status: notarytool,
        stdout: '',
        stderr: notarytool
          ? 'Error: No Keychain password item found for profile: nestworth'
          : '',
      };
    }
    if (words.startsWith('git worktree add --detach ')) {
      if (missing.has(args[4])) {
        return {
          status: 128,
          stdout: '',
          stderr: `fatal: invalid reference: ${args[4]}`,
        };
      }
      seen.worktree = args[3];
      fs.mkdirSync(seen.worktree, { recursive: true });
      return '';
    }
    if (command === 'npm') {
      seen.childEnvs.push(options.env);
      if (args[0] === 'run') {
        const out = path.join(options.cwd ?? '', 'dist-electron');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(
          path.join(out, `Nestworth-${building}-arm64.dmg`),
          crypto.randomBytes(4096)
        );
      }
      return '';
    }
    if (command === 'spctl') return { status: 0, stdout: '', stderr: spctl };
    if (words.startsWith('xcrun stapler validate ')) {
      return 'Processing: Nestworth.app\nThe validate action worked!\n';
    }
    if (command === 'plutil') return `${building}\n`;
    if (words.startsWith('git worktree remove --force ')) {
      const built = path.join(
        seen.worktree,
        'dist-electron',
        `Nestworth-${building}-arm64.dmg`
      );
      seen.removedAfterVerifiedCopy =
        fs.existsSync(dest(building)) &&
        sha256(dest(building)) === sha256(built);
      return '';
    }
    return '';
  });
  return { ...w, seen };
}

const warnings: string[] = [];
const logs: string[] = [];
const build = (
  m: ReturnType<typeof mac>,
  argv: string[] = ['1.1.10'],
  extra: {
    copyFile?: (from: fs.PathLike, to: fs.PathLike) => void;
    env?: Record<string, string>;
  } = {}
) =>
  releaseDesktop({
    argv,
    env: extra.env ?? {},
    io: m.io,
    platform: 'darwin',
    homedir: home,
    tmpdir: tmp,
    copyFile: extra.copyFile ?? fs.copyFileSync,
    log: (line: string) => {
      logs.push(line);
    },
    warn: (line: string) => {
      warnings.push(line);
    },
  });

beforeEach(() => {
  warnings.length = 0;
  logs.length = 0;
});

// Right after release PR #168 merged: main is at 1.2.0, whose tag waits for
// main's Tests run, and the newest tag is still v1.1.9.
const justMerged = {
  tags: { 'v1.1.9': V119 },
  main: [
    [RELEASE, '1.2.0', '1.1.9'],
    [V119, '1.1.9', '1.1.8'],
  ] as [string, string, string][],
  building: '1.2.0',
};

describe('npm run release:desktop, before the release is tagged', () => {
  it('plans the version main is at, from its release commit, on a dry run', () => {
    const m = mac(justMerged);
    build(m, ['--dry-run']);
    const plan = logs.join('\n');
    expect(plan).toContain(
      'Desktop release 1.2.0: v1.2.0 is not tagged yet; building 971a355, its release ' +
        "commit on main (Publish release tags this same commit once main's CI passes)."
    );
    expect(plan).toContain('1. a worktree detached at 971a355');
    expect(m.ran('git', 'worktree')).toBe(false);
  });

  it('reads main only after fetching it', () => {
    const m = mac(justMerged);
    build(m, ['--dry-run']);
    const at = (...call: string[]) =>
      m.calls.findIndex((c) => call.every((word, i) => c[i] === word));
    expect(at('git', 'fetch', '--no-tags', 'origin')).toBeGreaterThanOrEqual(0);
    expect(at('git', 'fetch', '--no-tags', 'origin')).toBeLessThan(
      at('git', 'show', 'origin/main:package.json')
    );
  });

  it('builds with the worktree detached at the release commit', () => {
    const m = mac(justMerged);
    build(m, ['1.2.0']);
    expect(m.calls).toContainEqual([
      'git',
      'worktree',
      'add',
      '--detach',
      m.seen.worktree,
      RELEASE,
    ]);
    expect(fs.existsSync(dest('1.2.0'))).toBe(true);
    expect(m.seen.removedAfterVerifiedCopy).toBe(true);
  });

  it('still builds a tagged version from its tag', () => {
    const m = mac(justMerged);
    build(m, ['1.1.9', '--dry-run']);
    expect(logs.join('\n')).toContain(
      'Desktop release 1.1.9: v1.1.9 is tagged; building a0d8d03, the commit it points at.'
    );
  });

  it('builds the genuine release commit, not a later revert back to its version', () => {
    // The reviewer's repro: 1.2.1 released at 6c6bc49 (never tagged), 1.2.2
    // released and tagged, then 1.2.2's bump reverted at 0477103.
    const BUMP = '6c6bc49'.padEnd(40, '5');
    const V122 = 'bb22222'.padEnd(40, '7');
    const REVERT = '0477103'.padEnd(40, '6');
    const reverted = {
      tags: { 'v1.2.0': RELEASE, 'v1.2.2': V122 },
      main: [
        [REVERT, '1.2.1', '1.2.2'],
        [V122, '1.2.2', '1.2.1'],
        [BUMP, '1.2.1', '1.2.0'],
        [RELEASE, '1.2.0', '1.1.9'],
      ] as [string, string, string][],
      building: '1.2.1',
    };
    build(mac(reverted), ['--dry-run']);
    expect(logs.join('\n')).toContain(
      'Desktop release 1.2.1: v1.2.1 was never tagged; building 6c6bc49, its release commit on main ' +
        '(later version changes on main followed it, so Publish release will not tag it by itself).'
    );
    const m = mac(reverted);
    build(m, ['1.2.1']);
    expect(m.calls).toContainEqual([
      'git',
      'worktree',
      'add',
      '--detach',
      m.seen.worktree,
      BUMP,
    ]);
  });

  it("fetches without tags, so a local tag that differs from origin's cannot stop it", () => {
    const m = mac({ ...justMerged, localTagConflict: true });
    build(m, ['--dry-run']);
    expect(m.calls).toContainEqual(['git', 'fetch', '--no-tags', 'origin']);
    expect(m.calls.some((c) => c[1] === 'fetch' && c.includes('--tags'))).toBe(
      false
    );
    expect(logs.join('\n')).toContain(
      'Desktop release 1.2.0: v1.2.0 is not tagged yet'
    );
  });

  it("fetches a tag's commit that is not in the clone, without making a local tag", () => {
    const m = mac({ notLocal: [TAGGED] });
    build(m, ['1.1.10']);
    const fetchTag = m.calls.findIndex(
      (c) => c.join(' ') === 'git fetch --no-tags origin refs/tags/v1.1.10'
    );
    const add = m.calls.findIndex((c) => c[1] === 'worktree' && c[2] === 'add');
    expect(fetchTag).toBeGreaterThanOrEqual(0);
    expect(fetchTag).toBeLessThan(add);
    expect(fs.existsSync(dest())).toBe(true);
  });

  it('refuses a version that is neither tagged nor on main', () => {
    const m = mac(justMerged);
    expect(() => build(m, ['1.3.0'])).toThrow(
      '1.3.0 is not on main: merge its release pull request first.'
    );
    expect(m.ran('git', 'worktree')).toBe(false);
  });
});

describe('npm run release:desktop', () => {
  it('files the dmg and removes the worktree only after the copy is verified', () => {
    const m = mac();
    build(m);
    expect(fs.existsSync(dest())).toBe(true);
    expect(m.seen.removedAfterVerifiedCopy).toBe(true);
    expect(fs.existsSync(m.seen.worktree)).toBe(false);
    expect(m.calls).toContainEqual([
      'git',
      'worktree',
      'add',
      '--detach',
      m.seen.worktree,
      TAGGED,
    ]);
  });

  it('keeps the worktree, and files nothing, when the app is not notarized', () => {
    const m = mac({ spctl: 'Nestworth.app: accepted\nsource=Developer ID\n' });
    expect(() => build(m)).toThrow('The app is not notarized');
    expect(m.ran('git', 'worktree', 'remove')).toBe(false);
    expect(fs.existsSync(m.seen.worktree)).toBe(true);
    expect(fs.existsSync(dest())).toBe(false);
    expect(warnings.join('\n')).toContain(
      `The worktree is kept at ${m.seen.worktree}`
    );
  });

  it('keeps the worktree when the filed copy does not match the build', () => {
    const m = mac();
    const damaged = (from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, 'not the dmg');
    };
    expect(() => build(m, ['1.1.10'], { copyFile: damaged })).toThrow(
      'does not match the dmg built'
    );
    expect(m.ran('git', 'worktree', 'remove')).toBe(false);
    expect(fs.existsSync(m.seen.worktree)).toBe(true);
  });

  it('refuses a locked screen before asking for the profile or building', () => {
    const m = mac({
      ioreg: IOREG_UNLOCKED.replace(
        '"IOConsoleLocked" = No',
        '"IOConsoleLocked" = Yes'
      ),
    });
    expect(() => build(m)).toThrow('The screen is locked');
    expect(m.ran('xcrun', 'notarytool')).toBe(false);
    expect(m.ran('git', 'worktree')).toBe(false);
  });

  it('says to unlock and retry before re-storing a profile that did not answer', () => {
    const m = mac({ notarytool: 1 });
    expect(() => build(m)).toThrow(
      'If the screen was locked at any point, unlock it and run this again first'
    );
    expect(m.ran('git', 'worktree')).toBe(false);
  });

  it('checks and plans on a dry run, and builds nothing', () => {
    const m = mac();
    build(m, ['1.1.10', '--dry-run']);
    expect(m.ran('git', 'worktree')).toBe(false);
    expect(m.ran('npm')).toBe(false);
  });

  it('hands npm ci and the build a clean environment, none of the npm run it was started from', () => {
    // What `npm run release:desktop` in the shared checkout hands the script:
    // the owner's .npmrc allow-scripts (npm 11.16 refuses it from the
    // environment: EALLOWSCRIPTS), the checkout's own context, and its
    // node_modules/.bin directories in front of PATH.
    const shared = '/Users/david.lambl/repos/nestworth';
    const m = mac();
    build(m, ['1.1.10'], {
      env: {
        HOME: '/Users/david.lambl',
        PATH: `${shared}/node_modules/.bin:/Users/david.lambl/repos/node_modules/.bin:/node_modules/.bin:/x/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/opt/homebrew/bin:/usr/bin`,
        INIT_CWD: shared,
        npm_config_allow_scripts: '@github/keytar,node-pty',
        npm_config_local_prefix: shared,
        npm_config_force: 'true',
        npm_package_json: `${shared}/package.json`,
        npm_lifecycle_event: 'release:desktop',
        npm_execpath: '/x/npm-cli.js',
        npm_command: 'run',
      },
    });
    expect(m.seen.childEnvs).toHaveLength(2);
    for (const env of m.seen.childEnvs) {
      expect(
        Object.keys(env ?? {}).filter((k) => /^npm_|^INIT_CWD$/i.test(k))
      ).toEqual([]);
      expect(env?.PATH).toBe('/opt/homebrew/bin:/usr/bin');
      expect(env?.HOME).toBe('/Users/david.lambl');
    }
    // The build still gets what it needs.
    expect(m.seen.childEnvs[1]).toMatchObject({
      APPLE_KEYCHAIN_PROFILE: 'nestworth',
      TMPDIR: expect.stringMatching(/nestworth-desktop-1\.1\.10-.+\/tmp$/),
    });
  });

  it('refuses to rebuild a filed dmg without --force', () => {
    fs.mkdirSync(path.dirname(dest()), { recursive: true });
    fs.writeFileSync(dest(), 'an earlier build');
    const m = mac();
    expect(() => build(m)).toThrow(
      `already exists (sha256 ${sha256(dest())}); pass --force`
    );
    expect(m.ran('git', 'worktree')).toBe(false);
  });
});

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { releaseDesktop } from '../../scripts/release-desktop';
import { fakeIo, type RunOptions } from '../testing/releaseFakes';

// `npm run release:desktop`, driven with fakes for git, npm and the macOS
// tools, in temporary directories standing in for the checkout, $HOME and
// $TMPDIR. The build writes a real file, so the copy and its hash are real.

const TAGGED = '904f8ac'.padEnd(40, '2');
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
const dest = () =>
  path.join(home, 'nestworth-builds', 'Nestworth-1.1.10-arm64.dmg');

type Mac = { ioreg?: string; spctl?: string; notarytool?: number };

// The Mac and origin as they would answer. When the worktree is removed, it
// records whether the filed copy existed then and matched the built dmg.
function mac({
  ioreg = IOREG_UNLOCKED,
  spctl = NOTARIZED,
  notarytool = 0,
}: Mac = {}) {
  const seen = {
    worktree: '',
    removedAfterVerifiedCopy: null as boolean | null,
    childEnvs: [] as (Record<string, string | undefined> | undefined)[],
  };
  const w = fakeIo((command: string, args: string[], options: RunOptions) => {
    const words = [command, ...args].join(' ');
    if (words === 'git rev-parse --show-toplevel') return `${root}\n`;
    if (words === 'git ls-remote --tags origin') {
      return `${'9'.repeat(40)}\trefs/tags/v1.1.10\n${TAGGED}\trefs/tags/v1.1.10^{}\n`;
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
          path.join(out, 'Nestworth-1.1.10-arm64.dmg'),
          crypto.randomBytes(4096)
        );
      }
      return '';
    }
    if (command === 'spctl') return { status: 0, stdout: '', stderr: spctl };
    if (words.startsWith('xcrun stapler validate ')) {
      return 'Processing: Nestworth.app\nThe validate action worked!\n';
    }
    if (command === 'plutil') return '1.1.10\n';
    if (words.startsWith('git worktree remove --force ')) {
      const built = path.join(
        seen.worktree,
        'dist-electron',
        'Nestworth-1.1.10-arm64.dmg'
      );
      seen.removedAfterVerifiedCopy =
        fs.existsSync(dest()) && sha256(dest()) === sha256(built);
      return '';
    }
    return '';
  });
  return { ...w, seen };
}

const warnings: string[] = [];
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
    log: () => {},
    warn: (line: string) => {
      warnings.push(line);
    },
  });

beforeEach(() => {
  warnings.length = 0;
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

  it("keeps npm's own --dry-run and --force away from the build", () => {
    const m = mac();
    build(m, ['1.1.10'], {
      env: {
        npm_config_dry_run: 'false',
        npm_config_force: 'true',
        PATH: '/usr/bin',
      },
    });
    expect(m.seen.childEnvs).toHaveLength(2);
    for (const env of m.seen.childEnvs) {
      expect(env).toMatchObject({ PATH: '/usr/bin' });
      expect(env).not.toHaveProperty('npm_config_dry_run');
      expect(env).not.toHaveProperty('npm_config_force');
    }
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

// `npm run release:desktop [-- X.Y.Z] [--dry-run] [--force]`
//
// Builds the notarized macOS dmg of a release (the version on origin's main
// unless one is given), checks it, and files it in ~/nestworth-builds/ with
// its sha256. It builds the release's tag, or, before the tag exists (Publish
// release tags only once main's Tests pass), the release commit on main that
// the tag will point at: a local build ships nothing, so it need not wait.
// macOS only: the Developer ID certificate is in the login keychain, and
// notarization reads the notarytool keychain profile "nestworth", which macOS
// seals while the screen is locked.
//
// The build runs in a temporary worktree detached at that commit, outside the
// repository, so the dmg is exactly the release whatever this checkout
// holds; with its own `npm ci` (a copy of this checkout's node_modules can
// carry packages the lockfile no longer has) and a private TMPDIR (a cold
// Metro cache). The worktree is removed only after the dmg's copy is
// verified: a dmg left in a removed worktree is lost. --dry-run runs the
// preflight and prints the plan; nothing is uploaded anywhere, ever.
//
// releaseDesktop takes its arguments, environment, command layer
// (./release/io), platform, directories and file copy, so
// lib/__tests__/releaseDesktopRun.test.ts can drive it with fakes; run as a
// script, it uses the real ones.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDesktopArgs } = require('./release/args');
const {
  desktopTarget,
  desktopVersion,
  dmgName,
  notarized,
  screenLocked,
  stapled,
} = require('./release/desktop');
const { cleanChildEnv } = require('./release/env');
const { readHistory } = require('./release/history');
const defaultIo = require('./release/io');
const { parseLsRemote, tagCommit } = require('./release/refs');

const PROFILE = 'nestworth';

const USAGE = `Usage: npm run release:desktop [-- X.Y.Z] [--dry-run] [--force]

Builds, checks and files the notarized dmg of a release (default: the version
on origin's main) in ~/nestworth-builds/. It builds the release's tag, or,
until Publish release has tagged it, its release commit on main, which is the
commit the tag will point at. --force rebuilds over a dmg already there;
--dry-run checks and prints the plan only.`;

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, io?: typeof defaultIo, platform?: string, homedir?: string, tmpdir?: string, copyFile?: (from: import('fs').PathLike, to: import('fs').PathLike) => void, log?: (line: string) => void, warn?: (line: string) => void }} [deps]
 */
function releaseDesktop({
  argv = process.argv.slice(2),
  env = process.env,
  io = defaultIo,
  platform = process.platform,
  homedir = os.homedir(),
  tmpdir = os.tmpdir(),
  copyFile = fs.copyFileSync,
  log = console.log,
  warn = console.error,
} = {}) {
  const { git, run } = io;
  // Under `npm run`, npm hands this script its configuration and the
  // checkout's context as npm_* variables and PATH entries (release/env.js);
  // the `npm ci` and the build in the worktree get none of it.
  const childEnv = (extra) => cleanChildEnv(env, extra);

  const args = parseDesktopArgs(argv, env);
  if (args.help) {
    log(USAGE);
    return;
  }
  if (platform !== 'darwin') {
    throw new Error(
      'The desktop release builds on macOS only: it signs with the Developer ' +
        'ID certificate in the login keychain.'
    );
  }

  const root = git(['rev-parse', '--show-toplevel']);
  // origin's main as it is now: a release merged a minute ago is on main
  // before it is tagged. No tags are fetched: the tags that count are
  // origin's (ls-remote below), and a local tag that differs from origin's
  // would make `--tags` refuse, or clobber it.
  git(['fetch', '--no-tags', 'origin'], { cwd: root });
  const history = readHistory({
    run: (command, commandArgs, options = {}) =>
      run(command, commandArgs, { cwd: root, ...options }),
    git: (gitArgs) => git(gitArgs, { cwd: root }),
  });
  const mainVersion = history.versionAt('origin/main:package.json');
  const version = desktopVersion({ argVersion: args.version, mainVersion });
  const tag = `v${version}`;
  const tagged = tagCommit(
    parseLsRemote(git(['ls-remote', '--tags', 'origin'], { cwd: root })),
    tag
  );
  const target = desktopTarget({
    version,
    tagCommit: tagged,
    releaseCommit: tagged
      ? null
      : history.releaseCommitOn('origin/main', version),
    latestChange: tagged ? null : history.lastVersionChange('origin/main'),
  });
  const envLocal = path.join(root, '.env.local');
  const buildsDir = path.join(homedir, 'nestworth-builds');
  const dest = path.join(buildsDir, dmgName(version));

  const problems = [];
  if (screenLocked(run('ioreg', ['-n', 'Root', '-d1']).stdout)) {
    problems.push(
      'The screen is locked, which seals the notarytool profile: unlock the ' +
        'Mac and run this again.'
    );
  } else {
    const history = run(
      'xcrun',
      ['notarytool', 'history', '--keychain-profile', PROFILE],
      { allowFailure: true }
    );
    if (history.status !== 0) {
      const why = (history.stderr || history.stdout).trim().split('\n')[0];
      problems.push(
        `The notarytool keychain profile "${PROFILE}" did not answer (${why}). ` +
          'If the screen was locked at any point, unlock it and run this again ' +
          'first; store the profile again (README, macOS app, One-time setup) ' +
          'only if it is really gone.'
      );
    }
  }
  if (!fs.existsSync(envLocal)) {
    problems.push(
      `${envLocal} is missing: the build inlines the production Supabase URL ` +
        'and anon key from it.'
    );
  }
  if (fs.existsSync(dest) && !args.force) {
    problems.push(
      `${dest} already exists (sha256 ${sha256(dest)}); pass --force to rebuild it.`
    );
  }

  const base = path.join(tmpdir, `nestworth-desktop-${version}-XXXXXX`);
  log(`
Desktop release ${version}: ${target.summary}
  1. a worktree detached at ${target.sha.slice(0, 7)} in ${base}/wt (outside the repository)
  2. npm ci there, and ${envLocal} linked into it
  3. APPLE_KEYCHAIN_PROFILE=${PROFILE} npm run electron:build, in the foreground, TMPDIR private
  4. spctl must say source=Notarized Developer ID; stapler validate must pass;
     the app's CFBundleShortVersionString must be ${version}
  5. ${dmgName(version)} copied to ${dest}${fs.existsSync(dest) && args.force ? ' (replacing the one there)' : ''}, its sha256 checked and printed
  6. the worktree removed, only after that copy is verified
`);
  if (problems.length > 0) throw new Error(problems.join(' '));
  if (args.dryRun) {
    log('Dry run: the preflight passed; nothing was built.');
    return;
  }

  const dir = fs.mkdtempSync(
    path.join(tmpdir, `nestworth-desktop-${version}-`)
  );
  const wt = path.join(dir, 'wt');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  // A tag's commit off main is not in the fetch above: fetch the tag itself,
  // into FETCH_HEAD only, so no local tag is made or changed.
  if (
    run('git', ['cat-file', '-e', `${target.sha}^{commit}`], {
      cwd: root,
      allowFailure: true,
    }).status !== 0
  ) {
    git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}`], { cwd: root });
  }
  git(['worktree', 'add', '--detach', wt, target.sha], { cwd: root });

  let verified = false;
  try {
    run('npm', ['ci'], { cwd: wt, inherit: true, env: childEnv() });
    fs.symlinkSync(envLocal, path.join(wt, '.env.local'));
    run('npm', ['run', 'electron:build'], {
      cwd: wt,
      inherit: true,
      env: childEnv({ APPLE_KEYCHAIN_PROFILE: PROFILE, TMPDIR: tmp }),
    });

    const app = path.join(wt, 'dist-electron', 'mac-arm64', 'Nestworth.app');
    const dmg = path.join(wt, 'dist-electron', dmgName(version));
    const assess = run('spctl', ['--assess', '--type', 'execute', '-vv', app], {
      allowFailure: true,
    });
    const assessText = `${assess.stdout}${assess.stderr}`.trim();
    if (!notarized(assessText)) {
      throw new Error(
        `The app is not notarized (electron-builder skips notarization ` +
          `silently when it finds no credentials). spctl said: ${assessText}`
      );
    }
    const staple = run('xcrun', ['stapler', 'validate', app], {
      allowFailure: true,
    });
    if (!stapled(staple.status, `${staple.stdout}${staple.stderr}`)) {
      throw new Error(
        `stapler validate failed: ${`${staple.stdout}${staple.stderr}`.trim()}`
      );
    }
    const bundleVersion = run('plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      path.join(app, 'Contents', 'Info.plist'),
    ]).stdout.trim();
    if (bundleVersion !== version) {
      throw new Error(`The app says version ${bundleVersion}, not ${version}.`);
    }
    if (!fs.existsSync(dmg)) throw new Error(`${dmg} was not built.`);

    fs.mkdirSync(buildsDir, { recursive: true });
    copyFile(dmg, dest);
    const built = sha256(dmg);
    if (sha256(dest) !== built) {
      throw new Error(`The copy at ${dest} does not match the dmg built.`);
    }
    verified = true;
    log(`\n${built}  ${dest}`);
  } finally {
    if (verified) {
      git(['worktree', 'remove', '--force', wt], { cwd: root });
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      warn(
        `\nThe worktree is kept at ${wt} with whatever was built. Remove it ` +
          `when done: git worktree remove --force ${wt}`
      );
    }
  }
  log(
    `Nestworth ${version} is notarized and filed. Install it by opening the dmg ` +
      'and dragging Nestworth to Applications.'
  );
}

module.exports = { releaseDesktop, USAGE };

if (require.main === module) {
  defaultIo.main(() => releaseDesktop());
}

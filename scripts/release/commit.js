// Release commits: what the Release workflow may put in one, and what the
// Publish release workflow does about a commit on main (whether it is a
// release commit, what happens to its tag, whether the TestFlight build
// starts). Pure decisions; scripts/release/prepare.js and publish.js run the
// commands.

const { compareVersions, isVersion } = require('./version');

// `npm version` changes one line of package.json, the two version fields of
// package-lock.json, and (through the `version` hook) one line of app.json.
// Anything more (a lockfile rewritten by a different npm, app.json
// reformatted by the hook) would ride into a "version bump only" pull request
// unseen, so the bump stops instead.
const BUMP_LINES = {
  'app.json': '1\t1',
  'package-lock.json': '2\t2',
  'package.json': '1\t1',
};

// `numstat` is `git diff --cached --numstat`, `status` is
// `git status --porcelain`, both after staging the three files.
function checkBumpDiff({ numstat, status }) {
  const problems = [];
  const changed = new Map(
    numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, ...file] = line.split('\t');
        return [file.join('\t'), `${added}\t${deleted}`];
      })
  );
  for (const [file, lines] of Object.entries(BUMP_LINES)) {
    const got = changed.get(file);
    if (got === undefined) problems.push(`${file} did not change`);
    else if (got !== lines) {
      problems.push(
        `${file} changes ${got.replace('\t', ' added/')} removed lines, ` +
          `not ${lines.replace('\t', '/')}`
      );
    }
  }
  for (const file of changed.keys()) {
    if (!(file in BUMP_LINES)) problems.push(`${file} changed too`);
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const file = line.slice(3);
    if (!(line.startsWith('M  ') && file in BUMP_LINES)) {
      problems.push(`the checkout also has "${line}"`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      'The release commit must change exactly package.json (1 line), ' +
        `package-lock.json (2) and app.json (1): ${problems.join('; ')}.`
    );
  }
}

// The automatic path acts only on a green Tests run of a push to main. The
// workflow's `branches: [main]` filter matches the triggering run's HEAD
// branch, which for a pull request from a fork can also be called "main", so
// the event is checked too.
function workflowRunDecision({ conclusion, event, headBranch }) {
  if (event !== 'push' || headBranch !== 'main') {
    return {
      act: false,
      reason: `the Tests run was a ${event} on ${headBranch}, not a push to main`,
    };
  }
  if (conclusion !== 'success') {
    return { act: false, reason: `the Tests run ended "${conclusion}"` };
  }
  return { act: true, reason: 'a green Tests run of a push to main' };
}

function readVersion(jsonText, label, pick) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
  const value = pick(parsed || {});
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} has no version.`);
  }
  return value;
}

// A release commit is one that moves package.json's version, read from the
// commit and from its first parent (with `git show`, never from a working
// tree). It must carry the same number in app.json's expo.version, the copy
// the app, EAS and the Playwright footer check read; a mismatch fails loudly
// instead of tagging an inconsistent commit.
function releaseCommit({ packageJson, parentPackageJson, appJson }) {
  const version = readVersion(packageJson, 'package.json', (p) => p.version);
  if (parentPackageJson == null) {
    return { release: false, reason: 'the commit has no parent package.json' };
  }
  const before = readVersion(
    parentPackageJson,
    "the parent commit's package.json",
    (p) => p.version
  );
  if (version === before) {
    return { release: false, reason: `package.json stays at ${version}` };
  }
  if (!isVersion(version)) {
    throw new Error(
      `package.json moves to "${version}", which is not an X.Y.Z version.`
    );
  }
  if (isVersion(before) && compareVersions(version, before) < 0) {
    return {
      release: false,
      warning: true,
      reason:
        `package.json moves backward, ${before} to ${version} (a revert?): ` +
        'a downgrade is never published',
    };
  }
  const appVersion = readVersion(
    appJson,
    'app.json',
    (a) => a.expo && a.expo.version
  );
  if (appVersion !== version) {
    throw new Error(
      `package.json moves to ${version} but app.json's expo.version is ` +
        `${appVersion}. Nothing was tagged: a release commit must carry one ` +
        'number in both files, which the Release workflow checks when it bumps.'
    );
  }
  return { release: true, version, previous: before };
}

// On a manual dispatch for a version with no tag yet: the newest commit on
// main's first-parent history that moved package.json to `version`.
// `candidates` are the commits that touched package.json, newest first, each
// { sha, version, parentVersion }.
function findReleaseCommit(candidates, version) {
  return (
    candidates.find(
      (c) => c.version === version && c.parentVersion !== version
    ) || null
  );
}

// The tag vX.Y.Z for the release commit `sha`, given the commit the tag points
// at on origin (null when origin has no such tag). A tag at the release
// commit is left alone, so re-runs are harmless; a tag anywhere else means
// someone else made it, and nothing is published over it.
function tagDecision({ tag, sha, tagCommit }) {
  if (!tagCommit) return { action: 'create' };
  if (tagCommit === sha) return { action: 'exists' };
  throw new Error(
    `${tag} already exists on origin at ${tagCommit.slice(0, 7)}, not at the ` +
      `release commit ${sha.slice(0, 7)}. Nothing was tagged, built or ` +
      `released: find out where that tag came from before publishing ${tag}.`
  );
}

// When the TestFlight build starts; a release is never built twice by
// accident. On the automatic path, at most once per release commit: only
// when no testflight.yml run has ever started for that commit, whatever
// triggered it and however it ended, so a re-run of main's Tests, or of this
// workflow after a later step failed, never starts a second iOS build. A
// manual dispatch with testflight=true (its default) is a repair: it builds
// only when no run of the commit has succeeded or is still queued or
// running, so a failed or cancelled build can be retried from there, and a
// backfill or a re-run never rebuilds a release that already built. A
// deliberate rebuild is testflight.yml run from the tag.
//
// `runs` are the testflight.yml runs of the release commit. Reasons carry no
// final full stop; the summary line adds one.
function testflightDecision({ event, testflight, runs }) {
  const newestFirst = [...runs].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
  );
  const live = newestFirst.find((run) => run.status !== 'completed');
  const built = newestFirst.find((run) => run.conclusion === 'success');
  const automatic = event !== 'workflow_dispatch';
  if (!automatic && !testflight) {
    return { dispatch: false, reason: 'not requested (testflight=false)' };
  }
  if (live) {
    return {
      dispatch: false,
      reason: `a TestFlight run for this commit is still ${live.status.replace('_', ' ')}: ${live.html_url}`,
    };
  }
  if (built) {
    return {
      dispatch: false,
      reason:
        `TestFlight already built this commit: ${built.html_url}; to build it ` +
        'again on purpose, run TestFlight from the tag',
    };
  }
  if (automatic && newestFirst.length > 0) {
    const last = newestFirst[0];
    return {
      dispatch: false,
      reason:
        `TestFlight already ran for this commit and ended "${last.conclusion}": ` +
        `${last.html_url}; to retry, dispatch Publish release with testflight=true`,
    };
  }
  return automatic
    ? { dispatch: true, reason: 'the first publish of this release commit' }
    : { dispatch: true, reason: 'requested (testflight=true)' };
}

module.exports = {
  BUMP_LINES,
  checkBumpDiff,
  workflowRunDecision,
  releaseCommit,
  findReleaseCommit,
  tagDecision,
  testflightDecision,
};

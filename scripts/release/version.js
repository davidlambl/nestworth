// Version arithmetic for a release, shared by the Release workflow, the
// Publish release workflow and `npm run release`. Pure functions: the callers
// run every command these decide on.

const LEVELS = ['patch', 'minor', 'major'];

// X.Y.Z with no leading zeros and no prerelease or build suffix: the only shape
// a Nestworth version has ever had, and the one app.json, EAS and the dmg's
// file name are known to handle. Nine digits keep every part an exact Number.
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isVersion(text) {
  return parseVersion(text) !== null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    throw new Error(`Cannot compare "${a}" with "${b}": not X.Y.Z versions.`);
  }
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// The allow-list for the Release workflow's `version` input and for
// `npm run release`. The value reaches `npm version`, which would also take a
// prerelease, "from-git" or a leading "v"; none of those is a Nestworth
// release, so they are refused here, before npm runs, with the reason.
function parseVersionInput(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (LEVELS.includes(value)) return { level: value };
  if (isVersion(value)) return { version: value };
  const hint =
    /^v/.test(value) && isVersion(value.slice(1))
      ? `Write ${value.slice(1)}, without the "v".`
      : 'Use patch, minor, major or an exact version such as 1.2.0.';
  throw new Error(`"${input}" is not a release version. ${hint}`);
}

// What `npm version <input>` makes of `current`. The workflow still lets npm
// do the bump and then checks npm agreed, so this is the expectation, not the
// mechanism.
function bumpVersion(current, input) {
  const parts = parseVersion(current);
  if (!parts) {
    throw new Error(`main's version "${current}" is not an X.Y.Z version.`);
  }
  const request =
    typeof input === 'string' ? parseVersionInput(input) : input || {};
  if (request.version) return request.version;
  const [major, minor, patch] = parts;
  if (request.level === 'major') return `${major + 1}.0.0`;
  if (request.level === 'minor') return `${major}.${minor + 1}.0`;
  if (request.level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('No bump level or version was given.');
}

// The release tags among `names` (tag names without refs/tags/), newest first.
function versionTags(names) {
  return names
    .filter((name) => name.startsWith('v') && isVersion(name.slice(1)))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

function latestVersionTag(names) {
  return versionTags(names)[0] || null;
}

// The release a version's notes start from: the newest tag below it, which for
// a backfill of an old version is not the newest tag overall.
function previousVersionTag(names, version) {
  return (
    versionTags(names).find((t) => compareVersions(t.version, version) < 0) ||
    null
  );
}

// The newest release tag above `version`, if there is one: a GitHub Release
// made for a backfill, or for a release commit whose Tests run finished after
// a later one's, must not take the "Latest" badge from it.
function newerVersionTag(names, version) {
  const latest = latestVersionTag(names);
  return latest && compareVersions(latest.version, version) > 0 ? latest : null;
}

// Decides the next release from main's package.json version, the input, and
// origin's tags and branches. Refuses, with every reason at once, a version
// that does not move forward, a tag that already exists, or a release branch
// already on origin (an earlier run's, whose pull request is the way on).
function planRelease({ current, input, tags, branches }) {
  const request = parseVersionInput(input);
  const version = bumpVersion(current, request);
  const tag = `v${version}`;
  const branch = `release/${version}`;
  const latest = latestVersionTag(tags);
  const refusals = [];
  if (compareVersions(version, current) <= 0) {
    refusals.push(`${version} is not greater than main's version, ${current}.`);
  }
  if (latest && compareVersions(version, latest.version) <= 0) {
    refusals.push(
      `${version} is not greater than the latest release tag, ${latest.tag}.`
    );
  }
  if (tags.includes(tag)) {
    refusals.push(`The tag ${tag} already exists on origin.`);
  }
  if (branches.includes(branch)) {
    refusals.push(
      `${branch} already exists on origin. Open its pull request, or delete ` +
        `the branch (git push origin --delete ${branch}) and run the release again.`
    );
  }
  if (refusals.length > 0) throw new Error(refusals.join(' '));

  const warnings = [];
  if (!tags.includes(`v${current}`)) {
    warnings.push(
      `main's version ${current} has no tag v${current}: it was never ` +
        `published (see the Publish release runs), and ${version} skips it.`
    );
  }
  const previous = previousVersionTag(tags, version);
  return {
    version,
    tag,
    branch,
    previousTag: previous ? previous.tag : null,
    warnings,
  };
}

module.exports = {
  LEVELS,
  parseVersion,
  isVersion,
  compareVersions,
  parseVersionInput,
  bumpVersion,
  versionTags,
  latestVersionTag,
  previousVersionTag,
  newerVersionTag,
  planRelease,
};

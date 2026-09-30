// Reading a release's history from a clone: what a file says at a commit, and
// which commit on a branch made a release. Shared by Publish release (tagging
// a release whose automatic publish never happened) and
// `npm run release:desktop` (building a merged release before it is tagged).

const { findReleaseCommit } = require('./commit');

// `repo` is { run, git } from ./io, already pointed at the clone.
function readHistory(repo) {
  // A file as it is in a commit, or null when the commit or file is missing.
  const show = (spec) => {
    const out = repo.run('git', ['show', spec], { allowFailure: true });
    return out.status === 0 ? out.stdout : null;
  };

  const versionAt = (spec) => {
    const text = show(spec);
    try {
      return text ? JSON.parse(text).version : null;
    } catch {
      return null;
    }
  };

  // The first-parent commits on `ref` that touched package.json, newest
  // first, each with its version and its parent's, read lazily.
  function* versionMoves(ref) {
    const shas = repo
      .git(['log', '--first-parent', '--format=%H', ref, '--', 'package.json'])
      .split('\n')
      .filter(Boolean);
    for (const sha of shas) {
      yield {
        sha,
        version: versionAt(`${sha}:package.json`),
        parentVersion: versionAt(`${sha}^:package.json`),
      };
    }
  }

  // The newest first-parent commit on `ref` that moved package.json up to
  // `version` (findReleaseCommit passes over a revert that moved it down),
  // reading back only as far as it takes.
  const releaseCommitOn = (ref, version) => {
    for (const candidate of versionMoves(ref)) {
      if (findReleaseCommit([candidate], version)) return candidate.sha;
    }
    return null;
  };

  // The newest first-parent commit on `ref` that changed package.json's
  // version at all, up or down: the one whose green Tests run Publish
  // release acts on.
  const lastVersionChange = (ref) => {
    for (const move of versionMoves(ref)) {
      if (move.version !== move.parentVersion) return move.sha;
    }
    return null;
  };

  return { show, versionAt, releaseCommitOn, lastVersionChange };
}

module.exports = { readHistory };

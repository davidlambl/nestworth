// Reading origin's refs. The release tooling asks origin itself
// (`git ls-remote origin`) for its tags and branches rather than trusting a
// local clone's refs, which can be stale, shallow, or carry a tag nobody
// pushed.

const SHA = /^[0-9a-f]{40}$/;

function isSha(text) {
  return typeof text === 'string' && SHA.test(text);
}

// `git ls-remote` prints one "<object>\t<ref>" line per ref. An annotated tag
// has a second line, "<commit>\trefs/tags/<name>^{}", naming the commit it
// points at; a lightweight tag's object is the commit itself. Returns Maps of
// branch name to commit, and tag name to { object, commit }.
function parseLsRemote(text) {
  const heads = new Map();
  const tags = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/(heads|tags)\/(.+?)(\^\{\})?$/.exec(
      line.trim()
    );
    if (!match) continue;
    const [, sha, kind, name, peeled] = match;
    if (kind === 'heads') {
      heads.set(name, sha);
    } else if (peeled) {
      tags.set(name, { object: sha, ...tags.get(name), commit: sha });
    } else {
      const known = tags.get(name);
      tags.set(name, { object: sha, commit: known ? known.commit : sha });
    }
  }
  return { heads, tags };
}

// The commit a tag points at on origin, or null when origin has no such tag.
function tagCommit(refs, tag) {
  const entry = refs.tags.get(tag);
  return entry ? entry.commit : null;
}

// "owner/repo" from a GitHub remote URL, in the https or ssh form.
function repoFromRemoteUrl(url) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      String(url).trim()
    );
  if (!match) {
    throw new Error(`origin (${url}) is not a GitHub repository URL.`);
  }
  return `${match[1]}/${match[2]}`;
}

module.exports = { isSha, parseLsRemote, tagCommit, repoFromRemoteUrl };

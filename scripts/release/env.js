// The environment for an npm the release scripts start while they run under
// `npm run`: `npm ci` and `npm run electron:build` in a worktree other than
// the checkout npm was started in.
//
// npm hands the script it runs its whole configuration and context as
// environment variables: npm_config_* (the user's .npmrc, and
// npm_config_local_prefix, the checkout the script was started in),
// npm_package_*, npm_lifecycle_*, npm_execpath, npm_command, INIT_CWD, NODE,
// COLOR and EDITOR. It also puts node_modules/.bin of that checkout and of
// every directory above it, and its own node-gyp-bin, at the front of PATH.
// A child npm must see none of it:
//   - npm 11.16 refuses an allow-scripts that arrives from the environment
//     in a project install (EALLOWSCRIPTS), and the owner's .npmrc sets one;
//   - nothing of the checkout the script was started from may steer an
//     install or a build of another worktree.
// The child npm reads the user's .npmrc itself, and sets its own context and
// PATH for the scripts it runs. Everything else (HOME, the rest of PATH,
// locale, keychain access) passes through, and `extra` sets what the build
// needs.

const path = require('path');

const NPM_CONTEXT = new Set(['INIT_CWD', 'NODE', 'COLOR', 'EDITOR']);

const npmAddedDir = (dir) =>
  /[\\/]node_modules[\\/]\.bin$/.test(dir) || /[\\/]node-gyp-bin$/.test(dir);

function cleanChildEnv(env, extra = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_/i.test(key) || NPM_CONTEXT.has(key)) continue;
    clean[key] = value;
  }
  if (clean.PATH) {
    clean.PATH = clean.PATH.split(path.delimiter)
      .filter((dir) => dir && !npmAddedDir(dir))
      .join(path.delimiter);
  }
  return { ...clean, ...extra };
}

module.exports = { cleanChildEnv };

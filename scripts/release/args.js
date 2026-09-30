// Command-line arguments of `npm run release` and `npm run release:desktop`.
//
// `npm run release patch --dry-run`, without the `--`, does not pass
// --dry-run to the script: npm takes it as its own flag and only sets
// npm_config_dry_run=true in the environment. A script reading argv alone
// would then do the real thing, so both parsers honour that variable (and
// npm_config_force the same way).

const { isVersion, parseVersionInput } = require('./version');

function flagsFrom(env) {
  return {
    dryRun: env.npm_config_dry_run === 'true',
    force: env.npm_config_force === 'true',
  };
}

function parseReleaseArgs(argv, env = {}) {
  const { dryRun } = flagsFrom(env);
  const result = { input: null, dryRun, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else if (result.input !== null) {
      throw new Error(
        `One version at a time (got ${result.input} and ${arg}).`
      );
    } else result.input = arg;
  }
  if (result.help) return result;
  if (result.input === null) {
    throw new Error('Say which release: patch, minor, major or X.Y.Z.');
  }
  parseVersionInput(result.input);
  return result;
}

// The version is optional (the newest release tag on origin by default) and
// may be written as the tag, v1.2.0.
function parseDesktopArgs(argv, env = {}) {
  const result = { version: null, ...flagsFrom(env), help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else if (result.version !== null) {
      throw new Error(
        `One version at a time (got ${result.version} and ${arg}).`
      );
    } else {
      const version = arg.replace(/^v/, '');
      if (!isVersion(version)) {
        throw new Error(`"${arg}" is not a release version such as 1.2.0.`);
      }
      result.version = version;
    }
  }
  return result;
}

module.exports = { parseReleaseArgs, parseDesktopArgs };

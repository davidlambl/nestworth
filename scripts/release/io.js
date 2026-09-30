// Running commands and talking to GitHub Actions, for the release scripts.
// Every command is echoed before it runs, so a workflow log or a terminal
// shows exactly what was done, in order.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

// POSIX single-quoting, only where a word needs it: for the echo, never for
// execution (commands run without a shell).
function shellQuote(word) {
  const text = String(word);
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, `'\\''`)}'`;
}

// A workflow command's message must not contain raw "%", CR or LF.
function escapeData(text) {
  return String(text)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

// One entry for $GITHUB_OUTPUT, in the delimiter form that also carries
// multi-line values.
function outputEntry(name, value, delimiter) {
  const text = String(value);
  if (text.includes(delimiter)) {
    throw new Error(`The value of ${name} contains its own delimiter.`);
  }
  return `${name}<<${delimiter}\n${text}\n${delimiter}\n`;
}

function run(command, args, options = {}) {
  const { cwd, env, input, allowFailure = false, inherit = false } = options;
  console.error(`$ ${[command, ...args].map(shellQuote).join(' ')}`);
  if (input !== undefined) console.error(`  (stdin) ${input}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} could not run: ${result.error.message}`);
  }
  const out = {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
  if (out.status !== 0 && !allowFailure) {
    const detail = (out.stderr.trim() || out.stdout.trim())
      .split('\n')
      .slice(-5)
      .join('\n');
    throw new Error(
      `\`${command} ${args.slice(0, 2).join(' ')}\` failed (exit ${out.status})` +
        (detail ? `: ${detail}` : '.')
    );
  }
  return out;
}

function git(args, options) {
  return run('git', args, options).stdout.trim();
}

// `gh api`, with an optional JSON request body on stdin. Returns the parsed
// response, or null for an empty one.
function ghApi(args, body, options = {}) {
  const input = body === undefined ? undefined : JSON.stringify(body);
  const out = run(
    'gh',
    ['api', ...args, ...(input === undefined ? [] : ['--input', '-'])],
    { ...options, input }
  );
  const text = out.stdout.trim();
  return text ? JSON.parse(text) : null;
}

const inActions = () => process.env.GITHUB_ACTIONS === 'true';

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  fs.appendFileSync(file, outputEntry(name, value, delimiter));
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  if (file) fs.appendFileSync(file, text);
  else console.log(text);
}

function annotate(level, message) {
  if (inActions()) console.log(`::${level}::${escapeData(message)}`);
  else console.error(`${level === 'error' ? 'Error' : 'Warning'}: ${message}`);
}

// Runs the named step of a workflow's step runner, or explains the usage.
function runStep(steps, name, script) {
  if (!Object.hasOwn(steps, name)) {
    throw new Error(
      `Usage: node scripts/release/${script} <${Object.keys(steps).join('|')}>`
    );
  }
  return steps[name]();
}

// Runs a script's main function and turns a thrown error into a readable
// failure: an annotation on the workflow run, or one line in a terminal.
function main(fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      annotate('error', error && error.message ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  shellQuote,
  escapeData,
  outputEntry,
  run,
  git,
  ghApi,
  inActions,
  setOutput,
  appendSummary,
  annotate,
  runStep,
  main,
};

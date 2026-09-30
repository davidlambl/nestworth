// `npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]`
//
// Starts the Release workflow on main, follows the run it started, and opens
// the release pull request with your own gh sign-in. The workflow cannot open
// it: the repository does not let GitHub Actions create pull requests, and a
// pull request opened with the workflow's token would start no Tests run
// (see the header of .github/workflows/release.yml). With --dry-run the run
// bumps and composes but pushes nothing, and no pull request is opened.
//
// runRelease takes its arguments, environment, command layer (./release/io)
// and temporary directory, so lib/__tests__/releaseWrapper.test.ts can drive
// it with a recording fake; run as a script, it uses the real ones.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseReleaseArgs } = require('./release/args');
const defaultIo = require('./release/io');
const { repoFromRemoteUrl } = require('./release/refs');

const USAGE = `Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]

Starts the Release workflow on main (it bumps the version on release/X.Y.Z),
waits for it, and opens the release pull request. Merging that pull request
is the release: Publish release then tags it, starts TestFlight and creates
the GitHub Release. Needs gh, signed in to an account that can run workflows.`;

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, io?: typeof defaultIo, tmpdir?: string, sleep?: (ms: number) => Promise<unknown>, log?: (line: string) => void }} [deps]
 */
async function runRelease({
  argv = process.argv.slice(2),
  env = process.env,
  io = defaultIo,
  tmpdir = os.tmpdir(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const { ghApi, git, run } = io;
  const args = parseReleaseArgs(argv, env);
  if (args.help) {
    log(USAGE);
    return;
  }
  if (run('gh', ['auth', 'status'], { allowFailure: true }).status !== 0) {
    throw new Error(
      'gh is not signed in: run `gh auth login`, then try again.'
    );
  }
  const repo = repoFromRemoteUrl(git(['remote', 'get-url', 'origin']));
  const workflow = `repos/${repo}/actions/workflows/release.yml`;
  const dispatchRuns = () =>
    ghApi([`${workflow}/runs?event=workflow_dispatch&branch=main&per_page=20`])
      .workflow_runs;

  let before;
  try {
    before = new Set(dispatchRuns().map((r) => r.id));
  } catch (error) {
    if (/HTTP 404/.test(error.message)) {
      throw new Error(
        `GitHub has no Release workflow on main yet in ${repo} ` +
          '(.github/workflows/release.yml): it can run only once it is merged.'
      );
    }
    throw error;
  }
  const dispatched = ghApi(['--method', 'POST', `${workflow}/dispatches`], {
    ref: 'main',
    inputs: { version: args.input, dry_run: String(args.dryRun) },
    return_run_details: true,
  });
  let runId = dispatched && dispatched.workflow_run_id;
  // Only needed when the dispatch did not answer with the run (a GitHub that
  // ignores return_run_details): the first run that was not there before.
  for (let attempt = 0; !runId && attempt < 30; attempt++) {
    const fresh = dispatchRuns().filter((r) => !before.has(r.id));
    if (fresh.length > 0) runId = Math.max(...fresh.map((r) => r.id));
    else await sleep(2000);
  }
  if (!runId)
    throw new Error('The Release run did not appear within a minute.');
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  log(`\nRelease run: ${runUrl}\n`);

  const watch = run(
    'gh',
    [
      'run',
      'watch',
      String(runId),
      '--repo',
      repo,
      '--exit-status',
      '--interval',
      '5',
    ],
    { inherit: true, allowFailure: true }
  );
  if (watch.status !== 0) {
    throw new Error(
      `The Release run did not succeed: ${runUrl}. Its annotations say why; ` +
        `\`gh run view ${runId} --repo ${repo} --log-failed\` shows the log.`
    );
  }

  // From here on a real run has pushed its branch, so a failure says how to
  // open the pull request by hand rather than leaving the branch unexplained.
  const dir = fs.mkdtempSync(path.join(tmpdir, 'nestworth-release-'));
  const download = run(
    'gh',
    [
      'run',
      'download',
      String(runId),
      '--repo',
      repo,
      '--name',
      'release-pr',
      '--dir',
      dir,
    ],
    { allowFailure: true }
  );
  if (download.status !== 0) {
    throw new Error(
      `The run succeeded, but its release-pr artifact did not download ` +
        `(${download.stderr.trim()}). Unless it was a dry run, its branch is ` +
        `pushed: open the pull request from the link in the run's summary, ${runUrl}`
    );
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(dir, 'release.json'), 'utf8')
  );
  const bodyFile = path.join(dir, 'pr-body.md');
  const manual =
    `gh pr create --repo ${repo} --base main --head ${state.branch} ` +
    `--title '${state.title}' --body-file ${bodyFile}`;

  if (state.dryRun) {
    log(fs.readFileSync(bodyFile, 'utf8'));
    log(
      `Dry run: nothing was pushed. A real run pushes ${state.branch} and then opens\n  ${manual}`
    );
    return;
  }

  const pr = run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      repo,
      '--base',
      'main',
      '--head',
      state.branch,
      '--title',
      state.title,
      '--body-file',
      bodyFile,
    ],
    { allowFailure: true }
  );
  if (pr.status !== 0) {
    throw new Error(
      `${state.branch} is pushed, but the pull request did not open ` +
        `(${pr.stderr.trim()}). Open it with the link from the run's summary:\n` +
        `  ${state.compareUrl}\nor run:\n  ${manual}`
    );
  }
  log(`
Opened ${pr.stdout.trim()}

Next:
  1. Let its checks go green, reading the whole list (Playwright included).
  2. Squash-merge it when you are ready: that is the release.
  3. Once main's Tests run is green on the merge commit, Publish release tags
     ${state.tag}, starts TestFlight for the tag and creates the GitHub Release:
     https://github.com/${repo}/actions/workflows/publish-release.yml
  4. Then, on this Mac with the screen unlocked: npm run release:desktop`);
}

module.exports = { runRelease, USAGE };

if (require.main === module) {
  defaultIo.main(() => runRelease());
}

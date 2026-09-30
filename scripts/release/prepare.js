// The Release workflow's steps (.github/workflows/release.yml), one
// subcommand per step: validate, ci, bump, body, push, summary. They share a
// state file beside the pull request body, in the directory the workflow
// uploads as the `release-pr` artifact that `npm run release` downloads.
//
// createPrepare takes the environment, the command layer (./io) and the
// checkout directory, so lib/__tests__/releasePrepare.test.ts can drive every
// step with a recording fake; run as a script, it uses the real ones.

const fs = require('fs');
const path = require('path');

const { testsVerdict } = require('./ci');
const { checkBumpDiff } = require('./commit');
const defaultIo = require('./io');
const { compareLink, composePrBody, prepareSummary } = require('./pr-body');
const { parseLsRemote, tagCommit } = require('./refs');
const { parseVersionInput, planRelease } = require('./version');

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/**
 * @param {{ env?: Record<string, string | undefined>, io?: typeof defaultIo, cwd?: string }} [deps]
 */
function createPrepare({
  env = process.env,
  io = defaultIo,
  cwd = process.cwd(),
} = {}) {
  const { annotate, appendSummary, ghApi, run } = io;
  const git = (args) => io.git(args, { cwd });
  const repo = env.GITHUB_REPOSITORY;
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const dir = path.join(env.RUNNER_TEMP || cwd, 'release-pr');
  const stateFile = path.join(dir, 'release.json');
  const bodyFile = path.join(dir, 'pr-body.md');

  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const writeState = (state) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  };
  const readJson = (file) =>
    JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));

  return {
    validate() {
      if (env.GITHUB_REF !== 'refs/heads/main') {
        throw new Error(
          `A release is prepared from main only; this run is on ${env.GITHUB_REF}.`
        );
      }
      const request = parseVersionInput(env.VERSION_INPUT);
      console.log(
        `Release request: ${request.level || request.version}` +
          (env.DRY_RUN === 'true' ? ' (dry run: nothing is pushed)' : '')
      );
    },

    ci() {
      const sha = git(['rev-parse', 'HEAD']);
      const { workflow_runs: runs } = ghApi([
        `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
      ]);
      const verdict = testsVerdict(runs, sha);
      if (!verdict.ok) throw new Error(verdict.message);
      console.log(verdict.message);
    },

    bump() {
      const input = env.VERSION_INPUT.trim();
      const refs = parseLsRemote(
        git(['ls-remote', '--heads', '--tags', 'origin'])
      );
      const plan = planRelease({
        current: readJson('package.json').version,
        input,
        tags: [...refs.tags.keys()],
        branches: [...refs.heads.keys()],
      });
      for (const warning of plan.warnings) annotate('warning', warning);

      // `npm version --no-git-tag-version` does not refuse a dirty tree.
      const dirty = git(['status', '--porcelain']);
      if (dirty) throw new Error(`The checkout is not clean: ${dirty}`);
      const baseSha = git(['rev-parse', 'HEAD']);
      git(['switch', '--create', plan.branch]);

      // npm bumps package.json and both lockfile fields; its `version` hook
      // (scripts/sync-app-version.js) mirrors the number into app.json and
      // stages it. The hook does not run under --ignore-scripts (an npmrc can
      // set that), so app.json is checked and the hook run by hand if needed.
      run('npm', ['version', input, '--no-git-tag-version'], {
        cwd,
        inherit: true,
      });
      const bumped = readJson('package.json').version;
      if (bumped !== plan.version) {
        throw new Error(
          `npm version ${input} made ${bumped}, but ${plan.version} was expected.`
        );
      }
      if (readJson('app.json').expo.version !== plan.version) {
        console.log('The version hook did not update app.json; running it.');
        run('node', ['scripts/sync-app-version.js'], { cwd, inherit: true });
        if (readJson('app.json').expo.version !== plan.version) {
          throw new Error(`app.json did not move to ${plan.version}.`);
        }
      }
      git(['add', 'package.json', 'package-lock.json', 'app.json']);
      checkBumpDiff({
        numstat: git(['diff', '--cached', '--numstat']),
        status: git(['status', '--porcelain']),
      });
      git([
        '-c',
        `user.name=${BOT_NAME}`,
        '-c',
        `user.email=${BOT_EMAIL}`,
        'commit',
        '--quiet',
        '--message',
        `chore: release ${plan.version}`,
        '--message',
        `Prepared by the Release workflow (\`${input}\`): ${runUrl}`,
      ]);
      const commitSha = git(['rev-parse', 'HEAD']);
      console.log(`${plan.branch}: ${commitSha} on ${baseSha}`);
      writeState({
        version: plan.version,
        tag: plan.tag,
        branch: plan.branch,
        title: `chore: release ${plan.version}`,
        input,
        baseSha,
        commitSha,
        previousTag: plan.previousTag,
        previousTagSha: plan.previousTag
          ? tagCommit(refs, plan.previousTag)
          : null,
        warnings: plan.warnings,
        dryRun: env.DRY_RUN === 'true',
        pushed: false,
        runUrl,
      });
    },

    body() {
      const state = readState();
      const notes = ghApi(
        ['--method', 'POST', `repos/${repo}/releases/generate-notes`],
        {
          tag_name: state.tag,
          target_commitish: state.baseSha,
          ...(state.previousTag
            ? { previous_tag_name: state.previousTag }
            : {}),
        }
      );
      const body = composePrBody({ ...state, notes: notes.body });
      fs.writeFileSync(bodyFile, body);
      const compare = compareLink({
        server,
        repo,
        branch: state.branch,
        title: state.title,
        body,
      });
      writeState({
        ...state,
        compareUrl: compare.url,
        compareWithBody: compare.withBody,
      });
      console.log(body);
    },

    // The workflow skips this step on a dry run; the step refuses as well,
    // so a dry run cannot push even if that condition is ever lost.
    push() {
      const state = readState();
      if (state.dryRun) {
        console.log(`Dry run: ${state.branch} is not pushed.`);
        return;
      }
      git([
        'push',
        'origin',
        `refs/heads/${state.branch}:refs/heads/${state.branch}`,
      ]);
      writeState({ ...state, pushed: true });
    },

    summary() {
      const state = readState();
      appendSummary(
        prepareSummary({
          ...state,
          body: fs.readFileSync(bodyFile, 'utf8'),
          compare: { url: state.compareUrl, withBody: state.compareWithBody },
        })
      );
    },
  };
}

module.exports = { createPrepare };

if (require.main === module) {
  defaultIo.main(() =>
    defaultIo.runStep(createPrepare(), process.argv[2], 'prepare.js')
  );
}

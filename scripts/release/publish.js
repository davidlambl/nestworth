// The Publish release workflow's steps (.github/workflows/publish-release.yml),
// one subcommand per step: find, tag, testflight, release, branch. `find`
// decides whether there is anything to publish and records it in a state
// file; each later step re-reads origin before acting, so any step can be
// re-run.
//
// createPublish takes the environment, the command layer (./io) and the
// checkout directory, so lib/__tests__/releasePublish.test.ts can drive every
// step with a recording fake; run as a script, it uses the real ones.

const fs = require('fs');
const path = require('path');

const { testsVerdict } = require('./ci');
const {
  releaseCommit,
  tagDecision,
  testflightDecision,
  workflowRunDecision,
} = require('./commit');
const defaultIo = require('./io');
const { readHistory } = require('./history');
const { isSha, parseLsRemote, tagCommit } = require('./refs');
const { isVersion, newerVersionTag, previousVersionTag } = require('./version');

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

const short = (sha) => sha.slice(0, 7);

/**
 * @param {{ env?: Record<string, string | undefined>, io?: typeof defaultIo, cwd?: string }} [deps]
 */
function createPublish({
  env = process.env,
  io = defaultIo,
  cwd = process.cwd(),
} = {}) {
  const { annotate, appendSummary, ghApi, setOutput } = io;
  const git = (args) => io.git(args, { cwd });
  const run = (command, args, options = {}) =>
    io.run(command, args, { cwd, ...options });
  const repo = env.GITHUB_REPOSITORY;
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const stateFile = path.join(env.RUNNER_TEMP || cwd, 'publish-release.json');

  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const writeState = (state) =>
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const originRefs = () =>
    parseLsRemote(git(['ls-remote', '--heads', '--tags', 'origin']));

  const history = readHistory({ run, git });
  const { show } = history;

  const commitFiles = (sha) => ({
    packageJson: show(`${sha}:package.json`),
    parentPackageJson: show(`${sha}^:package.json`),
    appJson: show(`${sha}:app.json`),
  });

  const onMain = (sha) =>
    run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
      allowFailure: true,
    }).status === 0;

  const releaseCommitOnMain = (version) =>
    history.releaseCommitOn('origin/main', version);

  const testsRuns = (sha) =>
    ghApi([
      `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
    ]).workflow_runs;

  // The automatic path: the Tests run that triggered this one.
  const fromWorkflowRun = () => {
    const decision = workflowRunDecision({
      conclusion: env.RUN_CONCLUSION,
      event: env.RUN_EVENT,
      headBranch: env.RUN_HEAD_BRANCH,
    });
    if (!decision.act) return { nothing: decision.reason };
    const sha = env.RUN_HEAD_SHA;
    if (!isSha(sha)) throw new Error(`"${sha}" is not a commit SHA.`);
    const verdict = releaseCommit(commitFiles(sha));
    if (!verdict.release) {
      if (verdict.warning) {
        annotate('warning', `${short(sha)}: ${verdict.reason}.`);
      }
      return {
        nothing: `${short(sha)} is not a release commit: ${verdict.reason}`,
      };
    }
    return {
      sha,
      version: verdict.version,
      trigger: `main's green Tests run, ${env.TESTS_RUN_URL}`,
    };
  };

  // A manual dispatch, from main only: an existing tag's commit (a backfill or
  // a repair), or the commit on main that moved package.json to the version
  // (a release whose automatic publish never happened), which must have a
  // green Tests run.
  const fromDispatch = (refs) => {
    if (env.GITHUB_REF !== 'refs/heads/main') {
      throw new Error(
        `Publish release is dispatched from main only; this run is on ${env.GITHUB_REF}.`
      );
    }
    const version = (env.VERSION_INPUT || '').trim();
    if (!isVersion(version)) {
      throw new Error(
        `"${env.VERSION_INPUT}" is not a release version such as 1.2.0.`
      );
    }
    const tag = `v${version}`;
    const tagged = tagCommit(refs, tag);
    if (tagged) {
      if (!onMain(tagged)) {
        throw new Error(
          `${tag} points at ${short(tagged)}, which is not on main.`
        );
      }
      const files = commitFiles(tagged);
      const pkgVersion = files.packageJson
        ? JSON.parse(files.packageJson).version
        : null;
      if (pkgVersion !== version) {
        throw new Error(
          `${tag} points at ${short(tagged)}, whose package.json says ${pkgVersion}.`
        );
      }
      const appVersion = files.appJson
        ? (JSON.parse(files.appJson).expo || {}).version
        : null;
      if (appVersion !== version) {
        annotate(
          'warning',
          `${tag}'s app.json says ${appVersion}; the tag stays as it is.`
        );
      }
      return { sha: tagged, version, trigger: 'a manual dispatch' };
    }
    const sha = releaseCommitOnMain(version);
    if (!sha) {
      throw new Error(
        `No commit on main moves package.json to ${version}, and there is no ${tag} tag.`
      );
    }
    const verdict = releaseCommit(commitFiles(sha));
    if (!verdict.release) {
      throw new Error(
        `${short(sha)} is not a release commit: ${verdict.reason}.`
      );
    }
    const ci = testsVerdict(testsRuns(sha), sha);
    if (!ci.ok) throw new Error(ci.message);
    return { sha, version, trigger: `a manual dispatch; ${ci.message}` };
  };

  return {
    find() {
      const refs = originRefs();
      const mode = env.EVENT_NAME;
      let found;
      if (mode === 'workflow_run') found = fromWorkflowRun();
      else if (mode === 'workflow_dispatch') found = fromDispatch(refs);
      else throw new Error(`Publish release does not handle ${mode} events.`);

      if (found.nothing) {
        console.log(`Nothing to publish: ${found.nothing}.`);
        setOutput('release', 'false');
        return;
      }
      const dryRun = mode === 'workflow_dispatch' && env.DRY_RUN === 'true';
      const tags = [...refs.tags.keys()];
      const previous = previousVersionTag(tags, found.version);
      const newer = newerVersionTag(tags, found.version);
      const state = {
        mode,
        sha: found.sha,
        version: found.version,
        tag: `v${found.version}`,
        previousTag: previous ? previous.tag : null,
        newerTag: newer ? newer.tag : null,
        testflight: mode === 'workflow_run' || env.TESTFLIGHT === 'true',
        dryRun,
      };
      writeState(state);
      setOutput('release', 'true');
      const subject = git(['log', '-1', '--format=%s', found.sha]);
      console.log(`Release ${state.version} at ${found.sha} (${subject})`);
      appendSummary(
        [
          `## Publish release ${state.tag}${dryRun ? ': dry run, nothing changed' : ''}`,
          '',
          `Release commit \`${short(found.sha)}\`, "${subject}". Trigger: ${found.trigger}.`,
          '',
          '',
        ].join('\n')
      );
    },

    tag() {
      const state = readState();
      const decision = tagDecision({
        tag: state.tag,
        sha: state.sha,
        tagCommit: tagCommit(originRefs(), state.tag),
      });
      if (decision.action === 'exists') {
        appendSummary(
          `- Tag: \`${state.tag}\` is already at \`${short(state.sha)}\`; left as it is.`
        );
        return;
      }
      if (state.dryRun) {
        appendSummary(
          `- Tag: would create \`${state.tag}\` at \`${short(state.sha)}\`.`
        );
        return;
      }
      git([
        '-c',
        `user.name=${BOT_NAME}`,
        '-c',
        `user.email=${BOT_EMAIL}`,
        'tag',
        '--annotate',
        state.tag,
        '--message',
        `Release ${state.version}`,
        state.sha,
      ]);
      const push = run('git', ['push', 'origin', `refs/tags/${state.tag}`], {
        allowFailure: true,
      });
      if (push.status !== 0) {
        // Someone may have pushed the same tag meanwhile; that is fine only if
        // it is at the release commit.
        const again = tagCommit(originRefs(), state.tag);
        tagDecision({ tag: state.tag, sha: state.sha, tagCommit: again });
        if (again !== state.sha) {
          throw new Error(`Pushing ${state.tag} failed: ${push.stderr.trim()}`);
        }
      }
      writeState({ ...state, tagCreated: true });
      appendSummary(
        `- Tag: created \`${state.tag}\` at \`${short(state.sha)}\` (annotated, "Release ${state.version}").`
      );
    },

    testflight() {
      const state = readState();
      // Both lookups, and only runs of this commit or this tag count: a run
      // dispatched on the tag has the tag as its head branch and the commit
      // as its head SHA.
      const byId = new Map();
      for (const query of [`head_sha=${state.sha}`, `branch=${state.tag}`]) {
        const { workflow_runs: runs } = ghApi([
          `repos/${repo}/actions/workflows/testflight.yml/runs?${query}&per_page=50`,
        ]);
        for (const r of runs) {
          if (r.head_sha === state.sha || r.head_branch === state.tag) {
            byId.set(r.id, r);
          }
        }
      }
      const decision = testflightDecision({
        event: state.mode,
        testflight: state.testflight,
        runs: [...byId.values()],
      });
      if (!decision.dispatch) {
        appendSummary(`- TestFlight: not dispatched: ${decision.reason}.`);
        return;
      }
      if (state.dryRun) {
        appendSummary(
          `- TestFlight: would dispatch \`build-and-submit\` for \`${state.tag}\` (${decision.reason}).`
        );
        return;
      }
      // The endpoint `gh workflow run` calls; return_run_details makes it
      // answer with the new run, which gh itself only prints from 2.87 on.
      const created = ghApi(
        [
          '--method',
          'POST',
          `repos/${repo}/actions/workflows/testflight.yml/dispatches`,
        ],
        {
          ref: state.tag,
          inputs: { mode: 'build-and-submit' },
          return_run_details: true,
        }
      );
      const url =
        created && created.html_url
          ? created.html_url
          : `${server}/${repo}/actions/workflows/testflight.yml`;
      appendSummary(
        `- TestFlight: dispatched \`build-and-submit\` for \`${state.tag}\` (${decision.reason}): ${url}`
      );
    },

    release() {
      const state = readState();
      const view = run(
        'gh',
        [
          'release',
          'view',
          state.tag,
          '--repo',
          repo,
          '--json',
          'url',
          '--jq',
          '.url',
        ],
        { allowFailure: true }
      );
      // A backfill, or a release commit whose Tests run finished after a
      // later one's, must not take "Latest" from the newer release.
      const latest = state.newerTag
        ? `, not marked Latest (${state.newerTag} is newer)`
        : '';
      if (view.status === 0) {
        appendSummary(
          `- GitHub Release: already exists: ${view.stdout.trim()}`
        );
      } else if (!/not found/i.test(view.stderr)) {
        throw new Error(
          `gh release view ${state.tag} failed: ${view.stderr.trim()}`
        );
      } else if (state.dryRun) {
        appendSummary(
          `- GitHub Release: would create \`${state.tag}\`, notes generated since ${state.previousTag || 'the first commit'}${latest}.`
        );
      } else {
        const args = [
          'release',
          'create',
          state.tag,
          '--repo',
          repo,
          '--verify-tag',
          '--title',
          state.tag,
          '--generate-notes',
        ];
        if (state.previousTag) {
          args.push('--notes-start-tag', state.previousTag);
        }
        if (state.newerTag) args.push('--latest=false');
        const created = run('gh', args);
        appendSummary(
          `- GitHub Release: created${latest}: ${created.stdout.trim()}`
        );
      }
    },

    // release/X.Y.Z is deleted only when its tip's tree is exactly the
    // release commit's, that is, what was merged (a squash merge, or a merge
    // commit of the up-to-date branch), so the step can never delete a
    // branch that holds anything else, whatever its name. The delete carries
    // a lease on the tip that was checked: a push landing in between keeps
    // the branch. The release is out by now, so every git call here
    // tolerates failure: a problem is a warning with its reason in the
    // summary, never a red run.
    branch() {
      const state = readState();
      const name = `release/${state.version}`;
      const ref = `refs/heads/${name}`;
      const attempt = (args) => run('git', args, { allowFailure: true });
      const why = (out) =>
        out.stderr
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' / ')
          .slice(0, 300) || `exit ${out.status}`;
      const leave = (reason) => {
        annotate('warning', `${name} was left on origin: ${reason}.`);
        appendSummary(`- Branch: \`${name}\` left as it is: ${reason}.`);
      };
      const cleanUp = () => {
        const listed = attempt(['ls-remote', '--heads', 'origin', ref]);
        if (listed.status !== 0) {
          return leave(`listing origin failed (${why(listed)})`);
        }
        const tip = parseLsRemote(listed.stdout).heads.get(name);
        if (!tip) {
          return appendSummary(`- Branch: \`${name}\` is not on origin.`);
        }
        if (attempt(['cat-file', '-e', `${tip}^{commit}`]).status !== 0) {
          const fetched = attempt(['fetch', '--no-tags', 'origin', ref]);
          if (fetched.status !== 0) {
            return leave(`fetching it failed (${why(fetched)})`);
          }
        }
        const tipTree = attempt(['rev-parse', `${tip}^{tree}`]);
        const releaseTree = attempt(['rev-parse', `${state.sha}^{tree}`]);
        for (const out of [tipTree, releaseTree]) {
          if (out.status !== 0) {
            return leave(`reading the trees failed (${why(out)})`);
          }
        }
        if (tipTree.stdout.trim() !== releaseTree.stdout.trim()) {
          return appendSummary(
            `- Branch: \`${name}\` (at \`${short(tip)}\`) is not exactly what was released; left as it is.`
          );
        }
        if (state.dryRun) {
          return appendSummary(
            `- Branch: would delete \`${name}\`; it is exactly what was released.`
          );
        }
        const deleted = attempt([
          'push',
          `--force-with-lease=${ref}:${tip}`,
          'origin',
          '--delete',
          ref,
        ]);
        if (deleted.status !== 0) {
          return leave(`origin refused the deletion (${why(deleted)})`);
        }
        return appendSummary(
          `- Branch: deleted \`${name}\`; it was exactly what was released.`
        );
      };
      cleanUp();
      // Only a release this run tagged still needs its dmg; a re-run or a
      // backfill of an old release does not.
      if (state.tagCreated) {
        appendSummary(
          '\nNext, on the Mac with the screen unlocked: `npm run release:desktop` builds, ' +
            `checks and files the notarized dmg for \`${state.tag}\`.`
        );
      }
    },
  };
}

module.exports = { createPublish };

if (require.main === module) {
  defaultIo.main(() =>
    defaultIo.runStep(createPublish(), process.argv[2], 'publish.js')
  );
}

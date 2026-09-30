// Whether main's Tests workflow passed on one commit. The Release workflow
// asks before it bumps (a release starts only from a green main), and Publish
// release asks before it tags a commit on a manual dispatch; on its automatic
// path the Tests run that triggered it is the answer.
//
// `runs` is the `workflow_runs` array of
// GET /repos/{owner}/{repo}/actions/workflows/test.yml/runs?head_sha=<sha>.
// A re-run is a new attempt of the same run, and the run object reports the
// latest attempt, so the newest push run for the commit is the verdict.
function testsVerdict(runs, sha) {
  const short = sha.slice(0, 7);
  const candidates = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.event === 'push' &&
        run.head_branch === 'main'
    )
    .sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
    );
  const run = candidates[0];
  if (!run) {
    return {
      ok: false,
      message:
        `main's Tests workflow has no run for ${short} yet. ` +
        'Wait for the push to start one and for it to pass, then try again.',
    };
  }
  if (run.status !== 'completed') {
    return {
      ok: false,
      url: run.html_url,
      message:
        `main's Tests run for ${short} is still ${run.status.replace('_', ' ')}: ` +
        `${run.html_url}. Try again once it is green.`,
    };
  }
  if (run.conclusion !== 'success') {
    return {
      ok: false,
      url: run.html_url,
      message:
        `main's Tests run for ${short} ended "${run.conclusion}": ${run.html_url}. ` +
        'A release starts only from a green main; if the failure was the ' +
        'service rather than the code, re-run the failed jobs first.',
    };
  }
  return {
    ok: true,
    url: run.html_url,
    message: `main's Tests run for ${short} passed: ${run.html_url}`,
  };
}

module.exports = { testsVerdict };

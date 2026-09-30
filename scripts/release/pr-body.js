// The release pull request's body, the link that opens it, and the Release
// workflow's job summary. The workflow cannot open the pull request itself:
// the repository does not let GitHub Actions create pull requests, and one
// opened by the workflow's token would not start the Tests run it needs. So
// the body is handed to the owner, who opens the pull request with
// `npm run release` or with one tap on the summary's link.

// GitHub answers "414 URI Too Long" somewhere above 8 KB; below this the
// link carries the body too, above it only the title.
const MAX_COMPARE_URL = 6000;

// generate-notes returns "## What's Changed" and a bullet per pull request,
// then "**Full Changelog**: …". The body gives that list its own heading, so
// the first heading goes and any other second-level heading ("New
// Contributors") drops below the body's own third level.
function tidyNotes(notes) {
  const text = String(notes || '')
    .replace(/^\s*## What's Changed[ \t]*\n/, '')
    .replace(/^## /gm, '#### ')
    .trim();
  return text;
}

function composePrBody({
  version,
  input,
  baseSha,
  previousTag,
  previousTagSha,
  notes,
  runUrl,
}) {
  const tag = `v${version}`;
  const since = previousTag
    ? `### Changes since ${previousTag}${previousTagSha ? ` (\`${previousTagSha.slice(0, 7)}\`)` : ''}`
    : '### Changes';
  let changes =
    tidyNotes(notes) ||
    `No pull requests were merged since ${previousTag || 'the first commit'}.`;
  // The notes' "Full Changelog" link compares against the new tag. It is kept
  // as it is: the merged pull request is the lasting record, and the tag link
  // works for good once the release is published, where a link to the
  // release branch would stop working when that branch is deleted.
  if (previousTag && changes.includes(`/compare/${previousTag}...${tag}`)) {
    changes += `\n\nThe Full Changelog link opens once Publish release has tagged \`${tag}\`.`;
  }
  return [
    `## Release ${version}`,
    '',
    `Version bump only: \`npm version ${input}\` on \`main\` @ \`${baseSha.slice(0, 7)}\`, ` +
      `run by the [Release workflow](${runUrl}). The \`version\` hook mirrored the ` +
      'number into `app.json`; `package.json` and both lockfile fields moved with it. ' +
      "`e2e/web/settings.spec.ts` asserts the Settings footer equals `app.json`'s " +
      "version, so this PR's Playwright job is the check that the number landed everywhere.",
    '',
    since,
    '',
    changes,
    '',
    '### After the merge (automatic)',
    '',
    "When `main`'s Tests run on the merge commit is green, the Publish release workflow:",
    '',
    `1. tags the merge commit \`${tag}\` (annotated, "Release ${version}") and pushes the tag alone;`,
    `2. dispatches \`testflight.yml\` (\`build-and-submit\`) for \`${tag}\`, so the iOS build is exactly the tagged commit;`,
    `3. creates the GitHub Release \`${tag}\`, notes only, generated from the pull requests since ${previousTag ? `\`${previousTag}\`` : 'the first commit'};`,
    `4. deletes \`release/${version}\` if it still holds exactly what was merged.`,
    '',
    'The web app deploys itself: Netlify builds `main` on the merge.',
    '',
    '### Then, on the Mac',
    '',
    `\`npm run release:desktop\` (screen unlocked), any time after the merge: it builds the ` +
      `notarized dmg of this release, from \`${tag}\` or, until Publish release has tagged it, ` +
      'from the same merge commit, in a temporary worktree, checks it (`spctl`, `stapler`, the ' +
      "bundle's version) and copies it to `~/nestworth-builds/` with its sha256.",
    '',
  ].join('\n');
}

// encodeURIComponent leaves ! ' ( ) * as they are. The link sits in a
// Markdown link in the job summary, where an unbalanced ")" in a pull
// request's title would end the link early and cut the body short.
const encodeParam = (text) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

// GitHub's "open a pull request" form, prefilled through query parameters.
function compareLink({
  server = 'https://github.com',
  repo,
  base = 'main',
  branch,
  title,
  body,
}) {
  const withTitle =
    `${server}/${repo}/compare/${base}...${branch}` +
    `?quick_pull=1&title=${encodeParam(title)}`;
  const withBody = `${withTitle}&body=${encodeParam(body)}`;
  return withBody.length <= MAX_COMPARE_URL
    ? { url: withBody, withBody: true }
    : { url: withTitle, withBody: false };
}

// A code fence longer than any run of backticks inside `text`, so the body
// can be shown raw, ready to copy, whatever it quotes.
function fenceFor(text) {
  const longest = Math.max(
    0,
    ...(String(text).match(/`+/g) || []).map((run) => run.length)
  );
  return '`'.repeat(Math.max(3, longest + 1));
}

function prepareSummary(release) {
  const { version, branch, baseSha, commitSha, title, body, compare, dryRun } =
    release;
  const warnings = release.warnings || [];
  const fence = fenceFor(body);
  const lines = [];
  if (dryRun) {
    lines.push(
      `## Release ${version}: dry run, nothing pushed`,
      '',
      `A real run pushes \`${branch}\` with one commit, \`${title}\`, made from ` +
        `\`main\` @ \`${baseSha.slice(0, 7)}\` (this run made it as \`${commitSha.slice(0, 7)}\` ` +
        'and threw it away), and links its pull request here.'
    );
  } else {
    lines.push(
      `## Release ${version}: ready for its pull request`,
      '',
      `\`${branch}\` is on origin with one commit, \`${title}\` ` +
        `(\`${commitSha.slice(0, 7)}\`), made from \`main\` @ \`${baseSha.slice(0, 7)}\`.`,
      '',
      compare.withBody
        ? `**[Open the pull request](${compare.url})**, its title and body filled in.`
        : `**[Open the pull request](${compare.url})**, its title filled in; the body is ` +
            'too long for a link, so paste it from the block below.',
      '',
      '`npm run release` opens it by itself. Merging it is the release: once ' +
        "`main`'s Tests run is green on the merge commit, Publish release tags " +
        `\`v${version}\`, starts TestFlight for the tag and creates the GitHub ` +
        'Release. Then run `npm run release:desktop` on the Mac.'
    );
  }
  for (const warning of warnings) lines.push('', `> **Warning:** ${warning}`);
  lines.push(
    '',
    '<details><summary>Pull request body</summary>',
    '',
    `${fence}markdown`,
    body.trimEnd(),
    fence,
    '',
    '</details>',
    ''
  );
  return lines.join('\n');
}

module.exports = {
  MAX_COMPARE_URL,
  tidyNotes,
  composePrBody,
  compareLink,
  fenceFor,
  prepareSummary,
};

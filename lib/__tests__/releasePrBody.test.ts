import {
  MAX_COMPARE_URL,
  compareLink,
  composePrBody,
  fenceFor,
  prepareSummary,
  tidyNotes,
} from '../../scripts/release/pr-body';

// The shape POST /repos/{owner}/{repo}/releases/generate-notes answers with.
const NOTES = [
  "## What's Changed",
  '* fix(accounts): a typed amount is read whole or refused on screen by @davidlambl in https://github.com/davidlambl/nestworth/pull/158',
  '* feat(accounts): every archived card shows Excluded by @davidlambl in https://github.com/davidlambl/nestworth/pull/157',
  '',
  '',
  '**Full Changelog**: https://github.com/davidlambl/nestworth/compare/v1.1.9...v1.1.10',
].join('\n');

const RELEASE = {
  version: '1.1.10',
  input: 'patch',
  baseSha: '62114799ff89751e81cd1091a01392cd58d8c9e0',
  previousTag: 'v1.1.9',
  previousTagSha: 'a0d8d0356968a5332c4eb00f0a3ec22877de7ce5',
  notes: NOTES,
  runUrl: 'https://github.com/davidlambl/nestworth/actions/runs/42',
};

describe('tidyNotes', () => {
  it("drops generate-notes' own heading and keeps the list", () => {
    expect(tidyNotes(NOTES)).toBe(
      NOTES.slice("## What's Changed\n".length).trim()
    );
  });

  it("puts any other heading below the body's own", () => {
    expect(
      tidyNotes(
        "## What's Changed\n* a\n\n## New Contributors\n* someone made their first contribution"
      )
    ).toBe(
      '* a\n\n#### New Contributors\n* someone made their first contribution'
    );
  });

  it('is empty for no notes', () => {
    expect(tidyNotes('')).toBe('');
    expect(tidyNotes(undefined)).toBe('');
  });
});

describe('composePrBody', () => {
  const body = composePrBody(RELEASE);

  it('follows the house release pull request, section by section', () => {
    const sections = [
      '## Release 1.1.10',
      'Version bump only: `npm version patch` on `main` @ `6211479`, run by the [Release workflow](https://github.com/davidlambl/nestworth/actions/runs/42).',
      "e2e/web/settings.spec.ts` asserts the Settings footer equals `app.json`'s version",
      '### Changes since v1.1.9 (`a0d8d03`)',
      '* fix(accounts): a typed amount is read whole',
      '**Full Changelog**: https://github.com/davidlambl/nestworth/compare/v1.1.9...v1.1.10',
      'The Full Changelog link opens once Publish release has tagged `v1.1.10`.',
      '### After the merge (automatic)',
      '1. tags the merge commit `v1.1.10` (annotated, "Release 1.1.10") and pushes the tag alone;',
      '2. dispatches `testflight.yml` (`build-and-submit`) for `v1.1.10`',
      '3. creates the GitHub Release `v1.1.10`, notes only, generated from the pull requests since `v1.1.9`;',
      '4. deletes `release/1.1.10` if it still holds exactly what was merged.',
      '### Then, on the Mac',
      '`npm run release:desktop` (screen unlocked), any time after the merge: it builds the notarized dmg of this release, from `v1.1.10` or, until Publish release has tagged it, from the same merge commit',
    ];
    let from = 0;
    for (const section of sections) {
      const at = body.indexOf(section, from);
      expect({ section, found: at >= from }).toEqual({ section, found: true });
      from = at + section.length;
    }
    expect(body).not.toContain("What's Changed");
  });

  it('says so when nothing was merged since the last release', () => {
    expect(composePrBody({ ...RELEASE, notes: '' })).toContain(
      'No pull requests were merged since v1.1.9.'
    );
  });

  it('keeps the Full Changelog link on the tag, which lasts, and says when it opens', () => {
    // The release branch is deleted after the merge, so a link to it would
    // stop working for good; the tag's opens once the release is published.
    expect(body).not.toContain('/compare/v1.1.9...release/1.1.10');
    const note =
      'The Full Changelog link opens once Publish release has tagged `v1.1.10`.';
    expect(body.split(note)).toHaveLength(2);
    // No such sentence when the notes carry no link to the new tag.
    expect(
      composePrBody({ ...RELEASE, notes: '* fix: a thing (#1)' })
    ).not.toContain('The Full Changelog link opens');
  });
});

describe('compareLink', () => {
  const link = (body: string) =>
    compareLink({
      repo: 'davidlambl/nestworth',
      branch: 'release/1.1.10',
      title: 'chore: release 1.1.10',
      body,
    });

  it('opens the pull request form with the title and body filled in', () => {
    const body = composePrBody(RELEASE);
    const { url, withBody } = link(body);
    expect(withBody).toBe(true);
    expect(
      url.startsWith(
        'https://github.com/davidlambl/nestworth/compare/main...release/1.1.10?quick_pull=1&title=chore%3A%20release%201.1.10&body='
      )
    ).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('chore: release 1.1.10');
    expect(params.get('body')).toBe(body);
  });

  it('leaves the body out when the link would be too long for GitHub', () => {
    const { url, withBody } = link('x'.repeat(MAX_COMPARE_URL));
    expect(withBody).toBe(false);
    expect(url).toBe(
      'https://github.com/davidlambl/nestworth/compare/main...release/1.1.10?quick_pull=1&title=chore%3A%20release%201.1.10'
    );
  });

  it('keeps the body in a link of exactly the limit, and not one character over', () => {
    const prefix = link('').url.length; // the link with an empty body
    const exact = link('x'.repeat(MAX_COMPARE_URL - prefix));
    expect(exact.url.length).toBe(MAX_COMPARE_URL);
    expect(exact.withBody).toBe(true);
    expect(link('x'.repeat(MAX_COMPARE_URL - prefix + 1)).withBody).toBe(false);
  });

  it('encodes what would end a Markdown link early, such as a title ending in ":)"', () => {
    const title = "chore: release 1.1.10 (it's *done* :)";
    const body = 'Fixes (one) and (two :)\n* a list item!';
    const { url } = compareLink({
      repo: 'davidlambl/nestworth',
      branch: 'release/1.1.10',
      title,
      body,
    });
    const query = url.slice(url.indexOf('?') + 1);
    expect(query).not.toMatch(/[()'*!]/);
    expect(query).toContain(
      'title=chore%3A%20release%201.1.10%20%28it%27s%20%2Adone%2A%20%3A%29'
    );
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe(title);
    expect(params.get('body')).toBe(body);
  });
});

describe('fenceFor', () => {
  it('fences with more backticks than the text holds in a row', () => {
    expect(fenceFor('plain `code` only')).toBe('```');
    expect(fenceFor('a fenced block:\n```js\nx\n```')).toBe('````');
  });
});

describe('prepareSummary', () => {
  const body = composePrBody(RELEASE);
  const base = {
    version: '1.1.10',
    branch: 'release/1.1.10',
    baseSha: RELEASE.baseSha,
    commitSha: 'b'.repeat(40),
    title: 'chore: release 1.1.10',
    body,
  };

  it('links the pull request and shows the body ready to paste', () => {
    const summary = prepareSummary({
      ...base,
      dryRun: false,
      compare: { url: 'https://example.test/compare', withBody: true },
    });
    expect(summary).toContain('## Release 1.1.10: ready for its pull request');
    expect(summary).toContain(
      '**[Open the pull request](https://example.test/compare)**, its title and body filled in.'
    );
    expect(summary).toContain(`\`\`\`markdown\n${body.trimEnd()}\n\`\`\``);
  });

  it('asks for the body to be pasted when the link could not carry it', () => {
    const summary = prepareSummary({
      ...base,
      dryRun: false,
      compare: { url: 'https://example.test/compare', withBody: false },
    });
    expect(summary).toContain('paste it from the block below');
  });

  it('offers no link on a dry run, and shows warnings', () => {
    const summary = prepareSummary({
      ...base,
      dryRun: true,
      compare: { url: 'https://example.test/compare', withBody: true },
      warnings: ['main is odd.'],
    });
    expect(summary).toContain('## Release 1.1.10: dry run, nothing pushed');
    expect(summary).not.toContain('Open the pull request');
    expect(summary).toContain('> **Warning:** main is odd.');
  });
});

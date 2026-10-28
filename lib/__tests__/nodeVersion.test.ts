// Netlify builds the web app with the Node version netlify.toml names, and CI
// tests it with the version .github/workflows/test.yml names: the two must be
// one version. When netlify.toml named none, Netlify fell back to its own
// default and every deploy preview from #13 to #44 failed. The workflows that
// run the release scripts take the same version, and package.json's
// engines.node starts at it. A bump moves them all in one change (#51).
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts); no
// dependency is added for this pin.
import { load } from 'js-yaml';

const ROOT = path.join(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The node-version of every actions/setup-node step in a workflow. */
function setupNodeVersions(workflow: string): string[] {
  const parsed = load(read(`.github/workflows/${workflow}`)) as any;
  const versions: string[] = [];
  for (const job of Object.values<any>(parsed.jobs)) {
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? '').startsWith('actions/setup-node')) {
        versions.push(String(step.with?.['node-version']));
      }
    }
  }
  return versions;
}

const netlify = read('netlify.toml').match(
  /^\s*NODE_VERSION\s*=\s*"(\d+)"\s*$/m
);
const major = netlify?.[1];

describe('one Node version for Netlify, CI and the release workflows', () => {
  it('netlify.toml names a Node major version', () => {
    expect(major).toMatch(/^\d+$/);
  });

  it('every job in test.yml that sets up Node sets up that version', () => {
    const versions = setupNodeVersions('test.yml');
    expect(versions).not.toHaveLength(0);
    expect(versions).toEqual(versions.map(() => major));
  });

  it('the Release and Publish release workflows set up that version', () => {
    expect(setupNodeVersions('release.yml')).toEqual([major]);
    expect(setupNodeVersions('publish-release.yml')).toEqual([major]);
  });

  it('rebuilds the native SQLite module before the unit tests on Netlify (#51)', () => {
    // Netlify reuses its cached node_modules, built under the Node version
    // the site had before: better-sqlite3 would still be compiled for it.
    const command = read('netlify.toml').match(
      /^\s*command\s*=\s*"(.*)"\s*$/m
    )?.[1];
    expect(command?.split(' && ')).toEqual([
      'npm rebuild better-sqlite3',
      'npm test',
      'npx expo export -p web',
    ]);
  });

  it("package.json's engines.node starts at that version", () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.engines.node).toMatch(new RegExp(`^>=${major}(\\.|$)`));
  });
});

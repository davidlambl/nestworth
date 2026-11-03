// npm runs a package's install script only once package.json's allowScripts
// has reviewed it at its exact version: npm 11.16 and later warn about an
// unreviewed one today and will refuse it in a future release, while CI's npm
// 10 (Node 22) ignores the field. So a dependency change that brings in a new
// package with a script, or moves an approved one to another version, passes
// CI unnoticed and leaves the approvals behind the lockfile (#90, #51). Every
// lockfile entry with an install script has a review at its exact version, and
// every review names one, so a stale approval fails too.
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../..');
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

describe("package.json's allowScripts", () => {
  it('reviews every package the lockfile installs with an install script, at its exact version, and nothing else', () => {
    const lock = readJson('package-lock.json');
    const withScripts = new Set<string>();
    for (const [entry, pkg] of Object.entries<any>(lock.packages)) {
      if (entry !== '' && pkg.hasInstallScript) {
        const name = entry.slice(
          entry.lastIndexOf('node_modules/') + 'node_modules/'.length
        );
        withScripts.add(`${name}@${pkg.version}`);
      }
    }
    const reviewed = Object.keys(readJson('package.json').allowScripts ?? {});
    expect([...withScripts].sort()).toEqual([...reviewed].sort());
  });
});

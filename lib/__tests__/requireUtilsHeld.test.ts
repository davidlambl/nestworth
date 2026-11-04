// The web dev server (`expo start --web`: `npm start`, and Playwright's
// webServer) evaluates the whole server bundle, @expo/router-server's
// render.js with about 1,680 modules, on every page load, through
// @expo/require-utils' evalModule and with the bundle's source map. Version
// 58.0.5 (2026-10-28, which the SDK 58.0.23 tooling requires) calls Node's
// findSourceMap() after each evaluation, which decodes the bundle's whole
// map. The server already kept about 15 MB of every page load (measured
// after a full GC); with that call it kept about 115 MB, ran out of heap
// after some 30 page loads, and PR #236's Playwright job lost it mid-run
// (#229). package.json's overrides hold the package at 58.0.4, which differs
// from 58.0.5 by that call alone. Lift the hold only for a release that no
// longer decodes the map, after measuring the dev server's heap over a few
// dozen page loads.
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const NAME = '@expo/require-utils';
const HELD = '58.0.4';

describe(`${NAME}, held at ${HELD} for the web dev server's heap`, () => {
  it('is held by an override, and the lockfile installs that one version', () => {
    expect(JSON.parse(read('package.json')).overrides?.[NAME]).toBe(HELD);
    const installed = Object.entries<any>(
      JSON.parse(read('package-lock.json')).packages
    )
      .filter(([entry]) => entry.endsWith(`node_modules/${NAME}`))
      .map(([entry, pkg]) => `${entry}@${pkg.version}`);
    expect(installed).toEqual([`node_modules/${NAME}@${HELD}`]);
  });

  it('the installed copy does not decode a source map after each evaluation', () => {
    const load = read(`node_modules/${NAME}/build/load.js`);
    expect(load.match(/^.*findSourceMap.*$/gm) ?? []).toEqual([]);
  });
});

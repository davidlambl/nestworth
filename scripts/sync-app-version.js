// npm's `version` lifecycle hook. By the time it runs, `npm version` has bumped
// package.json and the lockfile but not yet committed, and anything this stages
// goes into the same commit. app.json's expo.version is the copy the app itself
// reads (the Settings footer, EAS, the web manifest), so it is mirrored here
// rather than edited by hand.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// npm runs lifecycle hooks from the package root.
const root = process.cwd();
const { version } = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);
const appJsonPath = path.join(root, 'app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

if (appJson.expo.version !== version) {
  appJson.expo.version = version;
  // Two-space JSON with a trailing newline is exactly how Prettier keeps this file.
  fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
}
execFileSync('git', ['add', appJsonPath], { stdio: 'inherit' });
console.log(`app.json expo.version = ${version}`);

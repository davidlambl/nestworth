const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

// Babel inlines two things into the bundle at transform time that Metro's
// transform cache does not key on: app.json (the manifest behind
// Constants.expoConfig on web) and EXPO_PUBLIC_* environment variables. So a
// build from a warm cache after either changes ships the old values, e.g.
// `npm run electron:build` after editing .env.local. Folding both into
// cacheVersion invalidates the cache exactly when they change.
const inlined = crypto.createHash('sha256');
inlined.update(fs.readFileSync(path.join(__dirname, 'app.json')));
for (const key of Object.keys(process.env).sort()) {
  if (key.startsWith('EXPO_PUBLIC_')) {
    inlined.update(`\n${key}=${process.env[key]}`);
  }
}
const inlinedHash = inlined.digest('hex').slice(0, 16);
config.cacheVersion = `${config.cacheVersion}+inlined.${inlinedHash}`;

module.exports = config;

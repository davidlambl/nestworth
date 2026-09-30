// The decisions `npm run release:desktop` makes, and readers for the macOS
// tools it consults, so each verdict is a tested function rather than a grep
// in a shell line.

const { isVersion } = require('./version');

// The version to build: the one asked for, else the one main is at. Main's
// version, not the newest tag: right after a release pull request merges,
// main is at the new version while its tag waits for main's Tests run, and
// the newest tag is still the previous release.
function desktopVersion({ argVersion, mainVersion }) {
  if (argVersion) return argVersion;
  if (!isVersion(mainVersion)) {
    throw new Error(
      `main's package.json version "${mainVersion}" is not a release version such as 1.2.0.`
    );
  }
  return mainVersion;
}

// The commit to build: the tag's when origin has it; before that, the
// version's release commit on main (the newest commit that moved the version
// up to it; never a revert that moved it down). A local build needs no CI
// verdict: it ships nothing. Publish release tags that commit by itself only
// when it is main's newest version change (`latestChange`): its green Tests
// run is what Publish acts on. An older release that predates the tags, or
// one that later version changes followed, builds from it too, and is not
// promised a tag. Neither tag nor release commit means the release is not
// merged.
function desktopTarget({ version, tagCommit, releaseCommit, latestChange }) {
  const tag = `v${version}`;
  if (tagCommit) {
    return {
      sha: tagCommit,
      tagged: true,
      summary: `${tag} is tagged; building ${tagCommit.slice(0, 7)}, the commit it points at.`,
    };
  }
  if (releaseCommit) {
    const short = releaseCommit.slice(0, 7);
    return {
      sha: releaseCommit,
      tagged: false,
      summary:
        releaseCommit === latestChange
          ? `${tag} is not tagged yet; building ${short}, its release commit on main ` +
            "(Publish release tags this same commit once main's CI passes)."
          : `${tag} was never tagged; building ${short}, its release commit on main ` +
            '(later version changes on main followed it, so Publish release will not tag it by itself).',
    };
  }
  throw new Error(
    `${version} is not on main: merge its release pull request first.`
  );
}

// While the screen is locked, macOS seals the data-protection keychain that
// holds the notarytool profile, and `xcrun notarytool history` answers "No
// Keychain password item found". `ioreg -n Root -d1` then lists
// "CGSSessionScreenIsLocked"=Yes inside IOConsoleUsers (unlocked, the key is
// absent), and "IOConsoleLocked" = Yes may say the same; either is read as
// locked, so a lock is never mistaken for a lost profile.
function screenLocked(ioregText) {
  const text = String(ioregText);
  return (
    /"CGSSessionScreenIsLocked"\s*=\s*Yes\b/.test(text) ||
    /"IOConsoleLocked"\s*=\s*Yes\b/.test(text)
  );
}

// `spctl --assess --type execute -vv <app>` (it writes to stderr). A signed
// but un-notarized app is "accepted" on the Mac that built it, with
// "source=Developer ID"; only "source=Notarized Developer ID" opens anywhere.
// electron-builder skips notarization silently when it finds no credentials,
// so a green build proves nothing without this.
function notarized(spctlText) {
  const text = String(spctlText);
  return (
    /:\s*accepted\b/.test(text) && /^source=Notarized Developer ID$/m.test(text)
  );
}

// `xcrun stapler validate <app>`, given its exit status and output.
function stapled(status, text) {
  return status === 0 && /The validate action worked!/.test(String(text));
}

// electron-builder's default artifact name for the dmg target
// (${productName}-${version}-${arch}.${ext}); electron-builder.yml builds
// arm64 only.
function dmgName(version) {
  return `Nestworth-${version}-arm64.dmg`;
}

module.exports = {
  desktopVersion,
  desktopTarget,
  screenLocked,
  notarized,
  stapled,
  dmgName,
};

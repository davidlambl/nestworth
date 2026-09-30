// Readers for the macOS tools `npm run release:desktop` consults, so each
// verdict is a tested function rather than a grep in a shell line.

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

module.exports = { screenLocked, notarized, stapled, dmgName };

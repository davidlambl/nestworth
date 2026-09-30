import {
  desktopTarget,
  desktopVersion,
  dmgName,
  notarized,
  screenLocked,
  stapled,
} from '../../scripts/release/desktop';

const TAGGED = 'a0d8d03'.padEnd(40, '1');
const RELEASE = '971a355'.padEnd(40, '2');

describe('desktopVersion', () => {
  it('builds the version asked for', () => {
    expect(desktopVersion({ argVersion: '1.1.9', mainVersion: '1.2.0' })).toBe(
      '1.1.9'
    );
  });

  it("otherwise builds the version main is at, not the newest tag's", () => {
    expect(desktopVersion({ argVersion: null, mainVersion: '1.2.0' })).toBe(
      '1.2.0'
    );
  });

  it("refuses when main's version is not a release version", () => {
    expect(() =>
      desktopVersion({ argVersion: null, mainVersion: '1.2.0-beta.1' })
    ).toThrow(
      'main\'s package.json version "1.2.0-beta.1" is not a release version'
    );
  });
});

describe('desktopTarget', () => {
  const NEVER =
    '(later version changes on main followed it, so Publish release will not tag it by itself).';

  it("builds a tagged release's tag commit, and says so", () => {
    expect(
      desktopTarget({
        version: '1.1.9',
        tagCommit: TAGGED,
        releaseCommit: TAGGED,
        latestChange: RELEASE,
      })
    ).toEqual({
      sha: TAGGED,
      tagged: true,
      summary: 'v1.1.9 is tagged; building a0d8d03, the commit it points at.',
    });
  });

  it('prefers the tag to the release commit when both are known', () => {
    const other = 'b'.repeat(40);
    expect(
      desktopTarget({
        version: '1.1.9',
        tagCommit: TAGGED,
        releaseCommit: other,
        latestChange: other,
      }).sha
    ).toBe(TAGGED);
  });

  it("builds the release commit before the tag exists, and promises the tag when it is main's newest version change", () => {
    expect(
      desktopTarget({
        version: '1.2.0',
        tagCommit: null,
        releaseCommit: RELEASE,
        latestChange: RELEASE,
      })
    ).toEqual({
      sha: RELEASE,
      tagged: false,
      summary:
        'v1.2.0 is not tagged yet; building 971a355, its release commit on main ' +
        "(Publish release tags this same commit once main's CI passes).",
    });
  });

  it('promises no tag when later version changes followed the release commit', () => {
    // 1.1.1's release commit predates the tags; 1.2.1's was followed by
    // 1.2.2's bump and its revert. Publish will tag neither by itself.
    const old = '1e4fb40'.padEnd(40, '4');
    expect(
      desktopTarget({
        version: '1.1.1',
        tagCommit: null,
        releaseCommit: old,
        latestChange: RELEASE,
      }).summary
    ).toBe(
      `v1.1.1 was never tagged; building 1e4fb40, its release commit on main ${NEVER}`
    );
    const bump = '6c6bc49'.padEnd(40, '5');
    const revert = '0477103'.padEnd(40, '6');
    expect(
      desktopTarget({
        version: '1.2.1',
        tagCommit: null,
        releaseCommit: bump,
        latestChange: revert,
      }).summary
    ).toBe(
      `v1.2.1 was never tagged; building 6c6bc49, its release commit on main ${NEVER}`
    );
  });

  it('refuses a version that is neither tagged nor on main', () => {
    expect(() =>
      desktopTarget({
        version: '1.3.0',
        tagCommit: null,
        releaseCommit: null,
        latestChange: RELEASE,
      })
    ).toThrow('1.3.0 is not on main: merge its release pull request first.');
  });
});

// Abbreviated from `ioreg -n Root -d1` on the owner's Mac, unlocked.
const IOREG_UNLOCKED =
  '    | {\n' +
  '    |   "IOConsoleLocked" = No\n' +
  '    |   "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kSCSecuritySessionID"=100017,"kCGSSessionUserNameKey"="david.lambl","kCGSessionLoginDoneKey"=Yes})\n';
const IOREG_LOCKED = IOREG_UNLOCKED.replace(
  '"kCGSessionLoginDoneKey"=Yes',
  '"kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"CGSSessionScreenLockedTime"=1790000000'
);

describe('screenLocked', () => {
  it('reads the lock from ioreg', () => {
    expect(screenLocked(IOREG_UNLOCKED)).toBe(false);
    expect(screenLocked(IOREG_LOCKED)).toBe(true);
    expect(screenLocked('"CGSSessionScreenIsLocked" = No')).toBe(false);
  });

  it('also takes "IOConsoleLocked" = Yes as locked, should the other key go missing', () => {
    expect(
      screenLocked(
        IOREG_UNLOCKED.replace(
          '"IOConsoleLocked" = No',
          '"IOConsoleLocked" = Yes'
        )
      )
    ).toBe(true);
  });
});

describe('notarized', () => {
  const app = 'dist-electron/mac-arm64/Nestworth.app';

  it('accepts only an app Gatekeeper sees as notarized', () => {
    expect(
      notarized(
        `${app}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: David Lambl (P9KK9LA3ZV)\n`
      )
    ).toBe(true);
  });

  it('refuses a signed app that skipped notarization', () => {
    expect(notarized(`${app}: accepted\nsource=Developer ID\n`)).toBe(false);
    expect(
      notarized(`${app}: rejected\nsource=Unnotarized Developer ID\n`)
    ).toBe(false);
  });

  it('refuses a rejected app even when its source reads notarized', () => {
    expect(notarized(`${app}: rejected\nsource=Notarized Developer ID\n`)).toBe(
      false
    );
  });
});

describe('stapled', () => {
  it('needs both the exit status and the verdict', () => {
    expect(
      stapled(0, 'Processing: Nestworth.app\nThe validate action worked!\n')
    ).toBe(true);
    expect(
      stapled(65, 'Nestworth.app does not have a ticket stapled to it.')
    ).toBe(false);
    expect(stapled(0, '')).toBe(false);
    // The words alone are not enough: a failing exit status still fails.
    expect(stapled(1, 'The validate action worked!')).toBe(false);
  });
});

describe('dmgName', () => {
  it("is electron-builder's name for the arm64 dmg", () => {
    expect(dmgName('1.1.10')).toBe('Nestworth-1.1.10-arm64.dmg');
  });
});

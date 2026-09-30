import {
  dmgName,
  notarized,
  screenLocked,
  stapled,
} from '../../scripts/release/desktop';

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

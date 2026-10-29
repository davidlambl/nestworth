// Every screen keeps its content clear of the side insets -- iPhone Duo's rail
// -- and takes them from one place, useScreenInsets (#210). A convention check
// over the source, like iconButtonLabels.test.ts: it reads the files and
// renders nothing, so it cannot tell whether a screen pads the right view
// with them (read in review and checked on the simulator); it catches a
// screen that never reads them, the likeliest way to put content under the
// rail again.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(full);
    }
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

// The routes under app/, less the layouts (navigators, whose chrome reads the
// insets itself) and +html (the web document); and the components that fill
// the window in place of a screen.
const SCREENS = [
  ...tsxFiles(path.join(ROOT, 'app')).filter(
    (file) => !/(^|\/)(_layout|\+html)\.tsx$/.test(file)
  ),
  ...[
    'components/Onboarding.tsx',
    'components/LockScreen.tsx',
    'components/ReceiptPreview.tsx',
  ].map((file) => path.join(ROOT, file)),
];

describe('side insets (#210)', () => {
  it('every screen reads them from useScreenInsets', () => {
    const missing = SCREENS.filter(
      (file) => !fs.readFileSync(file, 'utf8').includes('useScreenInsets()')
    ).map((file) => path.relative(ROOT, file));
    expect(missing).toStrictEqual([]);
  });

  it('sees the screens it checks', () => {
    // PIN: a scan that stopped finding the routes would pass on nothing.
    // Fifteen routes and three components on the day this was written.
    expect(SCREENS.length).toBeGreaterThanOrEqual(18);
  });
});

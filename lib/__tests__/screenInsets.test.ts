// Every screen keeps its content clear of the side insets -- iPhone Duo's rail
// -- and takes them from one place, useScreenInsets (#210). A convention check
// over the source, like iconButtonLabels.test.ts: it reads the files and
// renders nothing, so it cannot tell whether a screen pads the right view
// with them (read in review and checked on the simulator); it catches a
// screen that never reads them, the likeliest way to put content under the
// rail again.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { APP_TABS } from '../tabs';

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

describe('the bottom edge under the system tab bar (#248)', () => {
  // On iOS 26 the system's tab bar floats over a tab's content on an iPhone,
  // and its height is in the bottom safe-area inset only while it runs along
  // the bottom. UIKit keeps a scroll view's last row above it when the
  // scroll view adjusts its content to the safe area ("automatic"); React
  // Native's default is "never", and react-native-screens switches only a
  // scroll view already there when the tab is first shown -- the Accounts
  // list and Reports mount after their first read. So each tab screen asks
  // for it itself, and reads no bottom inset of its own (the side insets
  // stay useScreenInsets'). A convention check over the source: the
  // simulator shows where the last row ends.
  function scrollViews(file: string): ts.JsxOpeningLikeElement[] {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const found: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ['FlatList', 'ScrollView'].includes(node.tagName.getText())
      ) {
        found.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it.each(APP_TABS.map((tab) => [tab.title, tab] as const))(
    "%s: the screen's scroll view adjusts to the safe area",
    (_title, tab) => {
      const file = path.join(ROOT, `app/(tabs)/${tab.name}/${tab.screen}.tsx`);
      const [first] = scrollViews(file);
      expect(first).toBeDefined();
      // The first scroll view in the file is the screen's own (the Accounts
      // tab's icon picker, in a sheet, comes later).
      const behaviour = first.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) &&
          p.name.getText() === 'contentInsetAdjustmentBehavior'
      );
      expect(behaviour?.initializer?.getText()).toBe('"automatic"');
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/useSafeAreaInsets/);
    }
  );
});

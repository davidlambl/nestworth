import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { getPathFromState } from 'expo-router/build/fork/getPathFromState';
import { getStateFromPath } from 'expo-router/build/fork/getStateFromPath';
import { getReactNavigationConfig } from 'expo-router/build/getReactNavigationConfig';
import { getRoutes } from 'expo-router/build/getRoutes';
import { sortRoutesWithInitial } from 'expo-router/build/sortRoutes';
import requireContext from 'expo-router/build/testing-library/require-context-ponyfill';

import { TAB_PLACEMENT, TAB_SF_SYMBOLS } from '../nativeTabs';
import { APP_TABS, appTab, tabForPath } from '../tabs';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

type RouteNode = {
  type: string;
  route: string;
  contextKey: string;
  children: RouteNode[];
};

/** The route tree Expo Router builds from app/ for one platform. */
function routeTree(platform: 'ios' | 'android' | 'web'): RouteNode {
  const tree = getRoutes(requireContext(path.join(ROOT, 'app')), {
    platform,
    internal_stripLoadRoute: true,
    ignoreEntryPoints: true,
    skipGenerated: true,
  }) as unknown as RouteNode | null;
  if (!tree) {
    throw new Error('no routes under app/');
  }
  return tree;
}

/** The linking config Expo Router derives from that tree. */
function linking(platform: 'ios' | 'android' | 'web') {
  return getReactNavigationConfig(routeTree(platform) as never, true) as never;
}

type State = { routes: { name: string; state?: State }[] };

/** The route names along a state's first branch: (tabs), the group, ... */
function branch(state: State | undefined): string[] {
  const route = state?.routes[0];
  return route ? [route.name, ...branch(route.state)] : [];
}

function child(node: RouteNode, route: string): RouteNode {
  const found = node.children.find((c) => c.route === route);
  if (!found) {
    throw new Error(`no route ${route} under ${node.contextKey}`);
  }
  return found;
}

/** A TSX file's syntax tree. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

/** Every JSX opening element named `name` in a file. */
function openings(
  source: ts.SourceFile,
  name: string
): ts.JsxOpeningLikeElement[] {
  const found: ts.JsxOpeningLikeElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The text of a JSX attribute's value: `{x}` reads `x`, "x" reads `"x"`. */
function attribute(
  element: ts.JsxOpeningLikeElement,
  name: string
): string | undefined {
  const attr = element.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText() === name
  );
  const init = attr?.initializer;
  if (!init) {
    return undefined;
  }
  return ts.isJsxExpression(init) ? init.expression?.getText() : init.getText();
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** expo-router's native tabs, by any of its entries. */
const NATIVE_TABS_ENTRY =
  /^expo-router\/(?:build\/|unstable-)?native-tabs(?:\/|$)/;

/** A module named with its platform: `./NativeAppTabs.ios`, `x.native.tsx`. */
const PLATFORM_SPECIFIER = /\.(?:ios|native|android)(?:\.[jt]sx?)?$/;

/**
 * What a source file loads of native tabs: a value import, a re-export, a
 * require() or an import() of expo-router's native tabs or of
 * lib/nativeTabs.ts (by `@/` or a relative path), of a module of the app
 * named with its platform (Metro bundles `./NativeAppTabs.ios` on web too,
 * when a module asks for it by that name), and every string literal that is
 * one of the tabs' SF Symbol names. A type-only import is erased at build
 * time and not listed.
 */
function nativeTabsLoads(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sfNames: string[] = Object.values(TAB_SF_SYMBOLS);
  const loads = (specifier: string) => {
    const target = specifier.startsWith('@/')
      ? path.join(ROOT, specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : undefined;
    return (
      NATIVE_TABS_ENTRY.test(specifier) ||
      (target !== undefined &&
        (PLATFORM_SPECIFIER.test(target) ||
          path.relative(ROOT, target).replace(/\.[jt]sx?$/, '') ===
            'lib/nativeTabs'))
    );
  };
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    } else if (ts.isStringLiteralLike(node) && sfNames.includes(node.text)) {
      found.push(`'${node.text}'`);
    }
    if (specifier !== undefined && loads(specifier)) {
      found.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('APP_TABS (#210, #248)', () => {
  it('names a route group under app/(tabs)/ for every tab, in the tab bar order', () => {
    // A tab added, renamed or dropped in app/(tabs)/ without this list
    // would leave the tab bars and the sidebar disagreeing with the routes.
    // Each tab is a group with a layout of its own (#248: on iOS its Stack)
    // and its one screen; nothing else is routed there.
    expect(APP_TABS.map((tab) => tab.name)).toStrictEqual([
      '(home)',
      '(reports)',
      '(settings)',
    ]);
    const dir = path.join(ROOT, 'app/(tabs)');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    expect(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    ).toStrictEqual(APP_TABS.map((tab) => tab.name).sort());
    expect(entries.filter((e) => e.isFile()).map((e) => e.name)).toStrictEqual([
      '_layout.tsx',
    ]);
    for (const tab of APP_TABS) {
      expect(fs.readdirSync(path.join(dir, tab.name)).sort()).toStrictEqual(
        ['_layout.tsx', `${tab.screen}.tsx`].sort()
      );
    }
  });

  it('keeps the labels and testIDs the end-to-end flows read', () => {
    // PIN: the web specs wait for the text "Accounts" and the Maestro flows
    // tap "Settings"; Maestro taps the tab buttons by these testIDs (on iOS
    // the native tab's accessibility identifier).
    expect(APP_TABS.map((tab) => tab.title)).toStrictEqual([
      'Accounts',
      'Reports',
      'Settings',
    ]);
    expect(APP_TABS.map((tab) => tab.testID)).toStrictEqual([
      'tab-accounts',
      'tab-reports',
      'tab-settings',
    ]);
  });

  it('keeps the URLs the tabs are reached by', () => {
    // PIN: Playwright goes to them, tabForPath maps them, the sidebar pushes
    // them; the groups add nothing to a URL.
    expect(APP_TABS.map((tab) => tab.path)).toStrictEqual([
      '/',
      '/reports',
      '/settings',
    ]);
  });

  it('has a tab for every tab button a Maestro flow taps', () => {
    // PIN: read from the flows themselves, so a renamed testID fails here
    // rather than on a device.
    const flowsDir = path.join(ROOT, 'e2e/mobile/flows');
    const tapped = new Set(
      fs
        .readdirSync(flowsDir)
        .filter((file) => file.endsWith('.yaml'))
        .flatMap((file) =>
          [
            ...fs
              .readFileSync(path.join(flowsDir, file), 'utf8')
              .matchAll(/id:\s*'(tab-[a-z-]+)'/g),
          ].map((match) => match[1])
        )
    );
    expect([...tapped].sort()).toStrictEqual(['tab-accounts', 'tab-settings']);
    for (const id of tapped) {
      expect(APP_TABS.map((tab) => tab.testID)).toContain(id);
    }
  });

  it('finds each tab by its name', () => {
    for (const tab of APP_TABS) {
      expect(appTab(tab.name)).toBe(tab);
    }
    expect(() => appTab('(nope)' as never)).toThrow('No tab named (nope)');
  });
});

describe('the route tree on each platform (#248)', () => {
  it.each(['ios', 'android', 'web'] as const)(
    'routes each tab to its group and its screen on %s, at its URL',
    (platform) => {
      // Route files are shared by every platform: what makes iOS draw the
      // system's tabs is in components/*.ios.tsx, never in a route file.
      const tabs = child(routeTree(platform), '(tabs)');
      expect(tabs.type).toBe('layout');
      expect(tabs.contextKey).toBe('./(tabs)/_layout.tsx');
      expect(tabs.children.map((c) => c.route).sort()).toStrictEqual(
        APP_TABS.map((tab) => tab.name).sort()
      );
      for (const tab of APP_TABS) {
        const group = child(tabs, tab.name);
        expect(group.type).toBe('layout');
        expect(group.contextKey).toBe(`./(tabs)/${tab.name}/_layout.tsx`);
        expect(group.children.map((c) => c.route)).toStrictEqual([tab.screen]);
        // The URL is the screen's, both ways: the group is not part of it.
        const config = linking(platform);
        const state = getStateFromPath(tab.path, config) as unknown as State;
        expect(branch(state)).toStrictEqual(['(tabs)', tab.name, tab.screen]);
        expect(getPathFromState(state as never, config)).toBe(tab.path);
      }
    }
  );

  it("links each JS tab button to its tab's URL", () => {
    // The JS tab bar builds a button's link from the route's name alone
    // (BottomTabBar's buildHref), and a group alone is "/": so the button
    // takes the tab's own path, the href each button had before #248.
    const config = linking('web');
    const groupAlone = {
      routes: [{ name: '(tabs)', state: { routes: [{ name: '(reports)' }] } }],
    };
    expect(getPathFromState(groupAlone as never, config)).toBe('/');
    const [button] = openings(
      parse('app/(tabs)/_layout.tsx'),
      'PlatformPressable'
    );
    expect(attribute(button, 'href')).toBe('tab.path');
  });

  it('sends a signed-in user to the Accounts tab', () => {
    // The sign-in replaces with Accounts' URL ('/(tabs)' is no longer a typed
    // href since each tab is a group), the one place it sends anyone; '/'
    // routes to (home) on every platform (the test above).
    const replaces = read('app/(auth)/sign-in.tsx').match(
      /router\.replace\([^)]*\)/g
    );
    expect(replaces).toStrictEqual(["router.replace('/')"]);
    expect(appTab('(home)').path).toBe('/');
  });

  it('has no platform-specific route file under app/', () => {
    // Measured while planning #248: a route file is found by require.context,
    // which lists every file whatever its platform, so an `.ios.tsx` route
    // is bundled into the web export with all it imports (native tabs and
    // its SF Symbols were found there). The split lives in components/.
    const platformFiles = filesUnder(path.join(ROOT, 'app'))
      .map((file) => path.relative(ROOT, file))
      .filter((file) => /\.(ios|android|native|web)\.[jt]sx?$/.test(file));
    expect(platformFiles).toStrictEqual([]);
  });

  it('starts a tab navigator given no tab on Accounts', () => {
    // Under a register opened straight from a link, and where Back returns:
    // Expo Router seeds the tabs' state from its own order of the groups
    // (createSeededNavigationState), not the tab bar's -- index and groups
    // first, then the shortest name. "(home)" keeps Accounts first; the
    // group's old name "(accounts)" puts Reports there (measured on the web
    // export: a deep link to /account/all opened over Reports).
    const tabs = child(routeTree('ios'), '(tabs)');
    const seeded = [...tabs.children]
      .sort(sortRoutesWithInitial(undefined) as never)
      .map((c) => c.route);
    expect(seeded).toStrictEqual(APP_TABS.map((tab) => tab.name));
    // An anchor would do it too, but in front of every tab opened by its
    // URL: on web, /reports then mounted the Accounts tab behind it.
    expect(read('app/(tabs)/_layout.tsx')).not.toMatch(/unstable_settings/);
  });
});

describe('the system tabs on iOS (#248)', () => {
  it('gives every tab an SF Symbol', () => {
    expect(Object.keys(TAB_SF_SYMBOLS).sort()).toStrictEqual(
      APP_TABS.map((tab) => tab.name).sort()
    );
    expect(APP_TABS.map((tab) => TAB_SF_SYMBOLS[tab.name])).toStrictEqual([
      'building.columns',
      'chart.bar',
      'gearshape',
    ]);
  });

  it("leaves the tabs' placement to the system", () => {
    // PIN: the one value judged on iPhone Duo's open display; 'sidebar' and
    // 'tabBar' are the alternatives (lib/nativeTabs.ts).
    expect(TAB_PLACEMENT).toBe('automatic');
  });

  it('draws APP_TABS, keyed by the account, behind the gates of the tabs layout', () => {
    // #177: a change of account mounts the system's tabs afresh, as it does
    // the JS tab bar; the tabs show only signed in and past onboarding.
    const native = parse('components/NativeAppTabs.ios.tsx');
    const [tabsElement] = openings(native, 'NativeTabs');
    expect(openings(native, 'NativeTabs')).toHaveLength(1);
    expect(attribute(tabsElement, 'key')).toBe('userId');
    expect(attribute(tabsElement, 'tintColor')).toBe('colors.tabIconSelected');
    expect(attribute(tabsElement, 'preferredPlacement')).toBe('TAB_PLACEMENT');
    // The app's own appearance (Settings → Appearance), not the phone's: the
    // JS tab bar drew colors.surface; the system's bar and the tabs' Stacks
    // take the host's colour scheme (react-native-screens'
    // overrideUserInterfaceStyle).
    expect(attribute(tabsElement, 'unstable_nativeProps')).toBe(
      '{ colorScheme }'
    );
    expect(native.getText()).toMatch(
      /const colorScheme = useColorScheme\(\) \?\? 'light';\s+const colors = Colors\[colorScheme\];/
    );
    expect(native.getText()).toContain('{APP_TABS.map((tab) => (');
    const [trigger] = openings(native, 'NativeTabs.Trigger');
    expect(attribute(trigger, 'name')).toBe('tab.name');
    expect(attribute(trigger, 'testID')).toBe('tab.testID');
    const [icon] = openings(native, 'NativeTabs.Trigger.Icon');
    expect(attribute(icon, 'sf')).toBe('TAB_SF_SYMBOLS[tab.name]');
    // The label: what the tab bar shows and VoiceOver reads (the rail shows
    // the icons alone).
    expect(native.getText()).toContain(
      '<NativeTabs.Trigger.Label>{tab.title}</NativeTabs.Trigger.Label>'
    );

    const layout = parse('app/(tabs)/_layout.tsx');
    const [drawn] = openings(layout, 'NativeAppTabs');
    expect(attribute(drawn, 'userId')).toBe('user.id');
    const [jsTabs] = openings(layout, 'Tabs');
    expect(attribute(jsTabs, 'key')).toBe('user.id');
    // The iOS return comes after the signed-out and onboarding returns.
    const body = layout.getText();
    const at = (text: string) => {
      const i = body.indexOf(text);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const iosReturn = at("if (Platform.OS === 'ios') {");
    expect(at('if (!user) {')).toBeLessThan(iosReturn);
    expect(at('if (showOnboarding) {')).toBeLessThan(iosReturn);
    expect(at('if (loading || showOnboarding === null) {')).toBeLessThan(
      iosReturn
    );
    // The signed-out redirect, which the iOS return relies on as the JS tab
    // bar does: a signed-out user is sent to the sign-in screen.
    expect(body).toMatch(
      /if \(!loading && !user\) \{\s*router\.replace\('\/\(auth\)\/sign-in'\);\s*\}/
    );
  });

  it('shows the sync status in the Accounts header wherever no sidebar is drawn', () => {
    // The drawn sidebar holds the sync status; without one the Accounts
    // header does. An iPad is wide but draws no sidebar (the system draws the
    // tabs), so the rule is hasDrawnSidebar, not isWideLayout -- which would
    // leave an iPad without the sync status (the review's M5).
    const text = read('app/(tabs)/(home)/index.tsx');
    expect(text).toContain('const showSyncInHeader = !hasDrawnSidebar(width);');
    // Since #249 the header's buttons come from components/HeaderActions:
    // the screen hands the rule over, and each platform's module draws the
    // dot by it -- the drawn row (web, the desktop app) and the one custom
    // item beside the native "+" (iOS).
    expect(text).toMatch(/accountsButtons\(\{\s*showSync: showSyncInHeader,/);
    expect(read('components/HeaderActions.tsx')).toMatch(
      /\{showSync \? <SyncStatusHeaderButton \/> : null\}/
    );
    expect(read('components/HeaderActions.ios.tsx')).toMatch(
      /\.\.\.\(showSync\s*\?\s*\[\{ type: 'custom' as const, element: <SyncStatusHeaderButton \/> \}\]/
    );
  });

  it("titles each tab's own Stack on iOS and declares the group's screen", () => {
    // On iOS each tab's header is its Stack's: its title is the tab's
    // (Accounts, Reports, Settings), not the route's name ("index", ...),
    // and its one screen is the group's own (appTab's `screen`).
    const source = parse('components/TabStack.ios.tsx');
    const screens = openings(source, 'Stack.Screen');
    expect(screens).toHaveLength(1);
    expect(attribute(screens[0], 'name')).toBe('screen');
    expect(attribute(screens[0], 'options')).toMatch(/^\{\s*title,/);
    expect(source.getText()).toContain(
      'const { screen, title } = appTab(tab);'
    );
  });

  it("gives every tab's header a title view on iOS, so it shows on an iPad", () => {
    // #248 fold (the lead's simulator pass): on an iPad Reports and Settings,
    // with a PLAIN title, showed no title under the top tab bar while
    // Accounts' title view did. So every tab draws a title view: Accounts
    // its own, the others TabStack's plain one. (It does not stop iOS 27's
    // bar minimisation, which moves title views too: TabStack.ios.tsx.)
    const source = parse('components/TabStack.ios.tsx');
    const text = source.getText();
    expect(text).toMatch(
      /export function TabStack\(\{\s*tab,\s*HeaderTitle = TabHeaderTitle,?\s*\}: TabStackProps\)/
    );
    const [screen] = openings(source, 'Stack.Screen');
    const options = attribute(screen, 'options') ?? '';
    // Unconditional: no tab is left to the bar's plain title.
    expect(options).toMatch(
      /^\{\s*title,\s*headerTitle: \(\{ children \}: \{ children: string \}\) => \(\s*<HeaderTitle>\{children\}<\/HeaderTitle>\s*\),\s*\}$/
    );
    // The plain title view: the type of Accounts' title, a heading for
    // VoiceOver as the bar's own title is.
    const [plain] = openings(source, 'Text');
    expect(attribute(plain, 'accessibilityRole')).toBe('"header"');
    expect(attribute(plain, 'numberOfLines')).toBe('1');
    const style = /fontSize: 17,\s*fontWeight: '600',\s*color: colors\.text/;
    expect(attribute(plain, 'style')).toMatch(style);
    expect(read('components/AccountsHeaderTitle.tsx')).toMatch(style);
  });

  it("puts each tab's own group in its layout", () => {
    // A layout naming another tab would draw that tab's title over this one.
    // Only Accounts passes a title view of its own: the app's icon beside its
    // title, on iOS in its Stack's header as the JS tab bar draws it
    // elsewhere (the other tabs take TabStack's plain one on iOS).
    for (const tab of APP_TABS) {
      const source = parse(`app/(tabs)/${tab.name}/_layout.tsx`);
      const [stack] = openings(source, 'TabStack');
      expect(openings(source, 'TabStack')).toHaveLength(1);
      expect(attribute(stack, 'tab')).toBe(`"${tab.name}"`);
      expect(attribute(stack, 'HeaderTitle')).toBe(
        tab.name === '(home)' ? 'AccountsHeaderTitle' : undefined
      );
    }
  });

  it('keeps native tabs and the SF Symbols out of the web bundle', () => {
    // Metro resolves a `.ios.tsx` module on iOS alone; any other module may
    // reach the web bundle, so none of them may load native tabs or
    // lib/nativeTabs.ts -- by `@/`, a relative path, another entry of
    // expo-router, require() or import() -- nor ask for a platform's module
    // by its name (`./NativeAppTabs.ios`), nor spell an SF Symbol's name.
    // Measured while planning #248: an import of './nativeTabs' in
    // lib/tabs.ts put the three names in the web export, with a check that
    // matched `from '@/lib/nativeTabs'` alone still green.
    const sources = ['app', 'components', 'lib']
      .flatMap((dir) => filesUnder(path.join(ROOT, dir)))
      .filter((file) => /\.[jt]sx?$/.test(file) && !file.includes('__tests__'));
    expect(sources.length).toBeGreaterThanOrEqual(90);
    const offenders = sources
      .filter((file) => !/\.(ios|native|android)\.[jt]sx?$/.test(file))
      .filter((file) => path.relative(ROOT, file) !== 'lib/nativeTabs.ts')
      .flatMap((file) =>
        nativeTabsLoads(file).map(
          (load) => `${path.relative(ROOT, file)}: ${load}`
        )
      );
    expect(offenders).toStrictEqual([]);
    // The scan is not blind: it sees what the iOS module loads, and the
    // names lib/nativeTabs.ts holds (its native-tabs import is types only).
    expect(
      nativeTabsLoads(path.join(ROOT, 'components/NativeAppTabs.ios.tsx'))
    ).toStrictEqual(['expo-router/native-tabs', '@/lib/nativeTabs']);
    expect(nativeTabsLoads(path.join(ROOT, 'lib/nativeTabs.ts'))).toStrictEqual(
      ["'building.columns'", "'chart.bar'", "'gearshape'"]
    );
    expect(read('lib/nativeTabs.ts')).toMatch(
      /^import type \{[^}]*\} from 'expo-router\/native-tabs';$/m
    );
    // ... and a module asked for by its platform's name (the review's M1:
    // components/NativeAppTabs.tsx re-exporting './NativeAppTabs.ios').
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-scan-'));
    try {
      const probe = path.join(probeDir, 'NativeAppTabs.tsx');
      fs.writeFileSync(
        probe,
        "export { NativeAppTabs } from './NativeAppTabs.ios';\n" +
          "const a = require('@/components/Thing.native');\n" +
          "import('./Other.android.tsx');\n"
      );
      expect(nativeTabsLoads(probe)).toStrictEqual([
        './NativeAppTabs.ios',
        '@/components/Thing.native',
        './Other.android.tsx',
      ]);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

describe('tabForPath (#210)', () => {
  it("finds each tab's own path", () => {
    expect(tabForPath('/')).toBe('(home)');
    expect(tabForPath('/reports')).toBe('(reports)');
    expect(tabForPath('/settings')).toBe('(settings)');
  });

  it('counts any other path as the Accounts tab', () => {
    expect(tabForPath('/account/all')).toBe('(home)');
    expect(tabForPath('/account/0b6f8a52-3c1d-4e2f-9a7b-5c4d3e2f1a0b')).toBe(
      '(home)'
    );
    expect(tabForPath('/recurring')).toBe('(home)');
    expect(tabForPath('/reports/anything')).toBe('(home)');
  });
});

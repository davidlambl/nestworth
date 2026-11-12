// Expo SDK 58 changed four defaults. This app keeps three as they were (#51)
// and takes the fourth, the transparent header on iOS 26 and later, with its
// content kept below the bar (#210), except on the root Stack's sheets from
// iOS 27, whose header is opaque (formSheets.test.ts pins
// sheetHeaderOptions). None of the four shows in a type check, a unit test
// or the web export, which all pass either way: the header is an iOS 26+
// runtime look, the anchor only silences a development warning, the splash
// layout is a native build input, and async routes on web still export a
// working app (in 23 files instead of three, which the live-bundle check of
// a deploy then reads wrong). A convention check over the source, like
// iconButtonLabels.test.ts: it reads lib/stackHeader.ts (the header rule,
// moved out of app/_layout.tsx when each tab got a Stack of its own on iOS,
// #248), the two Stacks that take it and app/_layout.tsx with the TypeScript
// compiler, and app.json as JSON, and renders nothing. Turning one of these
// on is a decision for its own change, which updates this pin with it.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The value of `name` in an object literal, if it is written out there. */
function property(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) {
      return p.initializer;
    }
  }
  return undefined;
}

/** A TSX or TS file's syntax tree. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** Every JSX opening element named `name` in a file. */
function openingsIn(
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

/** The initializer of the variable `name`, wherever it is declared. */
function initializerIn(
  source: ts.SourceFile,
  name: string
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // `{ ... } as T` reads as the object it asserts.
  return found && ts.isAsExpression(found) ? found.expression : found;
}

/** The expression a JSX attribute holds (`{x}` reads `x`). */
function attributeIn(
  element: ts.JsxOpeningLikeElement,
  name: string
): string | undefined {
  const attr = element.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText() === name
  );
  return attr?.initializer && ts.isJsxExpression(attr.initializer)
    ? attr.initializer.expression?.getText()
    : undefined;
}

describe('lib/stackHeader.ts', () => {
  const header = parse('lib/stackHeader.ts');
  const initializer = (name: string) => initializerIn(header, name);

  it('draws the system header on iOS 26 and later with the content below it, and the opaque one elsewhere', () => {
    // Since SDK 58 a native Stack header on iOS 26+ is transparent (Liquid
    // Glass) unless the screen says otherwise, and the content runs under it.
    // The app takes the transparent header there and keeps the content below
    // the bar (react-native-screens' SafeAreaView, top edge); everywhere else
    // the opaque header (#210).
    const options = initializer('screenOptions');
    expect(options && ts.isConditionalExpression(options)).toBe(true);
    const { condition, whenTrue, whenFalse } =
      options as ts.ConditionalExpression;
    expect(condition.getText()).toBe('SYSTEM_HEADER');
    expect(initializer('SYSTEM_HEADER')?.getText().replace(/\s+/g, ' ')).toBe(
      "Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26"
    );

    expect(ts.isObjectLiteralExpression(whenTrue)).toBe(true);
    const system = whenTrue as ts.ObjectLiteralExpression;
    expect(property(system, 'headerTransparent')?.kind).toBe(
      ts.SyntaxKind.TrueKeyword
    );
    expect(property(system, 'unstable_nativeProps')?.getText()).toBe(
      'CONTENT_BELOW_HEADER'
    );
    // Under the transparent bar shows the screens' own background: without
    // it a Stack nested in a tab shows the navigation theme's there, a band
    // of another grey (the folded Duo simulator, #248).
    expect(property(system, 'contentStyle')?.getText()).toBe(
      '{ backgroundColor: Colors[colorScheme].background }'
    );
    const below = initializer('CONTENT_BELOW_HEADER');
    expect(below && ts.isObjectLiteralExpression(below)).toBe(true);
    const edges = property(
      below as ts.ObjectLiteralExpression,
      'unstable_safeAreaEdges'
    );
    expect(edges?.getText().replace(/\s+/g, ' ')).toBe('{ top: true }');

    expect(ts.isObjectLiteralExpression(whenFalse)).toBe(true);
    expect(
      property(whenFalse as ts.ObjectLiteralExpression, 'headerTransparent')
        ?.kind
    ).toBe(ts.SyntaxKind.FalseKeyword);
  });

  it("is the one rule every Stack takes: the root's and, on iOS, each tab's", () => {
    // #248: the tabs' Stacks draw the same header as every pushed screen.
    const root = parse('app/_layout.tsx');
    const [rootStack] = openingsIn(root, 'Stack');
    expect(openingsIn(root, 'Stack')).toHaveLength(1);
    expect(attributeIn(rootStack, 'screenOptions')).toBe('screenOptions');
    expect(initializerIn(root, 'screenOptions')?.getText()).toBe(
      'stackScreenOptions(colorScheme)'
    );
    const tab = parse('components/TabStack.ios.tsx');
    const [tabStack] = openingsIn(tab, 'Stack');
    expect(openingsIn(tab, 'Stack')).toHaveLength(1);
    expect(attributeIn(tabStack, 'screenOptions')).toBe(
      'stackScreenOptions(colorScheme)'
    );
    // No other Stack in the app draws a header: a new one would need the
    // rule too. The sign-in screens' Stack draws none.
    const stackFiles = ['app', 'components']
      .flatMap((dir) => tsxFiles(path.join(ROOT, dir)))
      .filter(
        (file) =>
          openingsIn(parse(path.relative(ROOT, file)), 'Stack').length > 0
      )
      .map((file) => path.relative(ROOT, file))
      .sort();
    expect(stackFiles).toStrictEqual([
      'app/(auth)/_layout.tsx',
      'app/_layout.tsx',
      'components/TabStack.ios.tsx',
    ]);
    const [authStack] = openingsIn(parse('app/(auth)/_layout.tsx'), 'Stack');
    expect(attributeIn(authStack, 'screenOptions')).toBe(
      '{ headerShown: false }'
    );
  });
});

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(full);
    }
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('app/_layout.tsx', () => {
  const source = parse('app/_layout.tsx');
  const openings = (name: string) => openingsIn(source, name);
  const initializer = (name: string) => initializerIn(source, name);

  it('draws no stack header over the tabs and the sign-in screens', () => {
    // The tabs and the sign-in screens draw no stack header: they drop the
    // top edge again, or the tabs' own header would sit a status bar lower on
    // every iPhone (measured on the iOS 26.5 simulator). On iOS the tabs'
    // own header is each tab's Stack's (#248).
    const screens = openings('Stack.Screen');
    for (const group of ['(tabs)', '(auth)']) {
      const screen = screens.find((s) =>
        s.attributes.properties.some(
          (p) =>
            ts.isJsxAttribute(p) &&
            p.name.getText() === 'name' &&
            p.initializer?.getText() === `"${group}"`
        )
      );
      const opts = screen?.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) && p.name.getText() === 'options'
      );
      const value =
        opts?.initializer && ts.isJsxExpression(opts.initializer)
          ? opts.initializer.expression?.getText()
          : undefined;
      expect(value).toBe('NO_HEADER');
    }
    const none = initializer('NO_HEADER');
    expect(none && ts.isObjectLiteralExpression(none)).toBe(true);
    const noneObject = none as ts.ObjectLiteralExpression;
    expect(property(noneObject, 'headerShown')?.kind).toBe(
      ts.SyntaxKind.FalseKeyword
    );
    expect(property(noneObject, 'unstable_nativeProps')?.getText()).toBe(
      'undefined'
    );
  });

  it('anchors a deep link on the tabs through unstable_settings.anchor', () => {
    // initialRouteName still works at SDK 58 but is deprecated (a development
    // warning on every launch).
    let settings: ts.ObjectLiteralExpression | undefined;
    source.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const d of node.declarationList.declarations) {
        if (
          d.name.getText() === 'unstable_settings' &&
          d.initializer &&
          ts.isObjectLiteralExpression(d.initializer)
        ) {
          settings = d.initializer;
        }
      }
    });
    expect(settings).toBeDefined();
    const anchor = property(settings!, 'anchor');
    expect(anchor && ts.isStringLiteral(anchor) ? anchor.text : null).toBe(
      '(tabs)'
    );
    expect(property(settings!, 'initialRouteName')).toBeUndefined();
  });
});

describe('app.json', () => {
  const plugins: unknown[] = JSON.parse(read('app.json')).expo.plugins;
  const options = (name: string) =>
    plugins
      .filter((p): p is [string, Record<string, unknown>] => Array.isArray(p))
      .find(([plugin]) => plugin === name)?.[1];

  it('loads every route from the entry bundle on web (no async routes)', () => {
    expect(options('expo-router')).toEqual(
      expect.objectContaining({ asyncRoutes: { web: false } })
    );
  });

  it("keeps 1.5.0's iOS splash layout (the legacy full-screen image)", () => {
    // SDK 54 built the top-level `splash` with this flag set; the
    // expo-splash-screen plugin that holds the splash since SDK 56 defaults it
    // to false (a 100 pt image instead).
    expect(options('expo-splash-screen')).toEqual(
      expect.objectContaining({
        image: './assets/images/splash-icon.png',
        backgroundColor: '#9CB47E',
        enableFullScreenImage_legacy: true,
      })
    );
  });
});

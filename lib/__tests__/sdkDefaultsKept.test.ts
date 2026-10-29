// Expo SDK 58 changed four defaults. This app keeps three as they were (#51)
// and takes the fourth, the transparent header on iOS 26 and later, with its
// content kept below the bar (#210). None of them shows in a type check, a
// unit test or the web export, which all pass either way: the header is an
// iOS 26+ runtime look, the
// anchor only silences a development warning, the splash layout is a native
// build input, and async routes on web still export a working app (in 23
// files instead of three, which the live-bundle check of a deploy then reads
// wrong). A convention check over the source, like iconButtonLabels.test.ts:
// it reads app/_layout.tsx with the TypeScript compiler and app.json as JSON,
// and renders nothing. Turning one of these on is a decision for its own
// change, which updates this pin with it.
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

describe('app/_layout.tsx', () => {
  const source = ts.createSourceFile(
    'app/_layout.tsx',
    read('app/_layout.tsx'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  /** Every JSX opening element named `name` in the root layout. */
  function openings(name: string): ts.JsxOpeningLikeElement[] {
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
  function initializer(name: string): ts.Expression | undefined {
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

  it('draws the system header on iOS 26 and later with the content below it, and the opaque one elsewhere', () => {
    // Since SDK 58 a native Stack header on iOS 26+ is transparent (Liquid
    // Glass) unless the screen says otherwise, and the content runs under it.
    // The app takes the transparent header there and keeps the content below
    // the bar (react-native-screens' SafeAreaView, top edge); everywhere else
    // the opaque header (#210).
    const stacks = openings('Stack');
    expect(stacks).toHaveLength(1);
    const screenOptions = stacks[0].attributes.properties.find(
      (p): p is ts.JsxAttribute =>
        ts.isJsxAttribute(p) && p.name.getText() === 'screenOptions'
    );
    const expression =
      screenOptions?.initializer &&
      ts.isJsxExpression(screenOptions.initializer)
        ? screenOptions.initializer.expression
        : undefined;
    expect(expression?.getText()).toBe('screenOptions');

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
    expect(property(system, 'contentStyle')).toBeDefined();
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

    // The tabs and the sign-in screens draw no stack header: they drop the
    // top edge again, or the tabs' own header would sit a status bar lower on
    // every iPhone (measured on the iOS 26.5 simulator).
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

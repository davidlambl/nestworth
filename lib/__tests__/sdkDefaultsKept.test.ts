// Expo SDK 58 changed four defaults that this app keeps as they were (#51).
// None of them shows in a type check, a unit test or the web export, which all
// pass either way: an opaque native header is an iOS 26+ runtime look, the
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

  it('keeps the root stack headers opaque on iOS 26 and later', () => {
    // Since SDK 58 a native Stack header on iOS 26+ is transparent (Liquid
    // Glass) unless the screen says otherwise, and the content runs under it.
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
    expect(expression && ts.isObjectLiteralExpression(expression)).toBe(true);
    const transparent = property(
      expression as ts.ObjectLiteralExpression,
      'headerTransparent'
    );
    expect(transparent?.kind).toBe(ts.SyntaxKind.FalseKeyword);
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

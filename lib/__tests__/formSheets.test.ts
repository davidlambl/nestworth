// A form's last button stays on screen in the root Stack's sheets on iOS
// (New and Edit Transaction, Transfer, Import, New Recurring Rule). Two
// mechanisms put it below the sheet on the folded iPhone Duo, both measured
// in the simulator (iOS 27.1; an iPhone 17 on iOS 26.5 beside it):
// - iOS 27 minimizes a translucent navigation bar while its screen scrolls
//   (react-native-screens 4.30 asks for it: `translucent ? Automatic :
//   Never`), the safe area follows the bar, and react-native-screens'
//   safe-area view (CONTENT_BELOW_HEADER, lib/stackHeader.ts) moves the
//   form's ScrollView with it while the ScrollView keeps its offset: when the
//   bar came back at the end of a fling, the form's end was left 58 pt below
//   the sheet. From iOS 27 the sheets' header is opaque (sheetHeaderOptions),
//   which react-native-screens never minimizes.
// - The form's error line, inserted directly above the button, pushes the
//   button down by its own height while the ScrollView keeps its offset: on
//   iOS the sheet now scrolls to its end when the line appears
//   (useScrollToEndOnError).
//
// No jest test can show a bar minimizing, the pixels an opaque header draws,
// or where UIKit leaves a scroll view: that proof is the simulator's (the
// pull request's before/after table) and a device's. What this file pins:
// sheetHeaderOptions on each platform, the module loaded afresh for each (it
// reads Platform as it loads, as lib/supabase.ts reads its key in
// supabaseClient.test.ts); the hook, rendered with react-test-renderer, its
// ScrollView a host element whose instance is createNodeMock's stand-in; as a
// PIN over the source, that every sheet takes both; and, as a PIN over two
// libraries' code, the two shapes sheetHeaderOptions rests on. react-native
// is mocked down to `Platform`, a plain object each test sets, as in
// formError.test.ts: the hook reads it as it runs, the header options as they
// load. Each assertion names the mutants it kills.
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '27.1' },
}));

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import Colors from '../../constants/Colors';
import { useScrollToEndOnError } from '../hooks/useScrollToEndOnError';
import type * as StackHeader from '../stackHeader';

type MockedReactNative = {
  Platform: { OS: string; Version?: string | number };
};

const rn = jest.requireMock('react-native') as MockedReactNative;

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * lib/stackHeader.ts loaded afresh on `os` at `version` -- a string on iOS
 * ('27.1'), the API level on Android, none on web -- since it reads Platform
 * as it loads.
 */
function stackHeaderOn(
  os: string,
  version: string | number | undefined
): typeof StackHeader {
  let loaded: typeof StackHeader | undefined;
  jest.isolateModules(() => {
    // A new registry: the instance the module is about to read.
    const { Platform } = jest.requireMock('react-native') as MockedReactNative;
    Platform.OS = os;
    if (version === undefined) {
      delete Platform.Version;
    } else {
      Platform.Version = version;
    }
    loaded = jest.requireActual<typeof StackHeader>('../stackHeader');
  });
  return loaded!;
}

/** The sheets' header from iOS 27, in `scheme`. */
const opaqueHeader = (scheme: 'light' | 'dark') => ({
  headerTransparent: false,
  headerStyle: { backgroundColor: Colors[scheme].background },
  headerShadowVisible: false,
  headerTitleStyle: { color: undefined },
});

describe('sheetHeaderOptions (lib/stackHeader.ts)', () => {
  it.each([
    ['27.1', "the folded iPhone Duo simulator's"],
    ['28.0', 'a later one'],
  ])(
    "is an opaque header painted the sheet's own colour on iOS %s (%s)",
    (version) => {
      const { sheetHeaderOptions } = stackHeaderOn('ios', version);
      // Mutants: the gate read as `> 27` (iOS 27 itself left translucent);
      // headerTransparent dropped, which lets the Stack's `true` stand
      // (stackScreenOptions), or set true -- the bar minimizes again; one
      // scheme's background for both, or none (the navigation theme's card
      // colour, a band of another colour over the sheet); the shadow line
      // back; the title style dropped, emptied or given the app's text
      // colour. `{ color: undefined }` is not `{}`: native-stack takes the
      // title's colour from the style whenever the key is there (`'color'
      // in` it, useHeaderConfigProps.js, which the library PIN below reads)
      // and gives an opaque header's title the theme's text colour otherwise
      // (rgb 28,28,30 on the simulator, against the transparent bar's system
      // black). toStrictEqual tells the two apart; toEqual would not.
      expect(sheetHeaderOptions('light')).toStrictEqual(opaqueHeader('light'));
      expect(sheetHeaderOptions('dark')).toStrictEqual(opaqueHeader('dark'));
      expect(Colors.light.background).not.toBe(Colors.dark.background);
    }
  );

  it.each([
    { os: 'ios', version: '26.5', on: 'iOS 26.5 (the iPhone 17 simulator)' },
    { os: 'web', version: undefined, on: 'web and in the desktop app' },
    { os: 'android', version: 35, on: 'Android (an API level past 27)' },
  ])("leaves the Stack's own options on $on", ({ os, version }) => {
    const { sheetHeaderOptions } = stackHeaderOn(os, version);
    // Mutants: the gate read as `>= 26` (iOS 26's sheets opaque too); the
    // platform test dropped (Android's API level reads as iOS 27 and
    // later -- web has no Version, so only the Android row kills it); the
    // options returned everywhere.
    expect(sheetHeaderOptions('light')).toStrictEqual({});
    expect(sheetHeaderOptions('dark')).toStrictEqual({});
  });
});

// The hook's ScrollView: a host element whose instance is this stand-in, its
// scrollToEnd logging to `order` beside a passive effect of the same commit.
const order: string[] = [];
const scrollToEnd = jest.fn((options: { animated?: boolean }) => {
  order.push(`scroll ${JSON.stringify(options)}`);
});
const createNodeMock = () => ({ scrollToEnd });

/**
 * A sheet: its error line, the hook, and the ScrollView the hook's ref is
 * given -- or none (`attached: false`), as on the import's preview step,
 * whose line sits in the footer while the ScrollView is not mounted.
 */
function Sheet({
  message,
  attached = true,
}: {
  message: string | null;
  attached?: boolean;
}) {
  const scrollRef = useScrollToEndOnError(message);
  return createElement(
    'ScrollView',
    attached ? { ref: scrollRef } : null,
    message ? createElement('Text', null, message) : null
  );
}

/** A passive effect of the same commit, in a component before the sheet. */
function PassiveEffectBefore({ message }: { message: string | null }) {
  useEffect(() => {
    order.push(`passive effect ${message}`);
  }, [message]);
  return null;
}

describe('useScrollToEndOnError', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    rn.Platform.OS = 'ios';
    order.length = 0;
    scrollToEnd.mockClear();
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
  });

  async function show(message: string | null, attached = true) {
    const element = createElement(Sheet, { message, attached });
    await act(async () => {
      if (renderer) {
        renderer.update(element);
      } else {
        renderer = TestRenderer.create(element, { createNodeMock });
      }
    });
  }

  it('scrolls nothing while the form shows no line', async () => {
    await show(null);
    await show(null); // a re-render: a keystroke, a chip chosen
    // Mutant: the message test dropped -- a scroll to the end as the sheet
    // opens, and on every change of the message (a cleared line too).
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('scrolls to the end once, unanimated, when a line appears', async () => {
    await show(null);
    await show('Please select an account.');
    // Mutants: an empty dependency list (the effect runs at the opening
    // alone, with no line); the effect removed; the platform test turned
    // round; `animated: true` or no options (React Native animates by
    // default, so the scroll would run over several frames after the line
    // is drawn).
    expect(scrollToEnd.mock.calls).toStrictEqual([[{ animated: false }]]);
  });

  it('scrolls once more when the line changes', async () => {
    await show(null);
    await show('Please select an account.');
    await show('Please enter a payee.');
    // Mutant: keyed on whether there is a line (`[!!message]`, a latch)
    // rather than on the line: a second message of another length -- one
    // line to two -- would push the button down unscrolled.
    expect(scrollToEnd.mock.calls).toStrictEqual([
      [{ animated: false }],
      [{ animated: false }],
    ]);
  });

  it('does not scroll again for the same line on a re-render', async () => {
    await show('Please select an account.');
    await show('Please select an account.'); // set again, or a keystroke
    // Mutant: no dependency list -- a scroll on every render, which takes
    // the person to the end of the form while they type in it with the
    // line shown.
    expect(scrollToEnd.mock.calls).toStrictEqual([[{ animated: false }]]);
  });

  it('does not scroll when the line clears', async () => {
    await show('Please select an account.');
    await show(null);
    // Mutant: the message test dropped (also red in the first test).
    expect(scrollToEnd.mock.calls).toStrictEqual([[{ animated: false }]]);
  });

  it.each(['web', 'android'])('scrolls nothing on %s', async (os) => {
    // The desktop app is react-native-web: Platform.OS is 'web' there too.
    rn.Platform.OS = os;
    await show(null);
    await show('Please select an account.');
    await show('Please enter a payee.');
    // Mutant: the platform test dropped (react-native-web's scrollToEnd
    // would move the page's scroll node to its end).
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("scrolls in the commit's layout phase, before the passive effects of the same commit", async () => {
    // React runs a layout effect inside the commit that adds the line, and a
    // passive one after it, possibly in a later task (a render scheduled
    // after an await: "Transfer failed: ..."): the scroll is sent with the
    // commit. Whether UIKit then draws a frame with the button pushed down
    // is the device's to show.
    const element = (message: string | null) =>
      createElement(
        'Form',
        null,
        createElement(PassiveEffectBefore, { message }),
        createElement(Sheet, { message })
      );
    await act(async () => {
      renderer = TestRenderer.create(element(null), { createNodeMock });
    });
    order.length = 0;
    await act(async () => renderer!.update(element('Please enter a payee.')));
    // Mutant: useEffect in place of useLayoutEffect -- the sheet's effect
    // then runs after the passive effect of the component before it.
    expect(order).toStrictEqual([
      'scroll {"animated":false}',
      'passive effect Please enter a payee.',
    ]);
  });

  it("scrolls nothing, and throws nothing, with no ScrollView mounted (the import's preview step)", async () => {
    await show(null, false);
    await show('Please select at least one transaction to import.', false);
    // Mutant: `scrollRef.current!` or `.current.` for `.current?.` -- a
    // TypeError on iOS when the import's preview step shows its line.
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});

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

/** Every node under `root` that `accept` takes, in source order. */
function nodesIn<T extends ts.Node>(
  root: ts.Node,
  accept: (node: ts.Node) => node is T
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (accept(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Every JSX opening tag named `name` under `root`. */
function openingsIn(root: ts.Node, name: string): ts.JsxOpeningLikeElement[] {
  return nodesIn(
    root,
    (node): node is ts.JsxOpeningLikeElement =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === name
  );
}

/** What a JSX attribute holds: `{x}` reads `x`, "x" reads the string. */
function attributeIn(
  element: ts.JsxOpeningLikeElement,
  name: string
): ts.Expression | undefined {
  const attr = element.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText() === name
  );
  const init = attr?.initializer;
  if (init && ts.isJsxExpression(init)) {
    return init.expression;
  }
  return init && ts.isStringLiteral(init) ? init : undefined;
}

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

describe('every sheet of the root Stack takes both (PIN)', () => {
  // PIN: a convention check over the source, like headerActions.test.ts's
  // "every sheet shows Cancel"; it renders nothing. The sheets are the root
  // Stack's screens that set a `presentation` at all, read from
  // app/_layout.tsx -- 'modal' for the five, and a screen declared
  // 'pageSheet', 'formSheet' or any other presentation counts as one too --
  // so a sixth sheet added there without the sheets' header or the scroll
  // fails here. What a reading of the source cannot see: options not written
  // out as an object literal in the screen's tag. And two edits that change
  // nothing on screen fail it (sheetOptions renamed, or the call written into
  // each sheet's options): such an edit updates the pin with it.
  const layout = parse('app/_layout.tsx');
  const screens = openingsIn(layout, 'Stack.Screen').map((screen) => {
    const name = attributeIn(screen, 'name');
    const options = attributeIn(screen, 'options');
    return {
      name: name && ts.isStringLiteral(name) ? name.text : undefined,
      options:
        options && ts.isObjectLiteralExpression(options) ? options : undefined,
    };
  });
  // Mutant: a sheet read as `presentation: 'modal'` alone -- a sixth sheet
  // declared 'formSheet' or 'pageSheet' without the spread went unseen.
  const isSheet = (screen: (typeof screens)[number]) =>
    screen.options !== undefined &&
    property(screen.options, 'presentation') !== undefined;
  const sheets = screens.filter(isSheet);

  it('finds the five sheets', () => {
    expect(sheets.map((sheet) => sheet.name).sort()).toStrictEqual([
      'import',
      'recurring/new',
      'transaction/[id]',
      'transaction/new',
      'transaction/transfer',
    ]);
  });

  it("spreads the sheets' header last into every sheet's options, and into no other screen's", () => {
    // Mutants: a sheet without `...sheetOptions` (on iOS 27 its bar
    // minimizes again); the spread before a key of the screen's own that
    // would then win over it (`{ ...sheetOptions, headerTransparent: true }`);
    // a pushed screen given it, which must keep the transparent bar (an
    // opaque one left a strip of another colour above it on iPhone Duo,
    // #210); the options built from anything but sheetHeaderOptions.
    const sheetOptions = nodesIn(layout, ts.isVariableDeclaration).filter(
      (declaration) => declaration.name.getText() === 'sheetOptions'
    );
    expect(sheetOptions.map((d) => d.initializer?.getText())).toStrictEqual([
      'sheetHeaderOptions(colorScheme)',
    ]);
    const spreads = (screen: (typeof screens)[number]) => {
      const properties: readonly ts.ObjectLiteralElementLike[] =
        screen.options?.properties ?? [];
      return properties
        .filter((p): p is ts.SpreadAssignment => ts.isSpreadAssignment(p))
        .map((spread) => spread.expression.getText());
    };
    expect(
      screens.map((screen) => [screen.name, spreads(screen)])
    ).toStrictEqual(
      screens.map((screen) => [
        screen.name,
        isSheet(screen) ? ['sheetOptions'] : [],
      ])
    );
    for (const sheet of sheets) {
      const properties = sheet.options!.properties;
      expect([
        sheet.name,
        properties[properties.length - 1].getText(),
      ]).toStrictEqual([sheet.name, '...sheetOptions']);
    }
  });

  it.each(sheets.map((sheet) => `app/${sheet.name}.tsx`))(
    "%s hands useScrollToEndOnError its error line, and its form's ScrollView the ref",
    (file) => {
      // Mutants: the hook not called, or called with another value than the
      // line the form shows (null, the edit screen's gone line); the ref on
      // no ScrollView, or on one the line is not in (a row of chips); a
      // second call of the hook.
      const source = parse(file);
      const calls = nodesIn(source, ts.isVariableDeclaration).filter(
        (declaration) =>
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          declaration.initializer.expression.getText() ===
            'useScrollToEndOnError'
      );
      expect(calls).toHaveLength(1);
      const ref = calls[0].name.getText();
      const [message] = (
        calls[0].initializer as ts.CallExpression
      ).arguments.map((argument) => argument.getText());
      const scrollViews = nodesIn(source, ts.isJsxElement).filter(
        (element) =>
          element.openingElement.tagName.getText() === 'ScrollView' &&
          attributeIn(element.openingElement, 'ref')?.getText() === ref
      );
      expect(scrollViews).toHaveLength(1);
      const lines = openingsIn(scrollViews[0], 'FormError').map((line) =>
        attributeIn(line, 'message')?.getText()
      );
      expect(lines).toContain(message);
    }
  );
});

/** An installed library's file, as text. */
const library = (file: string) => read(path.join('node_modules', file));

/** A library's JavaScript file's syntax tree. */
function parseLibrary(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    library(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
}

/** The initializer of every variable named `name` in `source`. */
function initializers(source: ts.SourceFile, name: string): ts.Expression[] {
  return nodesIn(source, ts.isVariableDeclaration)
    .filter((declaration) => declaration.name.getText() === name)
    .flatMap((declaration) =>
      declaration.initializer ? [declaration.initializer] : []
    );
}

/** An expression as code: no comments, single spaces. */
function code(expression: ts.Expression): string {
  return ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Expression, expression, expression.getSourceFile())
    .replace(/\s+/g, ' ');
}

describe("the library code the sheets' header rests on (PIN)", () => {
  // PIN: reads two installed libraries' code, as requireUtilsHeld.test.ts
  // reads @expo/require-utils'; it runs none of it. sheetHeaderOptions works
  // only through these two shapes, and no other test sees them: the tests
  // above pin the options the app hands over, not what the libraries do with
  // them. An update of react-native-screens or expo-router that changes
  // either fails here, and is read, not waved through: the app would still
  // build and every other test pass while the sheets' bar minimized again or
  // their title changed colour, which only iOS 27 shows (the folded Duo
  // simulator). Update the pin after looking at the sheets there.
  const HEADER_CONFIG =
    'expo-router/build/react-navigation/native-stack/views/useHeaderConfigProps.js';

  it('react-native-screens never minimizes an opaque bar, and headerTransparent: false makes one', () => {
    // From iOS 27 react-native-screens sets a bar's minimization from its
    // translucency alone, in one statement: a translucent bar minimizes
    // while its screen scrolls, any other never does. native-stack makes a
    // bar translucent for a transparent header, a headerBackground, or a
    // search bar or large title not set opaque -- none of which a sheet has
    // -- so headerTransparent: false gives an opaque bar. Mutants: every bar
    // minimizing; the minimization set a second time in the file (a setting
    // of its own); a bar translucent whatever headerTransparent says. Each
    // lets a sheet's bar minimize on iOS 27 again, and the bar's return
    // leave the form's end 58 pt below the sheet (the folded Duo simulator).
    const config = library(
      'react-native-screens/ios/RNSScreenStackHeaderConfig.mm'
    ).replace(/\s+/g, ' ');
    expect(config).toContain(
      'minimization.minimizationBehavior = config.translucent ? UIBarMinimizationBehaviorAutomatic : UIBarMinimizationBehaviorNever; navitem.navigationBarMinimization = minimization;'
    );
    expect(
      config.match(
        /\b(?:navigationBarMinimization|UIBarMinimizationBehavior\w*)\b/g
      )
    ).toStrictEqual([
      'UIBarMinimizationBehaviorAutomatic',
      'UIBarMinimizationBehaviorNever',
      'navigationBarMinimization',
    ]);
    expect(
      initializers(parseLibrary(HEADER_CONFIG), 'translucent').map(code)
    ).toStrictEqual([
      "headerBackground != null || headerTransparent || (hasHeaderSearchBar || headerLargeTitleEnabled) && _reactnative().Platform.OS === 'ios' && headerTransparent !== false",
    ]);
  });

  it("native-stack takes the title's colour from headerTitleStyle whenever its color key is there", () => {
    // `headerTitleStyle: { color: undefined }` leaves the sheets' title in
    // the system's colour because native-stack tests the key, not its value,
    // in the style it flattens with the app's headerTitleStyle last;
    // react-native's flattenStyle copies a key whose value is undefined
    // (`for ... in`; read, not pinned). Mutants: `color != null` or `??` in
    // place of `in`; the colour taken from elsewhere when the key is there;
    // the app's style left out of what is flattened. Each turns the title
    // the navigation theme's text colour (rgb 28,28,30 on the simulator,
    // against the transparent bar's black), with nothing else to show it.
    const source = parseLibrary(HEADER_CONFIG);
    const titleColor = initializers(source, 'titleColor');
    expect(titleColor).toHaveLength(1);
    expect(ts.isConditionalExpression(titleColor[0])).toBe(true);
    const { condition, whenTrue } = titleColor[0] as ts.ConditionalExpression;
    expect([code(condition), code(whenTrue)]).toStrictEqual([
      "'color' in headerTitleStyleFlattened",
      'headerTitleStyleFlattened.color',
    ]);
    expect(
      initializers(source, 'headerTitleStyleFlattened').map(code)
    ).toStrictEqual([
      expect.stringMatching(
        /\.flatten\(\[ .*, headerTitleStyle \]\) \|\| \{\}$/
      ),
    ]);
  });
});

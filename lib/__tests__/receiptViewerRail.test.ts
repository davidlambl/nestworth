// The receipt viewer gives a photo the whole display on iPhone Duo (#251): on
// iOS, while the viewer is open, the system's vertical bar -- the rail -- is
// off and the status bar's text light, and the Close button keeps clear of
// the insets the viewer itself has, drawn only once they are the ones it will
// keep. A convention check over the source, like sdkDefaultsKept.test.ts: it
// reads components/ReceiptPreview.tsx with the TypeScript compiler and renders
// nothing. Whether the rail really goes off, the clock's colour and where
// Close lands are an iOS runtime look: the simulator's folded iPhone Duo and
// iPhone 17, and the owner's device check, show them. What this pins is the
// shape that look depends on.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const FILE = 'components/ReceiptPreview.tsx';

const source = ts.createSourceFile(
  FILE,
  fs.readFileSync(path.join(ROOT, FILE), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

const text = (node: ts.Node) => node.getText().replace(/\s+/g, ' ');

/** `node` without the parentheses prettier wraps a multi-line branch in. */
function unwrap(node: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

/** Every node in the file that `test` accepts, in source order. */
function findAll<T extends ts.Node>(
  root: ts.Node,
  test: (node: ts.Node) => node is T
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (test(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** The function component declared as `name` in the file. */
function component(name: string): ts.FunctionDeclaration {
  const found = findAll(source, ts.isFunctionDeclaration).filter(
    (f) => f.name?.text === name
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** The JSX elements named `name` (self-closing or with children). */
function elements(root: ts.Node, name: string): ts.Node[] {
  return findAll(
    root,
    (node): node is ts.JsxElement | ts.JsxSelfClosingElement =>
      (ts.isJsxElement(node) &&
        node.openingElement.tagName.getText() === name) ||
      (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === name)
  );
}

/** The conditions of the `? :` expressions `node` sits in the true branch of. */
function trueBranchConditions(node: ts.Node): string[] {
  const conditions: string[] = [];
  for (let child = node, parent = node.parent; parent;) {
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
      conditions.push(text(parent.condition));
    }
    child = parent;
    parent = parent.parent;
  }
  return conditions;
}

/** The conditions of the `? :` expressions `node` sits in the false branch of. */
function falseBranchConditions(node: ts.Node): string[] {
  const conditions: string[] = [];
  for (let child = node, parent = node.parent; parent;) {
    if (ts.isConditionalExpression(parent) && parent.whenFalse === child) {
      conditions.push(text(parent.condition));
    }
    child = parent;
    parent = parent.parent;
  }
  return conditions;
}

/** The attributes of a JSX element, as written. */
function attributes(node: ts.Node): string[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return (opening as ts.JsxSelfClosingElement).attributes.properties.map(text);
}

/** `node` is somewhere under `root`. */
function within(root: ts.Node, node: ts.Node): boolean {
  return findAll(root, (n): n is ts.Node => n === node).length === 1;
}

/** The calls of `callee` (as written) anywhere under `root`. */
function calls(root: ts.Node, callee: string): ts.CallExpression[] {
  return findAll(root, ts.isCallExpression).filter(
    (c) => c.expression.getText() === callee
  );
}

describe('the receipt viewer on iPhone Duo (#251)', () => {
  it('turns the rail off and the clock light while the photo is open, on iOS only, and gives both back', () => {
    // expo-status-bar's component, mounted while the viewer is visible: the
    // rail off (verticalBarBehaviorIOS) and the clock light over the black
    // (style) on every iPhone and iPad -- the owner's answer, 2026-11-07: in
    // light mode the clock was dark on the black viewer, unreadable on a
    // standard iPhone too. Unmounting it gives both back as they were: React
    // Native's StatusBar pops its entry (the style back to 'default') and
    // expo-status-bar's stack falls back to 'automatic'. A setter would stay
    // set, and expo-status-bar's setStyle cannot name 'default'.
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map(text)
      .filter((line) => /StatusBar/.test(line));
    expect(imports).toStrictEqual([
      "import { StatusBar, useVerticalBarEdgeIOS } from 'expo-status-bar';",
    ]);
    const bars = elements(source, 'StatusBar');
    expect(bars).toHaveLength(1);
    expect(attributes(bars[0])).toStrictEqual([
      'style="light"',
      'animated',
      'verticalBarBehaviorIOS="disabled"',
    ]);
    // No setter anywhere: nothing outlives the viewer.
    expect(
      findAll(source, ts.isCallExpression)
        .map((c) => c.expression.getText())
        .filter((callee) => callee.startsWith('StatusBar.'))
    ).toStrictEqual([]);

    // Mounted by the viewer alone, only while it is visible, only on iOS.
    expect(within(component('ReceiptViewer'), bars[0])).toBe(true);
    expect(trueBranchConditions(bars[0])).toStrictEqual([
      'visible',
      "Platform.OS === 'ios'",
    ]);
  });

  it("places Close by the viewer's own insets on iOS: a provider inside the Modal", () => {
    // The app's provider measures the screens under the viewer; inside the
    // Modal a provider of its own measures the viewer's view, whatever the
    // rail does to the screens beneath.
    const viewer = component('ReceiptViewer');
    expect(calls(viewer, 'useSafeAreaInsets').map(text)).toStrictEqual([]);
    expect(calls(viewer, 'useScreenInsets').map(text)).toStrictEqual([]);

    const providers = elements(viewer, 'SafeAreaProvider');
    expect(providers).toHaveLength(1);
    const modals = elements(viewer, 'Modal');
    expect(modals).toHaveLength(1);
    expect(within(modals[0], providers[0])).toBe(true);
    expect(trueBranchConditions(providers[0])).toStrictEqual([
      "Platform.OS === 'ios'",
    ]);
    // The iOS body inside it, and the plain body alone elsewhere.
    const frames = elements(source, 'ReceiptViewerFrameIOS');
    expect(frames.map(text)).toStrictEqual([
      '<ReceiptViewerFrameIOS {...body} />',
    ]);
    expect(within(providers[0], frames[0])).toBe(true);
    let branch: ts.Node = providers[0];
    while (ts.isParenthesizedExpression(branch.parent)) {
      branch = branch.parent;
    }
    const choice = branch.parent;
    expect(
      ts.isConditionalExpression(choice) && text(unwrap(choice.whenFalse))
    ).toBe('<ReceiptViewerBody {...body} />');

    const body = component('ReceiptViewerBody');
    expect(calls(body, 'useSafeAreaInsets')).toHaveLength(1);
    expect(calls(body, 'useScreenInsets')).toHaveLength(1);
    expect(elements(body, 'TouchableOpacity')).toHaveLength(1);
  });

  it("draws Close only once the viewer's insets are the ones it keeps, and a tap closes meanwhile", () => {
    // On iPhone Duo the rail goes off a moment after the photo appears; Close
    // drawn before that sat at the rail's place and jumped, and a tap there
    // missed (the lead's simulator pass, 2026-11-06). With the rail off the
    // status bar runs across the top, so the viewer's own top inset is the
    // sign; where there is no vertical bar Close is there from the start.
    const frame = component('ReceiptViewerFrameIOS');
    expect(calls(frame, 'useVerticalBarEdgeIOS')).toHaveLength(1);
    expect(calls(frame, 'useSafeAreaInsets')).toHaveLength(1);
    const shown = findAll(frame, ts.isVariableDeclaration).filter(
      (d) => d.name.getText() === 'closeShown'
    );
    expect(
      shown.map((d) => d.initializer && text(d.initializer))
    ).toStrictEqual(['edge === null || top > 0']);
    // The body is told, and draws its Close only then.
    expect(
      elements(frame, 'ReceiptViewerBody').map((b) => attributes(b))
    ).toStrictEqual([['{...props}', 'closeShown={closeShown}']]);
    const body = component('ReceiptViewerBody');
    const parameter = body.parameters[0].name;
    expect(
      ts.isObjectBindingPattern(parameter) &&
        parameter.elements
          .filter((e) => e.name.getText() === 'closeShown')
          .map(text)
    ).toStrictEqual(['closeShown = true']);
    const [close] = elements(body, 'TouchableOpacity');
    expect(trueBranchConditions(close)).toStrictEqual(['closeShown']);

    // Meanwhile a tap anywhere on the viewer closes it: never a viewer
    // without a way out, whatever the insets do.
    const taps = elements(frame, 'Pressable');
    expect(taps).toHaveLength(1);
    expect(falseBranchConditions(taps[0])).toStrictEqual(['closeShown']);
    expect(trueBranchConditions(taps[0])).toStrictEqual([]);
    expect(attributes(taps[0])).toStrictEqual([
      'testID={`${props.testIDPrefix}-receipt-close-anywhere`}',
      'accessibilityRole="button"',
      'accessibilityLabel="Close receipt"',
      'onPress={props.onClose}',
      'style={StyleSheet.absoluteFill}',
    ]);
    // ...and drawn OVER the body: a sibling after it in the same fragment.
    // Before it, the body's black view would lie on top and take every
    // touch, and the window before Close appears would have no way out.
    const [frameBody] = elements(frame, 'ReceiptViewerBody');
    const fragment = frameBody.parent;
    expect(ts.isJsxFragment(fragment)).toBe(true);
    const order = (fragment as ts.JsxFragment).children
      .filter((child) => !ts.isJsxText(child))
      .map((child) =>
        child === frameBody ? 'body' : within(child, taps[0]) ? 'tap' : '?'
      );
    expect(order).toStrictEqual(['body', 'tap']);
  });

  it('is the only code in the app that sets the vertical bar', () => {
    // A mounted <StatusBar verticalBarBehaviorIOS=…> anywhere decides with
    // the viewer's ("the most recently mounted one applies"), and a setter
    // elsewhere is the fallback under it: change both together.
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === '__tests__' ? [] : files(full);
        }
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
      });
    const setters = ['app', 'components', 'lib']
      .flatMap((dir) => files(path.join(ROOT, dir)))
      .filter((file) =>
        /verticalbarbehaviorios/i.test(fs.readFileSync(file, 'utf8'))
      )
      .map((file) => path.relative(ROOT, file));
    expect(setters).toStrictEqual([FILE]);
  });
});

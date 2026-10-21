// A control whose only content is an icon says nothing to a screen reader
// unless it is given words (#38): VoiceOver reads an icon font's glyph as
// nothing useful, and react-native-web renders a TouchableOpacity as a
// role-less div with no name. So every pressable in app/ and components/ with
// no Text inside it carries an accessibilityLabel (what it does: "New
// transaction", never "Plus") and an accessibilityRole.
//
// A convention check over the source, like a lint rule: it reads the TSX with
// the TypeScript compiler and renders nothing. It cannot tell whether a label
// is right (an expression is taken on trust), or see a control that is
// icon-only only some of the time (the collapsed sidebar's): those are read in
// review and checked with a screen reader.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const PRESSABLES = new Set([
  'Pressable',
  'TouchableHighlight',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
]);

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;
type Attributes = Map<string, ts.JsxAttribute>;

function isJsx(node: ts.Node): node is Jsx {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagName(node: Jsx): string {
  return (
    ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName
  ).getText();
}

function attributesOf(node: Jsx): Attributes {
  const { properties } = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
  return new Map(
    properties.flatMap((p): [string, ts.JsxAttribute][] =>
      ts.isJsxAttribute(p) ? [[p.name.getText(), p]] : []
    )
  );
}

function containsText(node: ts.Node): boolean {
  return (
    ts.forEachChild(node, (child) =>
      (isJsx(child) && tagName(child) === 'Text') || containsText(child)
        ? true
        : undefined
    ) === true
  );
}

/** The pressables in one file that have no Text inside them. */
function iconOnlyPressables(
  file: string,
  text = fs.readFileSync(file, 'utf8')
): { line: number; tag: string; attributes: Attributes }[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: { line: number; tag: string; attributes: Attributes }[] = [];
  const visit = (node: ts.Node) => {
    if (isJsx(node) && PRESSABLES.has(tagName(node)) && !containsText(node)) {
      found.push({
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        tag: tagName(node),
        attributes: attributesOf(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Roles that are no role.
const NO_ROLE = ['none', 'presentation'];

/**
 * Whether the pressable has the attribute and it says something: not an
 * empty string, `undefined` or `null`, nor one of `nothing`. Any other
 * expression is taken on trust.
 */
function says(a: Attributes, name: string, nothing: string[] = []): boolean {
  const initializer = a.get(name)?.initializer;
  const value =
    initializer !== undefined && ts.isJsxExpression(initializer)
      ? initializer.expression
      : initializer;
  if (value === undefined) {
    return false;
  }
  if (ts.isStringLiteralLike(value)) {
    return value.text.trim() !== '' && !nothing.includes(value.text);
  }
  return !(
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === 'undefined')
  );
}

/**
 * Whether a pressable lacks words a screen reader can say or a role: a label
 * (`accessibilityLabel` or `aria-label`; a testID is not one) and a role
 * (`accessibilityRole` or `role`) are both needed.
 */
function lacksLabelOrRole(a: Attributes): boolean {
  return (
    !(says(a, 'accessibilityLabel') || says(a, 'aria-label')) ||
    !(says(a, 'accessibilityRole', NO_ROLE) || says(a, 'role', NO_ROLE))
  );
}

/** The lines of a snippet's icon-only pressables that the rule flags. */
function flaggedLines(snippet: string): number[] {
  return iconOnlyPressables('snippet.tsx', snippet)
    .filter(({ attributes }) => lacksLabelOrRole(attributes))
    .map(({ line }) => line);
}

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(full);
    }
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('icon-only controls (#38)', () => {
  it('every pressable with no text inside has an accessibility label and role', () => {
    const unlabelled = ['app', 'components']
      .flatMap((dir) => tsxFiles(path.join(ROOT, dir)))
      .flatMap((file) =>
        iconOnlyPressables(file)
          .filter(({ attributes }) => lacksLabelOrRole(attributes))
          .map(
            ({ line, tag }) => `${path.relative(ROOT, file)}:${line} <${tag}>`
          )
      );

    expect(unlabelled).toStrictEqual([]);
  });

  it('sees the icon-only controls it checks', () => {
    // PIN: the register's transfer and "+" buttons and each row's cleared box
    // are icon-only. A scan that stopped seeing them (a renamed component, a
    // file moved) would make the check above pass on nothing. At least three:
    // one more there, labelled, is no reason for this to fail.
    expect(
      iconOnlyPressables(path.join(ROOT, 'app/account/[id].tsx')).length
    ).toBeGreaterThanOrEqual(3);
  });

  it('asks for a label and a role, and takes no testID for a label', () => {
    // PIN: the rule itself, on a snippet. Most controls here carry a testID,
    // so a check that took one for a label, or settled for a label or a role
    // alone, would pass the first test with controls a screen reader still
    // cannot name. A pressable with Text inside is not icon-only.
    const snippet = [
      '<TouchableOpacity testID="a" accessibilityRole="button"><FontAwesome name="plus" /></TouchableOpacity>;',
      '<Pressable accessibilityLabel="New account"><FontAwesome name="plus" /></Pressable>;',
      '<TouchableOpacity accessibilityRole="button" accessibilityLabel="New account"><FontAwesome name="plus" /></TouchableOpacity>;',
      '<Pressable role="button" aria-label="New account"><FontAwesome name="plus" /></Pressable>;',
      '<TouchableOpacity testID="b"><Text>Save</Text></TouchableOpacity>;',
    ].join('\n');
    expect(flaggedLines(snippet)).toStrictEqual([1, 2]);
  });

  it('takes no empty or undefined label, and no role of none', () => {
    // PIN: an empty or undefined label names nothing, and a role of "none" is
    // no role, so a screen reader would still meet a control it cannot name.
    // A label or role that is any other expression is taken on trust.
    const snippet = [
      '<Pressable accessibilityRole="button" accessibilityLabel=""><FontAwesome name="plus" /></Pressable>;',
      '<Pressable accessibilityRole="button" accessibilityLabel={undefined}><FontAwesome name="plus" /></Pressable>;',
      '<Pressable accessibilityRole="none" accessibilityLabel="New account"><FontAwesome name="plus" /></Pressable>;',
      '<Pressable role="button" aria-label={label}><FontAwesome name="plus" /></Pressable>;',
    ].join('\n');
    expect(flaggedLines(snippet)).toStrictEqual([1, 2, 3]);
  });
});

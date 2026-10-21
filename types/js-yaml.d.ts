// `js-yaml` is in the tree through jest's own coverage tooling and eslint, and
// ships no types; `@types/js-yaml` is not a dependency here. This declares the
// one function lib/__tests__/receiptSweepWorkflow.test.ts uses to read the
// sweep's workflow file, rather than pulling in a dependency for one test.
// It is a phantom dependency: not in package.json, the import resolves to the
// copy hoisted for jest's coverage tooling (3.15.1, from
// @istanbuljs/load-nyc-config), so an Expo or jest upgrade (#51) that stops
// hoisting it turns that test into "Cannot find module 'js-yaml'": add js-yaml
// as a devDependency then.
declare module 'js-yaml' {
  export function load(text: string): unknown;
}

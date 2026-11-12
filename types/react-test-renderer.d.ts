// `react-test-renderer` ships no types and `@types/react-test-renderer` is not a
// dependency here, so a test that renders a hook would otherwise fail
// `tsc --noEmit` under `strict`. This declares only what the suites that
// render actually use (realtimeWiring.test.ts and syncEngineKeying.test.ts
// first; saveOnceForms.test.ts reads the rendered tree, `root`), in the shape
// of the typed package, rather than pulling in a dependency for a few tests.
// Delete it if the typed package is ever added.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  /** A node of the rendered tree: its props, its place, a search below it. */
  export interface ReactTestInstance {
    props: { [propName: string]: any };
    parent: null | ReactTestInstance;
    children: (ReactTestInstance | string)[];
    findAll(
      predicate: (node: ReactTestInstance) => boolean
    ): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    update(element: ReactElement): void;
    unmount(): void;
  }

  export function act(callback: () => void | Promise<void>): Promise<void>;

  const TestRenderer: {
    create(
      element: ReactElement,
      options?: {
        /** What a host element's ref receives (null without it). */
        createNodeMock(element: ReactElement): unknown;
      }
    ): ReactTestRenderer;
  };
  export default TestRenderer;
}

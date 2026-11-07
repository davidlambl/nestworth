// `react-test-renderer` ships no types and `@types/react-test-renderer` is not a
// dependency here, so a test that renders a hook would otherwise fail
// `tsc --noEmit` under `strict`. This declares only what
// lib/__tests__/realtimeWiring.test.ts and syncEngineKeying.test.ts actually
// use, and the search of the rendered tree receiptViewerClock.test.ts makes
// (`root`), rather than pulling in a dependency for these tests. Delete it if
// the typed package is ever added.
declare module 'react-test-renderer' {
  import type { ElementType, ReactElement } from 'react';

  export interface ReactTestInstance {
    props: { [propName: string]: any };
    findAll(
      predicate: (node: ReactTestInstance) => boolean
    ): ReactTestInstance[];
    findAllByType(type: ElementType): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    update(element: ReactElement): void;
    unmount(): void;
    root: ReactTestInstance;
  }

  export function act(callback: () => void | Promise<void>): Promise<void>;

  const TestRenderer: {
    create(element: ReactElement): ReactTestRenderer;
  };
  export default TestRenderer;
}

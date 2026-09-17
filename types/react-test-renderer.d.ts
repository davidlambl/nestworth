// `react-test-renderer` ships no types and `@types/react-test-renderer` is not a
// dependency here, so a test that renders a hook would otherwise fail
// `tsc --noEmit` under `strict`. This declares only what
// lib/__tests__/realtimeWiring.test.ts and syncEngineKeying.test.ts actually
// use, rather than pulling in a dependency for two tests. Delete it if the
// typed package is ever added.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface ReactTestRenderer {
    update(element: ReactElement): void;
    unmount(): void;
  }

  export function act(callback: () => void | Promise<void>): Promise<void>;

  const TestRenderer: {
    create(element: ReactElement): ReactTestRenderer;
  };
  export default TestRenderer;
}

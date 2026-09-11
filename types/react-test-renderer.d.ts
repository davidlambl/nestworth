// `react-test-renderer` ships no types and `@types/react-test-renderer` is not a
// dependency here, so a test that renders a hook would otherwise fail
// `tsc --noEmit` under `strict`. This declares only the two entry points
// lib/__tests__/realtimeWiring.test.ts actually uses, rather than pulling in a
// dependency for one test. Delete it if the typed package is ever added.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export function act(callback: () => void | Promise<void>): Promise<void>;

  const TestRenderer: {
    create(element: ReactElement): { unmount(): void };
  };
  export default TestRenderer;
}

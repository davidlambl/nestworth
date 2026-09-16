import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';

// Console lines the app writes for exactly this purpose: the sync engine, the
// mutation cache, auth events and the online state. Forwarded to the runner's
// stdout so an attempt without a trace still tells the story of what the app
// did — CI keeps traces only for failed attempts, and a passing retry after a
// red attempt is often the more interesting one.
const FORWARDED = /^\[(sync|mutation|query|auth|status|accounts|realtime)\]/;

export const test = base.extend({
  page: async ({ page }, provide) => {
    page.on('console', (msg) => {
      const text = msg.text();
      if (FORWARDED.test(text)) {
        console.log(`[browser:${msg.type()}] ${text}`);
      }
    });
    page.on('pageerror', (err) => {
      console.log(`[browser:pageerror] ${err.message}`);
    });
    await provide(page);
  },
});

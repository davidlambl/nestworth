import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { e2eTarget, localApp } from './e2e/web/helpers/local-stack';

const AUTH_FILE = path.join(__dirname, 'e2e', 'web', '.auth', 'user.json');

// The two targets (#221, e2e/web/helpers/local-stack.ts). By default the
// specs run against the local Supabase stack (`npx supabase start` first),
// each run as a user of its own, on a dev server of their own on :8082 built
// with the stack's URL and publishable key, so a dev server already on :8081
// (`npm run web`, pointed at the hosted project by .env.local) is never the
// one tested. E2E_TARGET=hosted runs them against the shared e2e user on the
// hosted project on :8081, reusing a running dev server outside CI, as before.
const local = e2eTarget() === 'local' ? localApp() : undefined;
const PORT = local ? 8082 : 8081;
const BASE_URL = `http://localhost:${PORT}`;

// NOTE on WebKit coverage:
// The unauthenticated specs run on both Desktop Chrome and iPhone 15 Pro (WebKit) to
// exercise the sign-in/sign-up screens across engines.
//
// The authenticated specs currently run only on Desktop Chrome because the app has
// two known WebKit-specific issues that prevent authenticated flows from working:
//   1. React Native Web Modal components (e.g. "New Account") don't render in WebKit.
//   2. expo-sqlite's WASM/IndexedDB storage path throws "UnknownError" in WebKit,
//      surfacing an error overlay that blocks all interactions.
// Native iOS (real WebKit) is fully covered by the Maestro suite in e2e/mobile/flows/.
// If the app is ever fixed to work on web-WebKit, add a `webkit-mobile` project mirroring
// the `chromium` project below to extend authenticated coverage.

export default defineConfig({
  testDir: './e2e/web',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CI retries a failed test once (#75). A one-off failure on a loaded runner
  // passes its retry and is reported as `flaky`: read the failed attempt's
  // trace. Only a test that fails both attempts turns the job red; a race that
  // fails once still shows only as `flaky`, as #69's and #85's races did.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './e2e/web/global-setup.ts',
  // Specs now wait for their deletes to be pushed before returning; on a slow
  // runner that can push a spec past Playwright's 30 s default, which would
  // report a timeout instead of the helper's own message.
  timeout: 60_000,

  use: {
    baseURL: BASE_URL,
    // The app's service worker (public/sw.js) lets only URLs that contain
    // `supabase.co` past it, so against the local stack every Supabase request
    // would be the worker's own fetch, which page.route never sees:
    // accounts-first-sync.spec.ts's hold matched nothing in #221's first run.
    // Blocked, the app reaches the stack from the page itself, as it reaches
    // the hosted project in production. The hosted target keeps the worker.
    serviceWorkers: local ? 'block' : 'allow',
    // Every failed attempt keeps its trace, not just the first retry's: the #55
    // investigation had one trace for three red attempts. Kept when CI went to
    // one retry, two attempts in all (#75).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'unauthenticated',
      testMatch: ['smoke.spec.ts', 'auth.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'unauthenticated-webkit',
      testMatch: ['smoke.spec.ts', 'auth.spec.ts'],
      use: { ...devices['iPhone 15 Pro'] },
    },
    {
      name: 'chromium',
      testIgnore: ['smoke.spec.ts', 'auth.spec.ts'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
    },
  ],

  webServer: {
    command: `npx expo start --web --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !local && !process.env.CI,
    timeout: 180_000,
    // Playwright lays these over its own environment, and Expo never replaces
    // a variable that is already set, the empty one included (@expo/env), so
    // none of .env.local's hosted values reaches a local run's bundle.
    env: local
      ? {
          EXPO_PUBLIC_SUPABASE_URL: local.url,
          EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.publishableKey,
          EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
        }
      : {},
  },
});

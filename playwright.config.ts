import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, 'e2e', 'web', '.auth', 'user.json');

// NOTE on WebKit coverage:
// The unauthenticated specs run on both Desktop Chrome and iPhone 15 Pro (WebKit) to
// exercise the sign-in/sign-up screens across engines.
//
// The authenticated specs currently run only on Desktop Chrome because the app has
// two known WebKit-specific issues that prevent authenticated flows from working:
//   1. React Native Web Modal components (e.g. "New Account") don't render in WebKit.
//   2. expo-sqlite's WASM/IndexedDB storage path throws "UnknownError" in WebKit,
//      surfacing an error overlay that blocks all interactions.
// Native iOS (real WebKit) is fully covered by the Maestro suite in .maestro/flows/.
// If the app is ever fixed to work on web-WebKit, add a `webkit-mobile` project mirroring
// the `chromium` project below to extend authenticated coverage.

export default defineConfig({
  testDir: './e2e/web',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './e2e/web/global-setup.ts',

  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
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
    command: 'npx expo start --web --port 8081',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

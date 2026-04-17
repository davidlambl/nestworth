import { chromium, type FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return vars;
}

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

export default async function globalSetup(config: FullConfig) {
  const envFile = path.resolve(__dirname, '..', '..', '.env.e2e');
  const env = loadEnvFile(envFile);
  const email = process.env.E2E_TEST_EMAIL ?? env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD ?? env.E2E_TEST_PASSWORD;

  if (!email || !password || password === 'CHANGE_ME') {
    console.warn(
      '\n⚠  E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set (or still CHANGE_ME).\n' +
        '   Skipping authenticated global setup. Auth-dependent specs will fail.\n' +
        '   See e2e/README.md for setup instructions.\n'
    );
    return;
  }

  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:8081';
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(baseURL);

  await page.getByTestId('sign-in-email').fill(email);
  await page.getByTestId('sign-in-password').fill(password);
  await page.getByTestId('sign-in-submit').click();

  // Dismiss onboarding if it appears (4 steps: Next x3, then "Get Started")
  for (let i = 0; i < 3; i++) {
    const nextBtn = page.getByText('Next', { exact: true });
    try {
      await nextBtn.waitFor({ state: 'visible', timeout: 3000 });
      await nextBtn.click();
    } catch {
      break;
    }
  }
  const getStarted = page.getByText('Get Started', { exact: true });
  try {
    await getStarted.waitFor({ state: 'visible', timeout: 3000 });
    await getStarted.click();
  } catch {
    // Already past onboarding
  }

  // Also click "Skip" if it shows (alternative path)
  const skip = page.getByText('Skip', { exact: true });
  try {
    await skip.waitFor({ state: 'visible', timeout: 1000 });
    await skip.click();
  } catch {
    // Not visible
  }

  await page.getByText('Accounts').first().waitFor({ state: 'visible', timeout: 15000 });

  await context.storageState({ path: AUTH_FILE });
  await browser.close();
}

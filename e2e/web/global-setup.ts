import { chromium, type FullConfig } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { TEST_ACCOUNT_PREFIXES } from './helpers/test-accounts';

/**
 * Accounts younger than this are never purged. A Playwright job takes about
 * seven minutes, and two jobs can run against the shared test user at the same
 * time (nothing serialises them), so an age gate — not a prefix match — is what
 * keeps a purge from deleting an account another run is mid-test on.
 */
const STALE_TEST_ACCOUNT_AGE_MS = 30 * 60 * 1000;

/**
 * Tombstone test-prefixed accounts that an earlier run left behind.
 *
 * Every spec deletes what it creates and waits for the push, but a failed
 * attempt never reaches its cleanup step, and at ~6 accounts per red run the
 * shared user fills up until `createAccount` times out (issue #54). This goes
 * through the REST API as the e2e user rather than through the UI: a browser
 * purge has to scroll a list that gets slower the more debris there is, which
 * is exactly the condition it is meant to fix.
 *
 * Deleting is an `update({ deleted_at })`, the same tombstone the app's own
 * push writes: the server's `normalize_deleted_at` trigger stamps the real
 * time and `accounts_tombstone_children` cascades to the account's
 * transactions and rules. RLS scopes all of it to the signed-in user.
 */
async function purgeStaleTestAccounts(
  email: string,
  password: string,
  env: Record<string, string>
): Promise<void> {
  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn(
      '[e2e purge] skipped: EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY not set.'
    );
    return;
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    console.warn(
      `[e2e purge] skipped: sign-in failed (${signInError.message})`
    );
    return;
  }

  try {
    const cutoff = new Date(
      Date.now() - STALE_TEST_ACCOUNT_AGE_MS
    ).toISOString();
    const { data: live, error: readError } = await supabase
      .from('accounts')
      .select('id, name, created_at')
      .is('deleted_at', null)
      .lt('created_at', cutoff);
    if (readError) {
      console.warn(`[e2e purge] skipped: read failed (${readError.message})`);
      return;
    }
    const stale = (live ?? []).filter((row) =>
      TEST_ACCOUNT_PREFIXES.some((prefix) => row.name.startsWith(prefix))
    );
    // `in()` rides the query string, so batch the ids as lib/sync.ts does.
    const BATCH = 200;
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      const { error: writeError } = await supabase
        .from('accounts')
        .update({ deleted_at: new Date().toISOString() })
        .in(
          'id',
          batch.map((row) => row.id)
        )
        .is('deleted_at', null);
      if (writeError) {
        console.warn(
          `[e2e purge] failed to tombstone ${batch.length} account(s): ${writeError.message}`
        );
        return;
      }
    }
    console.log(
      `[e2e purge] tombstoned ${stale.length} stale test account(s) created before ${cutoff}` +
        (stale.length > 0 ? `: ${stale.map((row) => row.name).join(', ')}` : '')
    );
  } finally {
    // Local scope only. The default (`global`) revokes every refresh token the
    // user holds — including a concurrently running job's browser session and
    // any developer's saved one. This client's session is in memory anyway.
    await supabase.auth.signOut({ scope: 'local' });
  }
}

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    // dotenv allows quoted values; the app's own loader strips them, so do we.
    vars[trimmed.slice(0, eqIdx)] = trimmed
      .slice(eqIdx + 1)
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const AUTH_FILE = path.join(__dirname, '.auth', 'user.json');

export default async function globalSetup(config: FullConfig) {
  const root = path.resolve(__dirname, '..', '..');
  // .env.e2e holds the test user; .env.local holds the Supabase URL/key the
  // dev server uses. The purge needs both, process.env wins over either.
  const env = {
    ...loadEnvFile(path.join(root, '.env.local')),
    ...loadEnvFile(path.join(root, '.env.e2e')),
  };
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

  // Opt-in (CI sets it): it deletes data in the shared test user.
  if (process.env.E2E_PURGE_STALE_TEST_ACCOUNTS === '1') {
    await purgeStaleTestAccounts(email, password, env);
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

  await page
    .getByText('Accounts')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 });

  await context.storageState({ path: AUTH_FILE });
  await browser.close();
}

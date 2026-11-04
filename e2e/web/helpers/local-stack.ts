import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Where Playwright runs (#221, the move #93 decided). By default against the
// local Supabase stack (supabase/config.toml; `npx supabase start` first), as
// a user made for the run through the stack's Auth admin API: no run meets
// another's accounts, nothing needs a purge, and no repository secret is
// involved, so the pull-request job runs everywhere and waits for no other.
// With E2E_TARGET=hosted, against the shared e2e user on the hosted project,
// as before: the credentials from .env.e2e or the environment and the purge
// in global-setup.ts (the `e2e-hosted` job runs it after every merge to main).
//
// The stack's keys are the CLI's local demo keys, the same on every machine,
// and are read from `supabase status` when a run starts, never from a file.
// Two of them are used. The publishable key is what the app is built with,
// as on the hosted project; with the API URL it is the one value handed to
// the web server, kept in E2E_LOCAL_STACK for the workers. The secret key
// bypasses Row Level Security and is for the Auth admin API alone: it is read
// by global-setup when it makes the run's user and goes nowhere else (no
// environment variable, so neither the web server nor Metro ever holds it),
// and scripts/public-env-check.js stops a build that finds it in any
// EXPO_PUBLIC_* variable. No request carrying it leaves this machine: the API
// URL must be http:// on 127.0.0.1, localhost or [::1].

export type E2eTarget = 'local' | 'hosted';

/** process.env, or a plain object standing in for it. */
type Environment = Record<string, string | undefined>;

/** The target this run is for: the local stack unless E2E_TARGET=hosted. */
export function e2eTarget(env: Environment = process.env): E2eTarget {
  const target = env.E2E_TARGET ?? '';
  if (target === '' || target === 'local') return 'local';
  if (target === 'hosted') return 'hosted';
  throw new Error(
    `[e2e] E2E_TARGET is "${target}": leave it unset (or set it to local) for the local Supabase stack, or set it to hosted for the shared e2e user.`
  );
}

/** What a local run's app is built with. Public values only. */
export interface LocalApp {
  /** The stack's API, e.g. http://127.0.0.1:54321. */
  url: string;
  /** The key the app signs with, as on the hosted project (#191). */
  publishableKey: string;
}

/** global-setup's view: the app's values, and the secret key for the Auth admin API. */
export interface LocalAdmin extends LocalApp {
  /** Never in an environment variable, a file or a message. */
  secretKey: string;
}

export interface RunUser {
  email: string;
  password: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `url` when it is a local stack's API; otherwise an error naming only its host. */
export function assertLocalApi(url: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(
      '[e2e] the local stack gave no API URL: start the whole stack with `npx supabase start` (`db start` runs Postgres alone)'
    );
  }
  if (parsed.protocol !== 'http:' || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `[e2e] refusing ${parsed.protocol}//${parsed.host}: the local target talks to a stack on 127.0.0.1, localhost or [::1] only`
    );
  }
  return String(url);
}

/** The fields of `supabase status -o json` a run reads. */
export function localAdminFromStatus(
  status: Record<string, unknown>
): LocalAdmin {
  const url = assertLocalApi(status.API_URL);
  const publishableKey = String(status.PUBLISHABLE_KEY ?? '');
  const secretKey = String(status.SECRET_KEY ?? '');
  if (
    !publishableKey.startsWith('sb_publishable_') ||
    !secretKey.startsWith('sb_secret_')
  ) {
    throw new Error(
      '[e2e] `supabase status` gave no publishable or no secret key (PUBLISHABLE_KEY, SECRET_KEY)'
    );
  }
  return { url, publishableKey, secretKey };
}

export type CliRunner = (args: string[]) => string;

/**
 * `npx <args>`, its standard output; the CLI's own messages go to stderr. A
 * run asks the CLI on its own, so it asks with the CLI's usage telemetry off,
 * as the CI jobs run it.
 */
const runCli: CliRunner = (args) =>
  execFileSync('npx', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });

/** The running stack's `supabase status -o json`, read from the CLI. */
export function readStackStatus(
  run: CliRunner = runCli
): Record<string, unknown> {
  let output: string;
  try {
    output = run(['supabase', 'status', '-o', 'json']);
  } catch (error) {
    // The CLI's own first line, e.g. that no container runtime answers. On a
    // failure it prints no key: those go to standard output, on success.
    const said = String((error as { stderr?: unknown }).stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '');
    throw new Error(
      '[e2e] the local Supabase stack is not running' +
        (said ? ` (supabase status: ${said.slice(0, 200)})` : '') +
        ': `npx supabase start` first (it needs a container runtime), or E2E_TARGET=hosted for the shared e2e user.'
    );
  }
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error('[e2e] `supabase status -o json` printed no JSON');
  }
}

/**
 * The app's values for this run, read once: the first call (the config, in
 * Playwright's runner, before the web server starts) asks the CLI and keeps
 * the answer in E2E_LOCAL_STACK, which the workers inherit. Not an
 * EXPO_PUBLIC_* name, and it holds no secret.
 */
export function localApp(
  env: Environment = process.env,
  run: CliRunner = runCli
): LocalApp {
  if (!env.E2E_LOCAL_STACK) {
    const { url, publishableKey } = localAdminFromStatus(readStackStatus(run));
    env.E2E_LOCAL_STACK = JSON.stringify({ url, publishableKey });
  }
  const { url, publishableKey } = JSON.parse(env.E2E_LOCAL_STACK) as LocalApp;
  return { url: assertLocalApi(url), publishableKey: String(publishableKey) };
}

/**
 * global-setup's admin values, read from the CLI again (the secret key is
 * never cached), for the same stack the web server was given.
 */
export function localAdmin(
  env: Environment = process.env,
  run: CliRunner = runCli
): LocalAdmin {
  const app = localApp(env, run);
  const admin = localAdminFromStatus(readStackStatus(run));
  if (admin.url !== app.url || admin.publishableKey !== app.publishableKey) {
    throw new Error(
      '[e2e] the local stack answering now is not the one the web server was built for (E2E_LOCAL_STACK): unset E2E_LOCAL_STACK and run again'
    );
  }
  return admin;
}

/** This run's own user on the local stack, confirmed, so it signs in at once. */
export async function createRunUser(admin: LocalAdmin): Promise<RunUser> {
  const url = assertLocalApi(admin.url);
  const email = `e2e-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@nestworth.test`;
  const password = randomBytes(18).toString('base64url');
  const client = createClient(url, admin.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    throw new Error(
      `[e2e] the local stack refused the run's user: ${error.message}`
    );
  }
  return { email, password };
}

export interface RealtimeProbe {
  /** Whether a channel joined (SUBSCRIBED) within the attempts. */
  joined: boolean;
  /** Each attempt's outcome and how long it took. */
  attempts: string[];
  /** The server's confirmation of the Postgres changes subscription, if one came. */
  confirmation?: string;
}

const TERMINAL = new Set([
  'SUBSCRIBED',
  'TIMED_OUT',
  'CHANNEL_ERROR',
  'CLOSED',
]);

/**
 * Sign in as the run's user with the key the app signs with, then join one
 * Postgres changes channel on `accounts`, filtered by the user as the app's
 * own is (lib/hooks/useRealtimeSync.ts), and leave it. A sign-in the stack
 * refuses throws: the UI sign-in would fail too. A join that times out or
 * errs is tried again on a new channel and a new socket, up to `attempts`
 * times: on the CLI's native runtime (#221, measured on a Mac) a Node
 * process's first socket often had its join go unanswered, and every later
 * join on it, while a new socket's join was answered within milliseconds; on
 * Docker, the stack CI runs, the first join was answered. A spec's page opens
 * a socket of its own, so the probe says nothing about that one's first join.
 * The app logs nothing when its channel joins, only `[realtime] channel …`
 * when it does not, so this is the run's one positive line about Realtime.
 */
export async function probeRealtime(
  app: LocalApp,
  user: RunUser,
  { attempts = 3, joinTimeoutMs = 10_000 } = {}
): Promise<RealtimeProbe> {
  const client = createClient(assertLocalApi(app.url), app.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword(user);
  if (error || !data.user) {
    throw new Error(
      `[e2e] the run's user cannot sign in on the local stack: ${error?.message ?? 'no user'}`
    );
  }
  const userId = data.user.id;
  const outcomes: string[] = [];
  let confirmation: string | undefined;
  let joined = false;
  for (let attempt = 0; attempt < attempts && !joined; attempt++) {
    const started = Date.now();
    const channel = client
      .channel(`e2e-realtime-probe-${randomBytes(3).toString('hex')}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'accounts',
          filter: `user_id=eq.${userId}`,
        },
        () => {}
      )
      .on('system', {}, (payload: { extension?: string; message?: string }) => {
        if (payload.extension === 'postgres_changes') {
          confirmation = payload.message;
        }
      });
    const status = await new Promise<string>((resolve) => {
      // The join's own timeout ends a silent attempt; this one, a little
      // later, ends one realtime-js never answers at all.
      const stop = setTimeout(
        () => resolve('NO STATUS'),
        joinTimeoutMs + 2_000
      );
      channel.subscribe((reported) => {
        if (TERMINAL.has(reported)) {
          clearTimeout(stop);
          resolve(reported);
        }
      }, joinTimeoutMs);
    });
    outcomes.push(`${status} after ${Date.now() - started} ms`);
    joined = status === 'SUBSCRIBED';
    if (!joined) {
      // Leave every channel, which also closes the socket (realtime-js), so
      // the next attempt opens a new one. Where this was measured, retrying
      // on the same socket timed out three times running, while a new
      // socket's join was answered within milliseconds.
      await client.removeAllChannels();
    }
  }
  // The server confirms the Postgres subscription in a message of its own,
  // within milliseconds of the join where measured: wait up to 3 s for it.
  for (
    let waited = 0;
    joined && !confirmation && waited < 3_000;
    waited += 50
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await client.removeAllChannels();
  await client.auth.signOut({ scope: 'local' });
  return { joined, attempts: outcomes, confirmation };
}

/** The probe's one line for the run's log. */
export function describeRealtimeProbe(probe: RealtimeProbe): string {
  const attempts = probe.attempts.join(', ');
  if (!probe.joined) {
    return `[e2e] realtime: the run's user joined no Postgres changes channel on the local stack (${attempts}); the app's live updates may not run in this run`;
  }
  return `[e2e] realtime: the run's user joined a Postgres changes channel on the local stack (${attempts}; ${probe.confirmation ?? 'no confirmation from the server yet'})`;
}

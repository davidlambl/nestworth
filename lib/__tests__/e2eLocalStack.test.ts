// #221 (the move #93 decided): Playwright's two targets. The local Supabase
// stack, for every push and pull request and by default on a developer's
// machine, where a run makes its own user through the Auth admin API with the
// stack's secret key; and the shared hosted e2e user, after a merge to main
// only. So the secret key must never leave this machine (the API URL is
// checked before any request), never sit in an environment variable the web
// server or Metro inherits, and never reach an EXPO_PUBLIC_* variable
// (scripts/public-env-check.js refuses it there). In test.yml, the local job
// reads no secret and runs for every pull request; the hosted job alone reads
// the e2e secrets, never for a pull request, one at a time. Playwright,
// supabase-js and the CLI are mocked: no browser starts, no request is made.
// The keys below are placeholders in the shape of the CLI's local demo keys.
const mockExecFileSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
const mockLaunch = jest.fn();
jest.mock('@playwright/test', () => ({
  defineConfig: (config: unknown) => config,
  devices: new Proxy({}, { get: () => ({}) }),
  chromium: { launch: (...args: unknown[]) => mockLaunch(...args) },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts).
import { load } from 'js-yaml';
import {
  assertLocalApi,
  createRunUser,
  describeRealtimeProbe,
  e2eTarget,
  localAdmin,
  localAdminFromStatus,
  localApp,
  probeRealtime,
  readStackStatus,
} from '../../e2e/web/helpers/local-stack';
import { refuseSecretKeys } from '../../scripts/public-env-check';

const ROOT = path.join(__dirname, '../..');
const PUBLISHABLE_KEY = 'sb_publishable_placeholder';
const SECRET_KEY = 'sb_secret_placeholder';
/** `supabase status -o json` as the CLI prints it for a Docker stack (status.go's names). */
const STATUS = {
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  PUBLISHABLE_KEY,
  SECRET_KEY,
};
const statusJson = `${JSON.stringify(STATUS, null, 2)}\n`;
const APP = { url: STATUS.API_URL, publishableKey: PUBLISHABLE_KEY };

/** A JWT shaped like the CLI's local service_role key (unsigned: only its shape matters). */
const LOCAL_SERVICE_ROLE_JWT = [
  { alg: 'HS256', typ: 'JWT' },
  { iss: 'supabase-demo', role: 'service_role', exp: 1983812996 },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
  .concat('signature')
  .join('.');

/**
 * A supabase-js client as far as the helper uses it. `joins` scripts the
 * Realtime statuses each new channel reports, one list per channel.
 */
interface FakeChannel {
  on: jest.Mock;
  subscribe: jest.Mock;
}

function fakeClient(joins: string[][] = []) {
  let made = 0;
  const client = {
    auth: {
      admin: { createUser: jest.fn(async () => ({ error: null })) },
      signInWithPassword: jest.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
      signOut: jest.fn(async () => ({ error: null })),
    },
    channels: [] as string[],
    channel: jest.fn((topic: string): FakeChannel => {
      client.channels.push(topic);
      const statuses = joins[made++] ?? [];
      let system: ((payload: object) => void) | undefined;
      const channel: FakeChannel = {
        on: jest.fn((type: string, _filter: object, callback: any) => {
          if (type === 'system') system = callback;
          return channel;
        }),
        subscribe: jest.fn((callback: (status: string) => void) => {
          queueMicrotask(() => {
            for (const status of statuses) {
              callback(status);
              if (status === 'SUBSCRIBED') {
                system?.({
                  extension: 'postgres_changes',
                  status: 'ok',
                  message: 'Subscribed to PostgreSQL',
                });
              }
            }
          });
          return channel;
        }),
      };
      return channel;
    }),
    removeChannel: jest.fn(async () => 'ok'),
    removeAllChannels: jest.fn(async () => []),
  };
  return client;
}

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockCreateClient.mockReset();
  mockLaunch.mockReset();
  mockLaunch.mockImplementation(async () => {
    throw new Error('no browser under jest');
  });
});

describe('the e2e target', () => {
  it('is the local stack unless E2E_TARGET=hosted', () => {
    expect(e2eTarget({})).toBe('local');
    expect(e2eTarget({ E2E_TARGET: '' })).toBe('local');
    expect(e2eTarget({ E2E_TARGET: 'local' })).toBe('local');
    expect(e2eTarget({ E2E_TARGET: 'hosted' })).toBe('hosted');
  });

  it('refuses any other value rather than guess', () => {
    for (const value of ['HOSTED', 'prod', 'hosted ']) {
      expect(() => e2eTarget({ E2E_TARGET: value })).toThrow(
        `[e2e] E2E_TARGET is "${value}"`
      );
    }
  });
});

describe('the local stack a run uses', () => {
  it('takes the API URL and the two keys from `supabase status -o json`', () => {
    expect(localAdminFromStatus(STATUS)).toEqual({
      url: 'http://127.0.0.1:54321',
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
    });
    for (const url of ['http://localhost:54321', 'http://[::1]:54321']) {
      expect(assertLocalApi(url)).toBe(url);
    }
  });

  it.each([
    'https://abcdefghijklmnopqrst.supabase.co',
    'http://127.0.0.1.nip.io:54321',
    'http://127.0.0.1:54321@db.example.invalid',
    'http://db.local:54321',
    'https://127.0.0.1:54321',
    'http://10.0.0.1:54321',
    undefined,
  ])('refuses an API that is not on this machine: %s', (url) => {
    expect(() => assertLocalApi(url)).toThrow('[e2e]');
    expect(() => localAdminFromStatus({ ...STATUS, API_URL: url })).toThrow(
      '[e2e]'
    );
  });

  it('names the fix when the stack runs Postgres alone (no API URL)', () => {
    expect(() =>
      localAdminFromStatus({ ...STATUS, API_URL: undefined })
    ).toThrow('start the whole stack with `npx supabase start`');
  });

  it('refuses a status without the publishable and the secret key', () => {
    for (const status of [
      { ...STATUS, SECRET_KEY: LOCAL_SERVICE_ROLE_JWT },
      { ...STATUS, PUBLISHABLE_KEY: undefined },
      { ...STATUS, PUBLISHABLE_KEY: SECRET_KEY },
    ]) {
      expect(() => localAdminFromStatus(status)).toThrow(
        'gave no publishable or no secret key'
      );
    }
  });

  it('asks the CLI for `supabase status -o json` and reads its standard output', () => {
    const run = jest.fn(() => statusJson);
    expect(readStackStatus(run)).toEqual(STATUS);
    expect(run).toHaveBeenCalledWith(['supabase', 'status', '-o', 'json']);
  });

  it("says the stack is not running, with the CLI's first line, when the CLI fails", () => {
    const run = () => {
      throw Object.assign(new Error('Command failed'), {
        stderr:
          '\nfailed to inspect container health: docker: command not found\nTry rerunning\n',
      });
    };
    expect(() => readStackStatus(run)).toThrow(
      '[e2e] the local Supabase stack is not running (supabase status: failed to inspect container health: docker: command not found): `npx supabase start` first'
    );
    expect(() => readStackStatus(() => 'Stopped services')).toThrow(
      'printed no JSON'
    );
  });

  it("reads the app's values once and hands them on through E2E_LOCAL_STACK, without the secret key", () => {
    const run = jest.fn(() => statusJson);
    const env: Record<string, string | undefined> = {};
    expect(localApp(env, run)).toEqual(APP);
    expect(localApp(env, run)).toEqual(APP);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(env.E2E_LOCAL_STACK as string)).toEqual(APP);
    expect(env.E2E_LOCAL_STACK).not.toContain('sb_secret_');
  });

  it('checks a handed-on value again: a hosted URL is refused there too', () => {
    const env = {
      E2E_LOCAL_STACK: JSON.stringify({ ...APP, url: 'https://x.supabase.co' }),
    };
    expect(() => localApp(env, () => statusJson)).toThrow('[e2e] refusing');
  });

  it('reads the secret key from the CLI each time, for the stack the web server was given', () => {
    const run = jest.fn(() => statusJson);
    const env = {
      E2E_LOCAL_STACK: JSON.stringify(APP),
    };
    expect(localAdmin(env, run)).toEqual({ ...APP, secretKey: SECRET_KEY });
    expect(run).toHaveBeenCalledTimes(1);
    // Returned, never written back into the environment it was handed.
    expect(JSON.stringify(env)).not.toContain(SECRET_KEY);
    const stale = {
      E2E_LOCAL_STACK: JSON.stringify({
        ...APP,
        url: 'http://127.0.0.1:55321',
      }),
    };
    expect(() => localAdmin(stale, run)).toThrow(
      'is not the one the web server was built for'
    );
  });

  it('never reads a key from an EXPO_PUBLIC_* variable', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'e2e/web/helpers/local-stack.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/env\.EXPO_PUBLIC_|env\[['"`]EXPO_PUBLIC_/);
  });
});

describe("the run's user", () => {
  it('is made confirmed through the Auth admin API, with a fresh address and password', async () => {
    const client = fakeClient();
    mockCreateClient.mockReturnValue(client);
    const user = await createRunUser({ ...APP, secretKey: SECRET_KEY });
    expect(mockCreateClient).toHaveBeenCalledWith(STATUS.API_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(client.auth.admin.createUser).toHaveBeenCalledWith({
      ...user,
      email_confirm: true,
    });
    expect(user.email).toMatch(/^e2e-[0-9a-f]{16}@nestworth\.test$/);
    expect(user.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const second = await createRunUser({ ...APP, secretKey: SECRET_KEY });
    expect(second.email).not.toBe(user.email);
    expect(second.password).not.toBe(user.password);
  });

  it('has an address that cannot spell a label a spec finds by its text', async () => {
    // The address is on screen (the sidebar's account line), and Playwright's
    // getByText('3M') matches part of a text, whatever its case. The address
    // used to hold a base-36 clock; at this value (2026-11-05 14:18:43Z)
    // reports.spec.ts failed both attempts on "3M" (run 42043160158). The
    // second assertion follows from the first: it names what must not be
    // spelled (the spec's period chips and "Net").
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(parseInt('mw3msgun', 36));
    try {
      mockCreateClient.mockReturnValue(fakeClient());
      const { email } = await createRunUser({ ...APP, secretKey: SECRET_KEY });
      expect(email).toMatch(/^e2e-[0-9a-f]{16}@nestworth\.test$/);
      expect(email).not.toMatch(/1m|3m|6m|1y|net/i);
    } finally {
      clock.mockRestore();
    }
  });

  it('is never asked of a stack that is not on this machine: no client is made', async () => {
    await expect(
      createRunUser({
        url: 'https://abcdefghijklmnopqrst.supabase.co',
        publishableKey: PUBLISHABLE_KEY,
        secretKey: SECRET_KEY,
      })
    ).rejects.toThrow('[e2e] refusing');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('says so when the stack refuses it', async () => {
    const client = fakeClient();
    client.auth.admin.createUser.mockResolvedValue({
      error: { message: 'Database error creating new user' },
    } as never);
    mockCreateClient.mockReturnValue(client);
    await expect(
      createRunUser({ ...APP, secretKey: SECRET_KEY })
    ).rejects.toThrow(
      "[e2e] the local stack refused the run's user: Database error creating new user"
    );
  });
});

describe('the Realtime probe', () => {
  const user = { email: 'e2e-x@nestworth.test', password: 'p' };

  it('joins as the run user with the publishable key, the way the app subscribes', async () => {
    const client = fakeClient([['SUBSCRIBED']]);
    mockCreateClient.mockReturnValue(client);
    const probe = await probeRealtime(APP, user);
    expect(mockCreateClient).toHaveBeenCalledWith(
      STATUS.API_URL,
      PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith(user);
    const channel = client.channel.mock.results[0].value;
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'accounts',
        filter: 'user_id=eq.user-1',
      },
      expect.any(Function)
    );
    expect(probe).toMatchObject({
      joined: true,
      confirmation: 'Subscribed to PostgreSQL',
    });
    expect(probe.attempts).toEqual([
      expect.stringMatching(/^SUBSCRIBED after \d+ ms$/),
    ]);
    expect(client.removeAllChannels).toHaveBeenCalled();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('tries again on a new channel and a new socket after a join goes unanswered', async () => {
    const client = fakeClient([['TIMED_OUT'], ['SUBSCRIBED']]);
    mockCreateClient.mockReturnValue(client);
    const probe = await probeRealtime(APP, user);
    expect(probe.joined).toBe(true);
    expect(probe.attempts).toEqual([
      expect.stringMatching(/^TIMED_OUT after/),
      expect.stringMatching(/^SUBSCRIBED after/),
    ]);
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(new Set(client.channels).size).toBe(2);
    // Every channel is left between the two attempts, which closes the
    // socket, so the second join goes out on a new one.
    const left = client.removeAllChannels.mock.invocationCallOrder[0];
    const secondJoin =
      client.channel.mock.results[1].value.subscribe.mock
        .invocationCallOrder[0];
    expect(left).toBeLessThan(secondJoin);
    expect(describeRealtimeProbe(probe)).toMatch(
      /^\[e2e\] realtime: the run's user joined a Postgres changes channel on the local stack \(TIMED_OUT after \d+ ms, SUBSCRIBED after \d+ ms; Subscribed to PostgreSQL\)$/
    );
  });

  it('reports a stack whose Realtime never answers, after three attempts, without failing the run', async () => {
    const client = fakeClient([
      ['TIMED_OUT'],
      ['CHANNEL_ERROR'],
      ['TIMED_OUT'],
    ]);
    mockCreateClient.mockReturnValue(client);
    const probe = await probeRealtime(APP, user);
    expect(probe.joined).toBe(false);
    expect(probe.attempts).toHaveLength(3);
    expect(client.channel).toHaveBeenCalledTimes(3);
    expect(describeRealtimeProbe(probe)).toMatch(
      /^\[e2e\] realtime: the run's user joined no Postgres changes channel on the local stack \(TIMED_OUT after \d+ ms, CHANNEL_ERROR after \d+ ms, TIMED_OUT after \d+ ms\); the app's live updates may not run in this run$/
    );
  });

  it("throws when the run's user cannot sign in: the UI sign-in would fail too", async () => {
    const client = fakeClient();
    client.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    } as never);
    mockCreateClient.mockReturnValue(client);
    await expect(probeRealtime(APP, user)).rejects.toThrow(
      "[e2e] the run's user cannot sign in on the local stack: Invalid login credentials"
    );
    expect(client.channel).not.toHaveBeenCalled();
  });
});

describe('global-setup on the local target', () => {
  const VARS = [
    'E2E_TARGET',
    'E2E_LOCAL_STACK',
    'E2E_TEST_EMAIL',
    'E2E_TEST_PASSWORD',
    'E2E_PURGE_STALE_TEST_ACCOUNTS',
    'GITHUB_ACTIONS',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    // The hosted target's variables, set: the local target must ignore them.
    process.env.E2E_TEST_EMAIL = 'shared-user@example.invalid';
    process.env.E2E_TEST_PASSWORD = 'not-a-password';
    process.env.E2E_PURGE_STALE_TEST_ACCOUNTS = '1';
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    jest.restoreAllMocks();
  });
  const globalSetup = (config: object = { projects: [] }) => {
    jest.resetModules();
    return jest.requireActual('../../e2e/web/global-setup').default(config);
  };
  /** Every value of process.env that holds the stack's secret key. */
  const secretInEnvironment = () =>
    Object.entries(process.env).filter(([, value]) =>
      value?.includes(SECRET_KEY)
    );

  it('is the default, and needs the stack: without one it stops before any request', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'failed to inspect container health: docker: command not found',
      });
    });
    await expect(globalSetup()).rejects.toThrow(
      '[e2e] the local Supabase stack is not running (supabase status: failed to inspect container health'
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npx',
      ['supabase', 'status', '-o', 'json'],
      expect.objectContaining({
        // stderr piped, so a failure's error carries the CLI's first line.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ SUPABASE_TELEMETRY_DISABLED: '1' }),
      })
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('makes a user of its own and probes Realtime, never the shared user or its purge', async () => {
    mockExecFileSync.mockReturnValue(statusJson);
    const admin = fakeClient();
    const probe = fakeClient([['SUBSCRIBED']]);
    mockCreateClient.mockReturnValueOnce(admin).mockReturnValueOnce(probe);
    // The UI sign-in that follows needs a browser: the test stops there.
    await expect(globalSetup()).rejects.toThrow('no browser under jest');
    expect(mockCreateClient.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      [
        [STATUS.API_URL, SECRET_KEY],
        [STATUS.API_URL, PUBLISHABLE_KEY],
      ]
    );
    const made = (admin.auth.admin.createUser.mock.calls[0] as any)[0];
    expect(made.email).toMatch(/@nestworth\.test$/);
    expect(probe.auth.signInWithPassword).toHaveBeenCalledWith({
      email: made.email,
      password: made.password,
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[e2e\] realtime: the run's user joined a Postgres changes channel/
      )
    );
    // The workers fork with global setup's environment: the secret key went
    // to the admin call alone, into no variable of it.
    expect(secretInEnvironment()).toEqual([]);
  });

  it("signs in through a browser that takes the config's service worker choice", async () => {
    mockExecFileSync.mockReturnValue(statusJson);
    mockCreateClient
      .mockReturnValueOnce(fakeClient())
      .mockReturnValueOnce(fakeClient([['SUBSCRIBED']]));
    const newContext = jest.fn(async () => {
      throw new Error('no page under jest');
    });
    mockLaunch.mockImplementation(async () => ({
      newContext,
      close: jest.fn(),
    }));
    // A project's `use` as the runner hands it to global setup, the config's
    // own merged in (playwright.config.ts blocks the worker on this target).
    await expect(
      globalSetup({
        projects: [
          {
            use: {
              baseURL: 'http://localhost:8082',
              serviceWorkers: 'block',
            },
          },
        ],
      })
    ).rejects.toThrow('no page under jest');
    expect(newContext).toHaveBeenCalledWith({ serviceWorkers: 'block' });
  });

  it('puts a warning on the CI job when Realtime never answers, and goes on', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    mockExecFileSync.mockReturnValue(statusJson);
    mockCreateClient
      .mockReturnValueOnce(fakeClient())
      .mockReturnValueOnce(
        fakeClient([['TIMED_OUT'], ['TIMED_OUT'], ['TIMED_OUT']])
      );
    await expect(globalSetup()).rejects.toThrow('no browser under jest');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^::warning title=Realtime on the local stack::\[e2e\] realtime: the run's user joined no Postgres changes channel/
      )
    );
  });
});

describe('the local keys and the app build', () => {
  it("refuses the local stack's secret keys in an EXPO_PUBLIC_* variable", () => {
    expect(() =>
      refuseSecretKeys({ EXPO_PUBLIC_SUPABASE_ANON_KEY: SECRET_KEY })
    ).toThrow('EXPO_PUBLIC_SUPABASE_ANON_KEY holds a Supabase secret key');
    expect(() =>
      refuseSecretKeys({
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: LOCAL_SERVICE_ROLE_JWT,
      })
    ).toThrow(
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key'
    );
  });

  it('builds a local run with the publishable key and an empty anon key', () => {
    expect(() =>
      refuseSecretKeys({
        EXPO_PUBLIC_SUPABASE_URL: STATUS.API_URL,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
      })
    ).not.toThrow();
  });
});

describe('playwright.config.ts', () => {
  /** The config as Playwright's runner evaluates it, under `env`. */
  const configUnder = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      let config: any;
      jest.isolateModules(() => {
        config = jest.requireActual('../../playwright.config').default;
      });
      return config;
    } finally {
      process.env = saved;
    }
  };

  it('points a dev server of its own at the local stack, never reusing one, with no hosted value', () => {
    const config = configUnder({
      E2E_TARGET: undefined,
      CI: undefined,
      E2E_LOCAL_STACK: JSON.stringify(APP),
      // A hosted value in the runner's own environment stays out too.
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'hosted-anon-key',
    });
    expect(config.use.baseURL).toBe('http://localhost:8082');
    expect(config.webServer).toEqual({
      command: 'npx expo start --web --port 8082',
      url: 'http://localhost:8082',
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
      },
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('asks the CLI when nothing was handed on, and keeps the secret key out of the web server', () => {
    mockExecFileSync.mockReturnValue(statusJson);
    const config = configUnder({
      E2E_TARGET: undefined,
      E2E_LOCAL_STACK: undefined,
    });
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(config.webServer.env.EXPO_PUBLIC_SUPABASE_URL).toBe(STATUS.API_URL);
    expect(JSON.stringify(config.webServer)).not.toContain('sb_secret_');
  });

  it("blocks the app's service worker on the local target only, where page.route would not see past it", () => {
    // public/sw.js lets only URLs that contain `supabase.co` past it, so on
    // the local stack it made every Supabase request itself (#221's first run).
    expect(
      configUnder({
        E2E_TARGET: undefined,
        E2E_LOCAL_STACK: JSON.stringify(APP),
      }).use.serviceWorkers
    ).toBe('block');
    expect(configUnder({ E2E_TARGET: 'hosted' }).use.serviceWorkers).toBe(
      'allow'
    );
  });

  it('keeps the hosted run as it was: port 8081, a running dev server reused outside CI only', () => {
    const local = configUnder({ E2E_TARGET: 'hosted', CI: undefined });
    expect(local.use.baseURL).toBe('http://localhost:8081');
    expect(local.webServer).toEqual({
      command: 'npx expo start --web --port 8081',
      url: 'http://localhost:8081',
      reuseExistingServer: true,
      timeout: 180_000,
      // Nothing laid over the environment: the hosted values come from CI's
      // secrets or .env.local, as before #221.
      env: {},
    });
    expect(
      configUnder({ E2E_TARGET: 'hosted', CI: '1' }).webServer
        .reuseExistingServer
    ).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// The real one: this file mocks execFileSync alone.
const { spawnSync } =
  jest.requireActual<typeof import('child_process')>('child_process');

/**
 * Runs a workflow step's `run` text as the runner does (`bash -e` on a file
 * holding it, GitHub's default shell) in a sandbox: HOME and GITHUB_OUTPUT
 * are fresh, and each command named in `fakes` is a script first on PATH that
 * appends its name and arguments to the call log, then runs its body
 * (`$SANDBOX` is the sandbox). The sandbox's path reads `~` in what returns;
 * `left` lists what the step left under HOME's `.cache`.
 */
function runStep(
  script: string,
  fakes: Record<string, string> = {},
  {
    env = {},
    prepare,
  }: { env?: Record<string, string>; prepare?: (home: string) => void } = {}
) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ci-'));
  const home = (each: string) => each.split(sandbox).join('~');
  try {
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(fakes)) {
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\necho "${name} $*" >> "$SANDBOX/calls"\n${body}\n`,
        { mode: 0o755 }
      );
    }
    prepare?.(sandbox);
    fs.writeFileSync(path.join(sandbox, 'step.sh'), script);
    const result = spawnSync('bash', ['-e', path.join(sandbox, 'step.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        // Nothing else of this process's environment reaches the step.
        NODE_ENV: process.env.NODE_ENV,
        PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(
          path.delimiter
        ),
        HOME: sandbox,
        SANDBOX: sandbox,
        GITHUB_OUTPUT: path.join(sandbox, 'output'),
        ...env,
      },
    });
    const lines = (file: string) =>
      fs.existsSync(path.join(sandbox, file))
        ? fs.readFileSync(path.join(sandbox, file), 'utf8').trim().split('\n')
        : [];
    const cache = path.join(sandbox, '.cache');
    return {
      left: fs.existsSync(cache)
        ? fs.readdirSync(cache, { recursive: true }).map(String).sort()
        : [],
      status: result.status,
      output: home(`${result.stdout}${result.stderr}`),
      calls: lines('calls').map(home),
      outputs: Object.fromEntries(
        lines('output').map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ])
      ),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("test.yml's two Playwright jobs", () => {
  const text = fs.readFileSync(
    path.join(ROOT, '.github/workflows/test.yml'),
    'utf8'
  );
  const workflow = load(text) as any;
  const local = workflow.jobs['e2e-web'];
  const hosted = workflow.jobs['e2e-hosted'];
  const creds = workflow.jobs['e2e-creds'];
  const steps = (job: any) =>
    job.steps.map(
      (step: any) => step.uses?.replace(/@.*$/, '') ?? step.name ?? step.run
    );
  const step = (job: any, name: string) =>
    job.steps.find((each: any) => each.name === name);
  const KEY_STEP = "Name the cache of the browsers' system packages";
  const START = 'npx supabase start -x studio,postgres-meta';

  it('runs the local job for every push and pull request, gated by nothing, with no secret', () => {
    expect(local.name).toBe('Playwright (web)');
    expect(JSON.stringify(local)).not.toMatch(/secrets/i);
    expect(local.if).toBeUndefined();
    expect(local.needs).toBeUndefined();
    expect(local.concurrency).toBeUndefined();
    expect(local['continue-on-error']).toBeUndefined();
    expect(local.environment).toBeUndefined();
    expect(local.permissions).toEqual({ contents: 'read' });
    expect(local.env).toEqual({ SUPABASE_TELEMETRY_DISABLED: '1' });
    expect(workflow.env).toBeUndefined();
  });

  it('starts the local stack, then runs the suite against it with nothing hosted in reach', () => {
    expect(steps(local)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci',
      KEY_STEP,
      'actions/cache/restore',
      'Install Playwright browsers',
      'actions/cache/save',
      'Start the local Supabase stack',
      'Run Playwright',
      'actions/upload-artifact',
    ]);
    expect(local.steps[0].with).toEqual({ 'persist-credentials': false });
    // Both attempts start the same stack: config.toml's less Studio and pg-meta.
    expect(
      step(local, 'Start the local Supabase stack').run.match(
        /npx supabase start[^;\n]*/g
      )
    ).toEqual([START, START]);
    // No E2E_TARGET, no Supabase URL or key: the defaults are the local
    // stack's, read by the run itself.
    expect(step(local, 'Run Playwright')).toEqual({
      name: 'Run Playwright',
      'timeout-minutes': 15,
      run: 'npm run e2e:web',
    });
    const commands = local.steps.map((each: any) => each.run ?? '').join('\n');
    expect(commands).not.toMatch(
      /--linked|--db-url|supabase (link|login|db push|db pull)|supabase\.co/
    );
    // A pin against the review's mutants A3 and A10 (`continue-on-error` on
    // the install step or on the stack start): a step of either job that
    // fails fails its job, so a stack that failed both starts is red there.
    const forgiven = (job: any) =>
      job.steps
        .filter((each: any) => 'continue-on-error' in each)
        .map((each: any) => each.name ?? each.uses ?? each.run);
    expect(forgiven(local)).toEqual([]);
    expect(forgiven(hosted)).toEqual([]);
  });

  it('runs on the Node version the check job runs on', () => {
    const node = (job: any) =>
      job.steps.find((each: any) =>
        String(each.uses ?? '').startsWith('actions/setup-node')
      ).with['node-version'];
    expect(node(local)).toBe(node(workflow.jobs.check));
    expect(node(hosted)).toBe(node(workflow.jobs.check));
  });

  it('runs the hosted job after a merge to main only, one at a time, as the one job with the e2e user', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(hosted.name).toBe('Playwright (hosted)');
    expect(hosted.needs).toBe('e2e-creds');
    expect(hosted.if).toBe(
      "github.event_name == 'push' && needs.e2e-creds.outputs.present == 'true'"
    );
    expect(creds.if).toBe("github.event_name == 'push'");
    expect(hosted.concurrency).toEqual({
      group: 'playwright-e2e-user',
      queue: 'max',
    });
    expect(step(hosted, 'Run Playwright').env).toMatchObject({
      E2E_TARGET: 'hosted',
      E2E_PURGE_STALE_TEST_ACCOUNTS: '1',
      E2E_TEST_EMAIL: '${{ secrets.E2E_TEST_EMAIL }}',
      E2E_TEST_PASSWORD: '${{ secrets.E2E_TEST_PASSWORD }}',
    });
    const naming = Object.entries<any>(workflow.jobs)
      .filter(([, job]) =>
        /E2E_TEST_(EMAIL|PASSWORD)/.test(JSON.stringify(job))
      )
      .map(([id]) => id);
    expect(naming).toEqual(['e2e-creds', 'e2e-hosted']);
  });

  it('reads secrets only where the hosted project is meant: the web build, the credentials probe and the hosted job', () => {
    const reading = Object.entries<any>(workflow.jobs)
      .filter(([, job]) => /secrets\./.test(JSON.stringify(job)))
      .map(([id]) => id);
    expect(reading).toEqual(['build-web', 'e2e-creds', 'e2e-hosted']);
  });

  it('uploads the two reports under two names, a failed run included', () => {
    const upload = (job: any) =>
      job.steps.find((each: any) =>
        String(each.uses ?? '').startsWith('actions/upload-artifact')
      );
    const artifact = (job: any) => upload(job).with;
    // The report matters most after a red run: skipped only when cancelled.
    expect(upload(local).if).toBe('${{ !cancelled() }}');
    expect(upload(hosted).if).toBe('${{ !cancelled() }}');
    expect(artifact(local)).toEqual({
      name: 'playwright-report',
      path: 'playwright-report/',
      'retention-days': 7,
    });
    expect(artifact(hosted)).toEqual({
      name: 'playwright-report-hosted',
      path: 'playwright-report/',
      'retention-days': 7,
    });
  });

  // #241: the two reds that were the runner's, not the change's.
  it('gives each long step a limit of its own, so a slow one fails under its own name, and the job a backstop above their sum', () => {
    const limit = (job: any, name: string) =>
      step(job, name)?.['timeout-minutes'];
    expect(limit(local, 'Install Playwright browsers')).toBe(20);
    expect(limit(local, 'Start the local Supabase stack')).toBe(10);
    expect(limit(local, 'Run Playwright')).toBe(15);
    expect(limit(hosted, 'Install Playwright browsers')).toBe(20);
    expect(limit(hosted, 'Run Playwright')).toBe(15);
    // A step past its limit fails, and the upload (`!cancelled()`) still
    // runs; a job past its limit is cancelled, upload included. So the job's
    // limit sits above the steps' sum, with five minutes for the steps that
    // have none, and the upload has no limit of its own.
    const sum = (job: any) =>
      job.steps.reduce(
        (total: number, each: any) => total + (each['timeout-minutes'] ?? 0),
        0
      );
    expect(local['timeout-minutes']).toBe(sum(local) + 5);
    expect(hosted['timeout-minutes']).toBe(sum(hosted) + 5);
    for (const job of [local, hosted]) {
      expect(step(job, 'Upload report')['timeout-minutes']).toBeUndefined();
    }
  });

  describe('starting the local stack', () => {
    const run = () => step(local, 'Start the local Supabase stack').run;
    /** `npx supabase start` answers from `starts`, one word per attempt. */
    const fakes = (
      starts: string[],
      { stop = 'ok', busy = 0 }: { stop?: string; busy?: number } = {}
    ) => ({
      npx: `case "$1 $2" in
  "supabase start")
    n=$(( $(cat "$SANDBOX/starts" 2> /dev/null || echo 0) + 1 ))
    echo $n > "$SANDBOX/starts"
    if [ "$(echo '${starts.join(' ')}' | cut -d ' ' -f $n)" = ok ]; then echo 'Started supabase local development setup.'; exit 0; fi
    echo 'failed to start docker container "supabase_db_nestworth": failed to bind host port 0.0.0.0:54322/tcp: address already in use' >&2
    exit 1;;
  "supabase stop") [ '${stop}' = ok ] || { echo 'stop failed' >&2; exit 1; };;
  *) exit 99;;
esac`,
      sudo: `echo 'ESTAB 0 0 10.1.0.4:54322 3.5.0.1:443 users:(("dockerd",pid=812,fd=40))'`,
      // Busy for the first `busy` polls, then free.
      ss: `n=$(( $(cat "$SANDBOX/polls" 2> /dev/null || echo 0) + 1 ))
echo $n > "$SANDBOX/polls"
if [ $n -le ${busy} ]; then echo 'TIME-WAIT 0 0 10.1.0.4:54322 3.5.0.1:443'; fi`,
      sleep: '',
    });
    const STOP = 'npx supabase stop --no-backup';
    const PORTS = '( sport = :54321 or sport = :54322 )';
    const WARNING =
      '::warning title=Local Supabase stack::The first start failed; the stack was stopped and started once more.';

    it('starts it once when the first start works', () => {
      const result = runStep(run(), fakes(['ok']));
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([START]);
      expect(result.output).not.toContain('::warning');
    });

    it('stops it, prints what held its ports, waits for them and starts it once more after a failed start, with a warning on the job', () => {
      const result = runStep(run(), fakes(['fail', 'ok']));
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        START,
        `sudo ss -tanp ${PORTS}`,
        STOP,
        `ss -Htan ${PORTS}`,
        START,
      ]);
      expect(result.output).toContain(WARNING);
      expect(result.output).toContain('users:(("dockerd"');
    });

    it("fails the step with the CLI's own message when the second start fails too", () => {
      const result = runStep(run(), fakes(['fail', 'fail']));
      expect(result.status).toBe(1);
      expect(result.calls.filter((call) => call === START)).toHaveLength(2);
      expect(result.calls[result.calls.length - 1]).toBe(START);
      expect(result.output.match(/address already in use/g) ?? []).toHaveLength(
        2
      );
    });

    it('starts it again even when the stop fails, as on a stack the first start never made', () => {
      const result = runStep(run(), fakes(['fail', 'ok'], { stop: 'fail' }));
      expect(result.status).toBe(0);
      expect(result.calls.slice(-1)).toEqual([START]);
    });

    it('waits while a socket holds a port, two seconds at a time', () => {
      const result = runStep(run(), fakes(['fail', 'ok'], { busy: 3 }));
      expect(result.status).toBe(0);
      expect(result.calls.slice(2)).toEqual([
        STOP,
        `ss -Htan ${PORTS}`,
        'sleep 2',
        `ss -Htan ${PORTS}`,
        'sleep 2',
        `ss -Htan ${PORTS}`,
        'sleep 2',
        `ss -Htan ${PORTS}`,
        START,
      ]);
    });

    it('gives up waiting after two minutes and lets the second start answer', () => {
      const result = runStep(run(), fakes(['fail', 'ok'], { busy: 1000 }));
      expect(result.status).toBe(0);
      expect(result.calls.filter((call) => call === 'sleep 2')).toHaveLength(
        60
      );
      expect(result.calls.slice(-1)).toEqual([START]);
    });

    it("watches the host ports config.toml gives the stack's API and database", () => {
      const toml = fs.readFileSync(
        path.join(ROOT, 'supabase/config.toml'),
        'utf8'
      );
      const port = (section: string) =>
        toml.match(new RegExp(`^\\[${section}\\]\\nport = (\\d+)$`, 'm'))?.[1];
      const watched = (run().match(/sport = :\d+/g) ?? []).map((each: string) =>
        each.replace('sport = :', '')
      );
      expect([port('api'), port('db')]).toEqual(['54321', '54322']);
      expect(watched).toEqual([
        port('api'),
        port('db'),
        port('api'),
        port('db'),
      ]);
    });
  });

  describe("the browsers' system packages", () => {
    const CACHED = '~/.cache/playwright-debs';
    const install = (job: any = local) =>
      step(job, 'Install Playwright browsers').run;
    const sha256 = (text: string) =>
      jest
        .requireActual<typeof import('crypto')>('crypto')
        .createHash('sha256')
        .update(text)
        .digest('hex');
    /** The index apt fetched: `name=version` and its SHA-256, once updated. */
    const INDEX = [
      `fonts-good=1.0-1 ${sha256('good')}`,
      `libepoch62=7:8.0.1-3ubuntu2 ${sha256('epoch')}`,
      `libbad1=2.0 ${sha256('as published')}`,
      // Ubuntu 26.04's x86-64-v3 builds: Architecture amd64, a file named
      // for the variant (resolute-updates' binary-amd64v3 index).
      `libgbm1=26.0.8-1ubuntu0.3 ${sha256('v3 build')}`,
    ];
    const fakes = {
      sudo: 'if [ "$1 $2" = "apt-get update" ]; then touch "$SANDBOX/updated"; fi',
      'apt-cache': `[ -f "$SANDBOX/updated" ] || exit 100
awk -v spec="$2" '$1 == spec { print "Package: x"; print "SHA256: " $2 }' "$SANDBOX/index"`,
      sha256sum: `exec "${process.execPath}" -e "const f = process.argv[1]; console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(f)).digest('hex') + '  ' + f)" "$1"`,
      npx: '',
      cp: '',
    };
    /** Kept files, by name, with their contents. */
    const prepare =
      (kept: Record<string, string>) =>
      (sandbox: string): void => {
        fs.writeFileSync(path.join(sandbox, 'index'), `${INDEX.join('\n')}\n`);
        const dir = path.join(sandbox, '.cache', 'playwright-debs');
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, content] of Object.entries(kept)) {
          fs.writeFileSync(path.join(dir, name), content);
        }
      };

    it('hands apt only the kept packages whose SHA-256 the index it has just fetched lists, then installs', () => {
      const kept = {
        'fonts-good_1.0-1_all.deb': 'good',
        'libepoch62_7%3a8.0.1-3ubuntu2_amd64.deb': 'epoch',
        'libbad1_2.0_amd64.deb': 'altered after it was kept',
        'libgone1_0.9_amd64.deb': 'no longer in the index',
        'libgbm1_26.0.8-1ubuntu0.3_amd64v3.deb': 'v3 build',
      };
      const result = runStep(install(), fakes, { prepare: prepare(kept) });
      expect(result.status).toBe(0);
      const sudo = result.calls.filter((call) => call.startsWith('sudo '));
      expect(sudo).toEqual([
        'sudo apt-get update -qq',
        `sudo cp ${CACHED}/fonts-good_1.0-1_all.deb ${CACHED}/libepoch62_7%3a8.0.1-3ubuntu2_amd64.deb ${CACHED}/libgbm1_26.0.8-1ubuntu0.3_amd64v3.deb /var/cache/apt/archives/`,
      ]);
      const at = (call: string) => result.calls.indexOf(call);
      expect(at(sudo[0])).toBeLessThan(
        result.calls.findIndex((call) => call.startsWith('apt-cache '))
      );
      expect(at(sudo[1])).toBeLessThan(
        at('npx playwright install --with-deps chromium webkit')
      );
      expect(result.output).toContain(
        "3 kept system package(s) match the index's SHA-256"
      );
      // A pin against the review's mutant A2, in either job (the `rm -rf`
      // dropped from `rm -rf "$debs" && mkdir -p "$debs"`): the directory is
      // emptied before apt's archive is copied in, so a restored file apt did
      // not take, altered or gone from the index, is never saved again. The
      // faked cp copies nothing, so the step leaves the directory empty.
      expect(result.left).toEqual(['playwright-debs']);
      expect(
        runStep(install(hosted), fakes, { prepare: prepare(kept) }).left
      ).toEqual(['playwright-debs']);
    });

    it('installs as before when nothing is kept, and keeps what apt downloaded for the cache', () => {
      const result = runStep(install(), fakes, { prepare: prepare({}) });
      expect(result.status).toBe(0);
      expect(result.calls[0]).toBe(
        'npx playwright install --with-deps chromium webkit'
      );
      expect(
        result.calls.filter((call) => /^(sudo|apt-cache) /.test(call))
      ).toEqual([]);
      const keep = result.calls[result.calls.length - 1].split(' ');
      expect(keep[0]).toBe('cp');
      expect(keep[1].startsWith('/var/cache/apt/archives/')).toBe(true);
      expect(keep[keep.length - 1]).toBe(`${CACHED}/`);
      expect(result.left).toEqual(['playwright-debs']);
    });

    it('leaves nothing to save when apt kept no package, rather than an empty cache', () => {
      const result = runStep(
        install(),
        { ...fakes, cp: 'exit 1' },
        { prepare: prepare({}) }
      );
      expect(result.status).toBe(0);
      expect(result.output).toContain('apt kept no package to cache.');
      expect(result.left).toEqual([]);
    });

    it('keys the cache by the image and the installed Playwright version, falling back to that version, then to the image', () => {
      const keyStep = step(local, KEY_STEP);
      expect(keyStep).toBeDefined();
      const json = (file: string) =>
        JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const installed = json('node_modules/@playwright/test/package.json')
        .version as string;
      const locked =
        json('package-lock.json').packages['node_modules/@playwright/test']
          .version;
      expect(installed).toBe(locked);
      const result = runStep(
        keyStep.run,
        {},
        {
          env: { ImageOS: 'ubuntu26', ImageVersion: '20261101.186.1' },
        }
      );
      expect(result.status).toBe(0);
      expect(result.outputs).toEqual({
        key: `playwright-debs-ubuntu26-pw${installed}-20261101.186.1`,
        'same-version': `playwright-debs-ubuntu26-pw${installed}-`,
        'same-os': 'playwright-debs-ubuntu26-',
      });
      const restore = local.steps.find(
        (each: any) => each.uses === 'actions/cache/restore@v4'
      );
      const save = local.steps.find(
        (each: any) => each.uses === 'actions/cache/save@v4'
      );
      expect(restore.id).toBe('debs-cache');
      expect(restore.with).toEqual({
        path: CACHED,
        key: `\${{ steps.${keyStep.id}.outputs.key }}`,
        'restore-keys': `\${{ steps.${keyStep.id}.outputs.same-version }}\n\${{ steps.${keyStep.id}.outputs.same-os }}\n`,
      });
      // Saved only when the exact key missed, after an install that worked.
      expect(save.if).toBe("steps.debs-cache.outputs.cache-hit != 'true'");
      expect(save.with).toEqual({ path: CACHED, key: restore.with.key });
      expect(install().match(/^debs=(\S+)$/m)?.[1]).toBe(CACHED);
      const order = steps(local);
      expect(order.indexOf('actions/cache/restore')).toBeLessThan(
        order.indexOf('Install Playwright browsers')
      );
      expect(order.indexOf('actions/cache/save')).toBeGreaterThan(
        order.indexOf('Install Playwright browsers')
      );
    });

    it('gives the hosted job the same four steps', () => {
      const four = (job: any) => {
        const from = job.steps.findIndex((each: any) => each.name === KEY_STEP);
        return from < 0 ? [] : job.steps.slice(from, from + 4);
      };
      expect(four(local)).toHaveLength(4);
      expect(four(hosted)).toEqual(four(local));
    });
  });
});

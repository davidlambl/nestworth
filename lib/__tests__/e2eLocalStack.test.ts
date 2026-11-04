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
    expect(user.email).toMatch(/^e2e-[a-z0-9]+-[0-9a-f]{6}@nestworth\.test$/);
    expect(user.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const second = await createRunUser({ ...APP, secretKey: SECRET_KEY });
    expect(second.email).not.toBe(user.email);
    expect(second.password).not.toBe(user.password);
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
    // A hung stack start or install is stopped, not left for six hours.
    expect(local['timeout-minutes']).toBe(25);
    expect(workflow.env).toBeUndefined();
  });

  it('starts the local stack, then runs the suite against it with nothing hosted in reach', () => {
    expect(steps(local)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci',
      'Install Playwright browsers',
      'Start the local Supabase stack',
      'Run Playwright',
      'actions/upload-artifact',
    ]);
    expect(local.steps[0].with).toEqual({ 'persist-credentials': false });
    expect(step(local, 'Start the local Supabase stack').run).toBe(
      'npx supabase start -x studio,postgres-meta'
    );
    // No E2E_TARGET, no Supabase URL or key: the defaults are the local
    // stack's, read by the run itself.
    expect(step(local, 'Run Playwright')).toEqual({
      name: 'Run Playwright',
      run: 'npm run e2e:web',
    });
    const commands = local.steps.map((each: any) => each.run ?? '').join('\n');
    expect(commands).not.toMatch(
      /--linked|--db-url|supabase (link|login|db push|db pull)|supabase\.co/
    );
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
    expect(hosted['timeout-minutes']).toBe(25);
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
});

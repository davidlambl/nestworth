// #191: the e2e purge signs in with the key the app builds with in the same
// environment. e2e/web/global-setup.ts is Playwright's, and jest never loads
// it on its own, so this drives its default export with Playwright and
// supabase-js mocked: no browser starts and no request is made. The purge
// stops at the mocked sign-in; the browser that would follow throws.
const mockCreateClient = jest.fn(
  (_url: string, _key: string, _options: unknown) => ({
    auth: {
      signInWithPassword: jest.fn(async () => ({
        error: { message: 'the test stops here' },
      })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  })
);
jest.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: unknown) =>
    mockCreateClient(url, key, options),
}));
jest.mock('@playwright/test', () => ({
  chromium: {
    launch: jest.fn(async () => {
      throw new Error('no browser under jest');
    }),
  },
}));

const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuv_12345678';
// Every variable the purge reads, set by each test: process.env wins over
// .env.local and .env.e2e, so a checkout's own files never decide.
const VARS = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'E2E_TEST_EMAIL',
  'E2E_TEST_PASSWORD',
  'E2E_PURGE_STALE_TEST_ACCOUNTS',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.example.invalid';
  process.env.E2E_TEST_EMAIL = 'nobody@example.invalid';
  process.env.E2E_TEST_PASSWORD = 'not-a-password';
  process.env.E2E_PURGE_STALE_TEST_ACCOUNTS = '1';
  mockCreateClient.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
  jest.restoreAllMocks();
});

/** The key the purge's client is built with under CI's two variables. */
async function purgeKey(publishable: string, anon: string): Promise<string> {
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishable;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = anon;
  jest.resetModules();
  const globalSetup = jest.requireActual('../../e2e/web/global-setup').default;
  await expect(globalSetup({ projects: [] })).rejects.toThrow(
    'no browser under jest'
  );
  expect(mockCreateClient).toHaveBeenCalledTimes(1);
  return mockCreateClient.mock.calls[0][1];
}

describe('the e2e purge signs in with the key the app builds with (#191)', () => {
  it('takes the publishable key when CI has both', async () => {
    expect(await purgeKey(PUBLISHABLE_KEY, ANON_KEY)).toBe(PUBLISHABLE_KEY);
  });

  it('takes the anon key while the publishable secret is not stored (an empty value)', async () => {
    expect(await purgeKey('', ANON_KEY)).toBe(ANON_KEY);
  });
});

// What the receipt sweep runs with (#176): scripts/receipt-sweep/config.js
// refuses, loudly and without echoing a value, anything it cannot run with.
import { keyKind, readConfig } from '../../scripts/receipt-sweep/config';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role })}.c2lnbmF0dXJl`;
const SECRET = 'sb_secret_placeholder';

const actions = (over: Record<string, string | undefined> = {}) => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_REF: 'refs/heads/main',
  RECEIPT_SWEEP_MODE: 'apply',
  SUPABASE_URL: 'https://project.supabase.co',
  RECEIPT_SWEEP_SECRET_KEY: SECRET,
  ...over,
});

/** readConfig's refusal, or null. */
function refusal(env: Record<string, string | undefined>): string | null {
  try {
    readConfig(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('keyKind: the key, read from its shape', () => {
  it.each([
    ['a secret key', 'secret', SECRET],
    ['the legacy service_role key', 'service_role', jwt('service_role')],
    [
      'a publishable key',
      'publishable',
      'sb_publishable_abcdefghijklmnopqrstuv_12345678',
    ],
    ['the legacy anon key', 'anon', jwt('anon')],
    ["a user's access token", 'authenticated', jwt('authenticated')],
    ['three dotted words', 'unknown', 'not.a.jwt'],
    ['nothing', 'missing', ''],
  ])('reads %s as %s', (_what, kind, key) => {
    expect(keyKind(key)).toBe(kind);
  });
});

describe('readConfig (#176)', () => {
  it('runs a weekly or a manual run from main with a secret key, in either mode', () => {
    expect(readConfig(actions())).toEqual({
      mode: 'apply',
      url: 'https://project.supabase.co',
      key: SECRET,
      inActions: true,
    });
    expect(
      readConfig(
        actions({
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          RECEIPT_SWEEP_MODE: 'dry-run',
          RECEIPT_SWEEP_SECRET_KEY: jwt('service_role'),
          SUPABASE_URL: 'https://project.supabase.co/',
        })
      )
    ).toMatchObject({
      mode: 'dry-run',
      url: 'https://project.supabase.co',
    });
  });

  it('refuses a run with no mode, as the weekly run has until the owner sets the variable, and names the variable', () => {
    expect(refusal(actions({ RECEIPT_SWEEP_MODE: '' }))).toMatch(
      /^RECEIPT_SWEEP_MODE is not set: .*repository variable RECEIPT_SWEEP_MODE/
    );
    expect(refusal(actions({ RECEIPT_SWEEP_MODE: 'remove' }))).toBe(
      'RECEIPT_SWEEP_MODE must be dry-run or apply.'
    );
  });

  it.each([
    [
      'a publishable key',
      'sb_publishable_abcdefghijklmnopqrstuv_12345678',
      'a publishable key',
    ],
    ['the anon key', jwt('anon'), 'the anon key'],
    ["a user's access token", jwt('authenticated'), "a user's access token"],
    [
      'a key of another role',
      jwt('supabase_admin'),
      'a key with the role supabase_admin',
    ],
    ['something else', 'hunter2', 'no kind of Supabase key'],
  ])(
    'refuses %s before any request, and never prints it',
    (_what, key, words) => {
      const message = refusal(actions({ RECEIPT_SWEEP_SECRET_KEY: key }));
      expect(message).toContain(`it reads as ${words}`);
      expect(message).not.toContain(key);
    }
  );

  it('refuses a missing key or URL, naming each', () => {
    expect(
      refusal(
        actions({ RECEIPT_SWEEP_SECRET_KEY: undefined, SUPABASE_URL: '' })
      )
    ).toBe(
      [
        'SUPABASE_URL is not set (the workflow passes the EXPO_PUBLIC_SUPABASE_URL secret).',
        'RECEIPT_SWEEP_SECRET_KEY is not set: add a secret key made for the sweep (Supabase: Project Settings > API Keys > Secret keys) as that secret.',
      ].join('\n')
    );
    expect(
      refusal(actions({ SUPABASE_URL: 'http://project.supabase.co' }))
    ).toBe(
      'SUPABASE_URL is not a project URL (https://<project>.supabase.co).'
    );
  });

  it.each(['pull_request', 'pull_request_target', 'push', 'workflow_run'])(
    'refuses to run for a %s event in Actions',
    (event) => {
      expect(refusal(actions({ GITHUB_EVENT_NAME: event }))).toBe(
        'The sweep runs only on its schedule or a manual dispatch, never for another event.'
      );
    }
  );

  it('refuses to run in Actions from any ref but main', () => {
    expect(refusal(actions({ GITHUB_REF: 'refs/heads/feat/x' }))).toBe(
      'The sweep runs only from main.'
    );
  });

  it('outside Actions, runs a dry run and refuses an apply run', () => {
    const local = {
      RECEIPT_SWEEP_MODE: 'dry-run',
      SUPABASE_URL: 'https://project.supabase.co',
      RECEIPT_SWEEP_SECRET_KEY: SECRET,
    };
    expect(readConfig(local)).toMatchObject({
      mode: 'dry-run',
      inActions: false,
    });
    expect(refusal({ ...local, RECEIPT_SWEEP_MODE: 'apply' })).toMatch(
      /^An apply run removes photos only from GitHub Actions/
    );
  });
});

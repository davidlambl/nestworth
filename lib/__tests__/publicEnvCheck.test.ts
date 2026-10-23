// #191: no EXPO_PUBLIC_* variable may hold a Supabase secret key. Babel
// inlines the app's EXPO_PUBLIC_* reads into a bundle anyone can read, and
// metro.config.js runs scripts/public-env-check.js before every build Metro
// makes (a web export, the dev server, an EAS build, the desktop build).
import { refuseSecretKeys } from '../../scripts/public-env-check';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role })}.c2lnbmF0dXJl`;
// The receipt sweep's placeholder: a secret key's prefix without a real key's
// length, since GitHub's push protection refuses a commit holding the full
// shape, and the prefix is all keyKind reads.
const SECRET_KEY = 'sb_secret_placeholder';
const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuv_12345678';

/** refuseSecretKeys's refusal, or null. */
function refusal(env: Record<string, string | undefined>): string | null {
  try {
    refuseSecretKeys(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('a Supabase secret key in an EXPO_PUBLIC_* variable stops the build (#191)', () => {
  it('refuses a secret key or the service_role key in any public variable, naming each and never a value', () => {
    const message = refusal({
      EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SECRET_KEY,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: ` ${jwt('service_role')}\n`,
      EXPO_PUBLIC_ANYTHING_ELSE: SECRET_KEY,
    });
    expect(message).toMatch(
      /^EXPO_PUBLIC_ANYTHING_ELSE, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY hold a Supabase secret key/
    );
    expect([message?.includes('sb_secret_'), message?.includes('eyJ')]).toEqual(
      [false, false]
    );
    // Pasted with a stray space or newline, as a dashboard field takes it.
    expect(
      refusal({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ` ${SECRET_KEY}\n` })
    ).toMatch(
      /^EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key/
    );
  });

  it('refuses a secret key however it was pasted: quoted, after Bearer or NAME=, or broken by an invisible character or a line break', () => {
    // Netlify's, GitHub's and EAS's fields keep a value as it was pasted (only
    // .env.local's dotenv strips quotes), Babel inlines it as it is, and anyone
    // reading the bundle takes the key back out of its wrapping.
    const [header, payload, signature] = jwt('service_role').split('.');
    const pasted: [string, string][] = [
      ['in double quotes', `"${SECRET_KEY}"`],
      ['in single quotes', `'${SECRET_KEY}'`],
      ['after Bearer', `Bearer ${SECRET_KEY}`],
      [
        'as a whole .env line',
        `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${SECRET_KEY}`,
      ],
      ['after an invisible character', `\u200b${SECRET_KEY}`],
      ['an invisible character in its prefix', 'sb_secret\u200b_placeholder'],
      ['a service_role JWT and a full stop', `${jwt('service_role')}.`],
      [
        'a service_role JWT broken by a line break',
        `${header}.${payload.slice(0, 8)}\n${payload.slice(8)}.${signature}`,
      ],
    ];
    expect(
      pasted.map(([shape, value]) => [
        shape,
        refusal({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: value }),
      ])
    ).toEqual(
      pasted.map(([shape]) => [
        shape,
        expect.stringMatching(
          /^EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key/
        ),
      ])
    );
  });

  it('passes every key the app may be built with, the placeholders, and secrets outside the public prefix', () => {
    expect(
      refusal({
        EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: jwt('anon'),
        // Not inlined: Babel inlines EXPO_PUBLIC_* alone.
        RECEIPT_SWEEP_SECRET_KEY: SECRET_KEY,
        SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
      })
    ).toBeNull();
    expect(
      refusal({
        EXPO_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
        EXPO_PUBLIC_UNSET: undefined,
      })
    ).toBeNull();
    // A key the app may be built with passes however it was pasted, too.
    expect(
      refusal({
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `"${PUBLISHABLE_KEY}"`,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: `Bearer "${jwt('anon')}".`,
      })
    ).toBeNull();
  });

  it('runs from metro.config.js before any build', () => {
    const saved = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SECRET_KEY;
    try {
      jest.isolateModules(() => {
        expect(() => jest.requireActual('../../metro.config.js')).toThrow(
          'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret key'
        );
      });
    } finally {
      if (saved === undefined) {
        delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      } else {
        process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = saved;
      }
    }
  });
});

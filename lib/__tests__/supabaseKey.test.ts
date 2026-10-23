// #191: which key a Supabase client is built with. Supabase retires the
// legacy JWT anon key by the end of 2026; its publishable key replaces it one
// for one, and every build moves over when its own environment carries the
// new key — Netlify's, CI's, the EAS environments, a developer's .env.local.
// lib/supabase.ts hands the result to createClient and to the anon-rejection
// wrapper (supabaseClient.test.ts pins that composition), and
// e2e/web/global-setup.ts builds the purge's client with it.
import fs from 'fs';
import path from 'path';
// js-yaml is in the tree through jest and eslint (types/js-yaml.d.ts); no
// dependency is added for this pin.
import { load } from 'js-yaml';
import { supabaseClientKey } from '../supabaseKey';

const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
const PUBLISHABLE_KEY = 'sb_publishable_abcdefghijklmnopqrstuv_12345678';

describe('the key a client is built with (#191)', () => {
  it('is the publishable key when the build has one, whether or not it has the anon key too', () => {
    expect(
      supabaseClientKey({ publishable: PUBLISHABLE_KEY, anon: ANON_KEY })
    ).toBe(PUBLISHABLE_KEY);
    expect(
      supabaseClientKey({ publishable: PUBLISHABLE_KEY, anon: undefined })
    ).toBe(PUBLISHABLE_KEY);
  });

  it('is the anon key when the publishable key is unset, empty or blank', () => {
    // GitHub Actions hands over a secret that does not exist as the empty
    // string, so CI names the publishable key before it has been stored.
    for (const publishable of [undefined, '', ' ', '\n', ' \t\r\n']) {
      expect([
        publishable,
        supabaseClientKey({ publishable, anon: ANON_KEY }),
      ]).toEqual([publishable, ANON_KEY]);
    }
  });

  it('returns the key chosen as given, ends and all', () => {
    // What the client was handed before #191. lib/fetchWithTimeout.ts
    // compares it with its ends trimmed, as fetch trims a header.
    expect(
      supabaseClientKey({ publishable: `${PUBLISHABLE_KEY}\n`, anon: ANON_KEY })
    ).toBe(`${PUBLISHABLE_KEY}\n`);
    expect(
      supabaseClientKey({ publishable: undefined, anon: `${ANON_KEY}\n` })
    ).toBe(`${ANON_KEY}\n`);
  });

  it('is empty when the build has neither, for createClient to refuse as before', () => {
    expect(supabaseClientKey({ publishable: undefined, anon: undefined })).toBe(
      ''
    );
    expect(supabaseClientKey({ publishable: ' ', anon: undefined })).toBe('');
    expect(supabaseClientKey({ publishable: '', anon: '' })).toBe('');
  });
});

describe('CI hands both keys to the web build and to Playwright (#191)', () => {
  const workflow = load(
    fs.readFileSync(
      path.join(__dirname, '../../.github/workflows/test.yml'),
      'utf8'
    )
  ) as any;
  // Steps are read by name or id, never by position.
  const stepEnv = (job: string, name: string) =>
    workflow.jobs[job].steps.find((step: any) => step.name === name).env;
  const probeEnv = () =>
    workflow.jobs['e2e-creds'].steps.find((step: any) => step.id === 'probe')
      .env;

  it('builds the web bundle with the publishable key once its secret exists, and with the anon key or its placeholder until then', () => {
    expect(stepEnv('build-web', 'Export web bundle')).toEqual({
      EXPO_PUBLIC_SUPABASE_URL:
        "${{ secrets.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co' }}",
      // No placeholder: an empty value falls back to the anon key, so a fork
      // and this repository before the secret is stored both build the anon
      // path, as Netlify does until its own variable is set.
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        '${{ secrets.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}',
      EXPO_PUBLIC_SUPABASE_ANON_KEY:
        "${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key' }}",
    });
  });

  it('runs Playwright with either key, and gives the app and the purge both', () => {
    expect(probeEnv().HAVE).toBe(
      "${{ secrets.E2E_TEST_EMAIL != '' && secrets.E2E_TEST_PASSWORD != '' && secrets.EXPO_PUBLIC_SUPABASE_URL != '' && (secrets.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY != '' || secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY != '') }}"
    );
    expect(stepEnv('e2e-web', 'Run Playwright')).toMatchObject({
      EXPO_PUBLIC_SUPABASE_URL: '${{ secrets.EXPO_PUBLIC_SUPABASE_URL }}',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        '${{ secrets.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}',
      EXPO_PUBLIC_SUPABASE_ANON_KEY:
        '${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY }}',
    });
  });
});

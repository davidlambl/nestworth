// #191: a build inlines BOTH key variables. When an export or an EAS build
// transforms lib/supabase.ts, babel-preset-expo replaces each literal
// `process.env.EXPO_PUBLIC_*` member with its value (isDev false); a read it
// cannot see, such as a computed name or a helper handed `process.env`, is
// left for run time, where the bundle has no such variable, and that build
// silently signs with the other key. jest itself reads the live environment
// (expo/virtual/env is process.env), so only a transform shows it.
import fs from 'fs';
import path from 'path';
import { transformSync } from '@babel/core';

const VALUES = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://inline-check.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_inline_check_value',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'inline-check-anon-value',
};

it('a production transform of lib/supabase.ts inlines the URL and both keys (#191)', () => {
  const saved = Object.fromEntries(
    Object.keys(VALUES).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, VALUES);
  try {
    const filename = path.join(__dirname, '..', 'supabase.ts');
    const code = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename,
      babelrc: false,
      configFile: false,
      presets: ['babel-preset-expo'],
      // What Metro passes for a web export; an EAS build differs only in
      // the platform.
      caller: {
        name: 'metro',
        bundler: 'metro',
        platform: 'web',
        isDev: false,
        isServer: false,
      } as any,
    })?.code;
    for (const value of Object.values(VALUES)) {
      expect([value, code?.includes(JSON.stringify(value))]).toEqual([
        value,
        true,
      ]);
    }
    // Nothing is left to read at run time.
    expect(code).not.toMatch(/process\.env\s*(\.|\[)\s*['"]?EXPO_PUBLIC_/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

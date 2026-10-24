// No EXPO_PUBLIC_* variable may hold a Supabase secret key (#191). Babel
// inlines every EXPO_PUBLIC_* value the app reads into the bundle, and the web
// bundle is public; a secret key (`sb_secret_…`, or the legacy service_role
// JWT) bypasses Row Level Security. The publishable and secret keys sit side
// by side under Settings → API Keys, so a key pasted into the wrong variable
// (Netlify's, a GitHub secret, an EAS environment, .env.local) is one copy
// away. metro.config.js runs this before every build Metro makes: a web
// export (Netlify, CI, the desktop app), the dev server, an EAS build. Such a
// build stops here, before any value is inlined anywhere.
//
// A key is looked for anywhere in a value, not only as the whole of it.
// Netlify's, GitHub's and EAS's fields keep a value as it was pasted (only
// .env.local's dotenv strips quotes), Babel inlines it as it is, and anyone
// reading the bundle takes a key back out of quotes, `Bearer `, `NAME=`, a
// space, a line break or an invisible character. So every character no key is
// made of is dropped before the value is read. A key encoded some other way
// is not recognised.
//
// Names only: no value read here is ever printed. The shape is read by the
// receipt sweep's keyKind, which wants the opposite answer.

const { keyKind } = require('./receipt-sweep/config');

// Every character a key is made of: `sb_secret_…` is letters, digits and
// underscores; a JWT is three base64url parts (letters, digits, `-`, `_`)
// joined by dots.
const NOT_IN_A_KEY = /[^A-Za-z0-9_.-]+/g;

/** Whether `value` holds a Supabase secret key anywhere in it. */
function holdsSecretKey(value) {
  const bare = String(value ?? '').replace(NOT_IN_A_KEY, '');
  if (bare.includes('sb_secret_')) {
    return true;
  }
  // keyKind reads a JWT's role from its middle part. Every part of the value
  // is read in that place, so a service_role JWT is found whatever is joined
  // to its first or last part.
  return bare
    .split('.')
    .some((part) => keyKind(`.${part}.`) === 'service_role');
}

function refuseSecretKeys(env) {
  const holding = Object.keys(env)
    .filter((name) => name.startsWith('EXPO_PUBLIC_'))
    .filter((name) => holdsSecretKey(env[name]))
    .sort();
  if (holding.length > 0) {
    throw new Error(
      `${holding.join(', ')} ${holding.length === 1 ? 'holds' : 'hold'} a Supabase secret key, which bypasses Row Level Security and would be built into the app for anyone to read. Set the project's publishable key (Supabase → Settings → API Keys) instead.`
    );
  }
}

module.exports = { refuseSecretKeys };

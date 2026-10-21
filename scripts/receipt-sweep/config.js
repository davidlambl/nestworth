// What the receipt sweep runs with (#176), read from the environment the
// workflow (.github/workflows/sweep-receipts.yml) gives it, and refused
// loudly when anything is missing or wrong. No value read here is ever
// printed: a message names the variable, never its content.
//
//   RECEIPT_SWEEP_MODE        dry-run or apply. A manual run passes its
//                             `mode` input; the weekly run reads the
//                             repository variable of that name, which the
//                             owner sets (dry-run first). Unset: refused.
//   SUPABASE_URL              the project's URL (the EXPO_PUBLIC_SUPABASE_URL
//                             secret CI already has).
//   RECEIPT_SWEEP_SECRET_KEY  a secret key (`sb_secret_…`), or the legacy
//                             service_role key. A publishable or anon key is
//                             refused before any request: under it RLS would
//                             answer every read with nothing.
//
// In GitHub Actions it runs only from main, and only on a schedule or a
// manual dispatch: never for a pull request, whose code nobody has reviewed
// yet. Outside Actions it runs only as a dry run, so every removal is in an
// Actions run's log.

const { Buffer } = require('buffer');

const MODES = ['dry-run', 'apply'];

class ConfigError extends Error {}

const KIND_WORDS = {
  publishable: 'a publishable key',
  anon: 'the anon key',
  authenticated: "a user's access token",
  unknown: 'no kind of Supabase key',
};

/** What kind of key `key` is, read from its shape, never sent anywhere. */
function keyKind(key) {
  if (!key) return 'missing';
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8')
      );
      if (payload && payload.role === 'service_role') return 'service_role';
      if (payload && typeof payload.role === 'string') return payload.role;
    } catch {
      // Not a JWT after all.
    }
  }
  return 'unknown';
}

function readConfig(env) {
  const problems = [];
  const mode = String(env.RECEIPT_SWEEP_MODE ?? '').trim();
  if (!MODES.includes(mode)) {
    problems.push(
      mode
        ? 'RECEIPT_SWEEP_MODE must be dry-run or apply.'
        : 'RECEIPT_SWEEP_MODE is not set: a manual run passes its mode input, and the weekly run reads the repository variable RECEIPT_SWEEP_MODE (set it to dry-run, then to apply once a dry run and a manual apply look right).'
    );
  }
  const url = String(env.SUPABASE_URL ?? '').trim();
  if (!/^https:\/\/[^\s/]+\/?$/.test(url)) {
    problems.push(
      url
        ? 'SUPABASE_URL is not a project URL (https://<project>.supabase.co).'
        : 'SUPABASE_URL is not set (the workflow passes the EXPO_PUBLIC_SUPABASE_URL secret).'
    );
  }
  const key = String(env.RECEIPT_SWEEP_SECRET_KEY ?? '').trim();
  const kind = keyKind(key);
  if (kind === 'missing') {
    problems.push(
      'RECEIPT_SWEEP_SECRET_KEY is not set: add a secret key made for the sweep (Supabase: Project Settings > API Keys > Secret keys) as that secret.'
    );
  } else if (kind !== 'secret' && kind !== 'service_role') {
    problems.push(
      `RECEIPT_SWEEP_SECRET_KEY is not a secret key (it reads as ${KIND_WORDS[kind] ?? `a key with the role ${kind}`}): the sweep needs a secret (service role) key, under which RLS does not hide other users' rows.`
    );
  }
  const inActions = env.GITHUB_ACTIONS === 'true';
  if (inActions) {
    if (!['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
      problems.push(
        'The sweep runs only on its schedule or a manual dispatch, never for another event.'
      );
    }
    if (env.GITHUB_REF !== 'refs/heads/main') {
      problems.push('The sweep runs only from main.');
    }
  } else if (mode === 'apply') {
    problems.push(
      'An apply run removes photos only from GitHub Actions, where its log is kept: run a dry run here, or dispatch the workflow.'
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(problems.join('\n'));
  }
  return { mode, url: url.replace(/\/$/, ''), key, inActions };
}

module.exports = { ConfigError, MODES, keyKind, readConfig };

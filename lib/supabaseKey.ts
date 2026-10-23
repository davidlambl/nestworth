/**
 * The key a Supabase client is built with (#191): Supabase's publishable key
 * (`sb_publishable_…`) when one is set, else the legacy anon key, else ''.
 *
 * Supabase is retiring the legacy JWT anon key by the end of 2026, and the
 * publishable key replaces it one for one: the server answers both as the
 * `anon` role, and a signed-in user's own token is unchanged. Builds move
 * over one environment at a time — Netlify's, CI's, the EAS environments, a
 * developer's .env.local — so each build takes whichever of the two it has:
 *
 *   - A value that is empty once trimmed counts as unset. GitHub Actions hands
 *     over a secret that does not exist as the empty string, so CI can name
 *     the publishable key's secret before it has been stored.
 *   - The value chosen is returned as given, untrimmed: what the client was
 *     handed before #191. lib/fetchWithTimeout.ts compares it with its ends
 *     trimmed, as fetch trims a header.
 *   - Neither: '', on which createClient throws "supabaseKey is required.",
 *     as it always has for a build made without its environment.
 *
 * lib/supabase.ts hands the result to createClient AND to
 * withAnonRestRejection: the refusal must compare against the key the client
 * signs with, or it refuses nothing (#109).
 *
 * It takes the two values, never `process.env` and a name: Babel replaces
 * each literal `process.env.EXPO_PUBLIC_*` read with its value when a build
 * is made, and a name looked up at run time would find nothing in the bundle.
 *
 * A leaf on purpose: it imports nothing, so e2e/web/global-setup.ts can load
 * it for the purge's own client.
 */
export function supabaseClientKey(keys: {
  publishable: string | undefined;
  anon: string | undefined;
}): string {
  const { publishable, anon } = keys;
  if (publishable !== undefined && publishable.trim() !== '') {
    return publishable;
  }
  return anon ?? '';
}

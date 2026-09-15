import appJson from '../app.json';

/**
 * The Settings footer's version line, which the README points to for checking
 * which build is running. It reads `expo.version` from app.json, so a release
 * has one fewer file to bump, and says "version unknown" rather than rendering
 * a bare "Nestworth v" if that is ever missing.
 *
 * app.json is imported into the JS bundle rather than read via
 * Constants.expoConfig, whose copy of the config can lag a version bump: an
 * incremental iOS build regenerates EXConstants.bundle but does not re-copy it
 * into the app, and on web a warm Metro cache keeps the manifest Babel inlined.
 * The JS bundle is rebuilt on every native build, and Metro keys a JSON module
 * on its contents.
 */
export function appVersionLabel(
  config: { version?: string | null } | null = appJson.expo
): string {
  const version = config?.version?.trim();
  return version ? `Nestworth v${version}` : 'Nestworth (version unknown)';
}

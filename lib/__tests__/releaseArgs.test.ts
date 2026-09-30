import { parseDesktopArgs, parseReleaseArgs } from '../../scripts/release/args';

describe('parseReleaseArgs', () => {
  it('takes one release and an optional --dry-run', () => {
    expect(parseReleaseArgs(['patch'])).toEqual({
      input: 'patch',
      dryRun: false,
      help: false,
    });
    expect(parseReleaseArgs(['1.2.0', '--dry-run'])).toEqual({
      input: '1.2.0',
      dryRun: true,
      help: false,
    });
  });

  it('honours a --dry-run that npm swallowed (npm run release patch --dry-run)', () => {
    expect(parseReleaseArgs(['patch'], { npm_config_dry_run: 'true' })).toEqual(
      { input: 'patch', dryRun: true, help: false }
    );
  });

  it('refuses a missing, doubled or invalid release, and unknown options', () => {
    expect(() => parseReleaseArgs([])).toThrow('Say which release');
    expect(() => parseReleaseArgs(['patch', 'minor'])).toThrow(
      'One version at a time'
    );
    expect(() => parseReleaseArgs(['patch', '--yes'])).toThrow(
      'Unknown option --yes.'
    );
    expect(() => parseReleaseArgs(['v1.2.0'])).toThrow('without the "v"');
  });

  it('answers --help without a release', () => {
    expect(parseReleaseArgs(['--help']).help).toBe(true);
  });
});

describe('parseDesktopArgs', () => {
  it('defaults to the newest tag, a real build and no overwrite', () => {
    expect(parseDesktopArgs([])).toEqual({
      version: null,
      dryRun: false,
      force: false,
      help: false,
    });
  });

  it('takes a version, written with or without the v, and the flags', () => {
    expect(parseDesktopArgs(['1.1.10', '--dry-run', '--force'])).toEqual({
      version: '1.1.10',
      dryRun: true,
      force: true,
      help: false,
    });
    expect(parseDesktopArgs(['v1.1.10']).version).toBe('1.1.10');
  });

  it('honours --dry-run and --force that npm swallowed', () => {
    const args = parseDesktopArgs([], {
      npm_config_dry_run: 'true',
      npm_config_force: 'true',
    });
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
  });

  it('refuses a version that is not X.Y.Z and unknown options', () => {
    expect(() => parseDesktopArgs(['1.1'])).toThrow(
      '"1.1" is not a release version'
    );
    expect(() => parseDesktopArgs(['1.1.9', '1.1.10'])).toThrow(
      'One version at a time'
    );
    expect(() => parseDesktopArgs(['--notarize'])).toThrow(
      'Unknown option --notarize.'
    );
  });
});

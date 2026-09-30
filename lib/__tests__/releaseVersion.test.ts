import {
  bumpVersion,
  compareVersions,
  isVersion,
  latestVersionTag,
  newerVersionTag,
  parseVersionInput,
  planRelease,
  previousVersionTag,
  versionTags,
} from '../../scripts/release/version';

describe('parseVersionInput', () => {
  it('takes a bump level or an exact version', () => {
    expect(parseVersionInput('patch')).toEqual({ level: 'patch' });
    expect(parseVersionInput('minor')).toEqual({ level: 'minor' });
    expect(parseVersionInput('major')).toEqual({ level: 'major' });
    expect(parseVersionInput(' 1.2.0 ')).toEqual({ version: '1.2.0' });
  });

  it('refuses what npm version would also take, and anything else', () => {
    for (const input of [
      'prerelease',
      'preminor',
      'from-git',
      '1.2.0-beta.1',
      '1.2.0+build.5',
      '1.2',
      '01.2.0',
      'patch; echo',
      '--help',
      '',
    ]) {
      expect(() => parseVersionInput(input)).toThrow(
        'is not a release version'
      );
    }
    expect(() => parseVersionInput(undefined)).toThrow(
      'is not a release version'
    );
  });

  it('says to drop a leading v', () => {
    expect(() => parseVersionInput('v1.2.0')).toThrow(
      'Write 1.2.0, without the "v".'
    );
  });
});

describe('compareVersions', () => {
  it('compares each part as a number, not as text', () => {
    expect(compareVersions('1.1.10', '1.1.9')).toBe(1);
    expect(compareVersions('1.1.9', '1.1.10')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('refuses anything but X.Y.Z', () => {
    expect(() => compareVersions('1.2', '1.2.0')).toThrow('not X.Y.Z');
    expect(isVersion('1.2.0-rc.1')).toBe(false);
  });
});

describe('bumpVersion', () => {
  it('bumps the way npm version does', () => {
    expect(bumpVersion('1.1.9', 'patch')).toBe('1.1.10');
    expect(bumpVersion('1.1.9', 'minor')).toBe('1.2.0');
    expect(bumpVersion('1.1.9', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.1.9', '1.3.0')).toBe('1.3.0');
  });

  it('refuses a current version that is not X.Y.Z', () => {
    expect(() => bumpVersion('1.1.9-rc.1', 'patch')).toThrow(
      'is not an X.Y.Z version'
    );
  });
});

describe('release tags', () => {
  const tags = [
    'v1.1.9',
    'v1.1.10',
    'v1.1.8',
    'v1.0.0',
    'nightly',
    'v1.2.0-beta.1',
    'v1.1',
  ];

  it('lists the release tags newest first and ignores the rest', () => {
    expect(versionTags(tags).map((t: { tag: string }) => t.tag)).toEqual([
      'v1.1.10',
      'v1.1.9',
      'v1.1.8',
      'v1.0.0',
    ]);
  });

  it('finds the newest', () => {
    expect(latestVersionTag(tags)).toEqual({
      tag: 'v1.1.10',
      version: '1.1.10',
    });
    expect(latestVersionTag(['nightly'])).toBeNull();
  });

  it('names a newer release, which keeps the Latest badge from a backfill', () => {
    expect(newerVersionTag(tags, '1.1.9')?.tag).toBe('v1.1.10');
    expect(newerVersionTag(tags, '1.1.10')).toBeNull();
    expect(newerVersionTag(tags, '1.2.0')).toBeNull();
    expect(newerVersionTag([], '1.0.0')).toBeNull();
  });

  it('finds the release below a version, which a backfill needs', () => {
    expect(previousVersionTag(tags, '1.2.0')?.tag).toBe('v1.1.10');
    expect(previousVersionTag(tags, '1.1.10')?.tag).toBe('v1.1.9');
    expect(previousVersionTag(tags, '1.1.9')?.tag).toBe('v1.1.8');
    expect(previousVersionTag(tags, '1.0.0')).toBeNull();
  });
});

describe('planRelease', () => {
  const tags = ['v1.1.8', 'v1.1.9'];
  const plan = (current: string, input: string, more: string[] = []) =>
    planRelease({
      current,
      input,
      tags: [...tags, ...more.filter((r) => r.startsWith('v'))],
      branches: ['main', ...more.filter((r) => r.startsWith('release/'))],
    });

  it('plans the patch release after v1.1.9', () => {
    expect(plan('1.1.9', 'patch')).toEqual({
      version: '1.1.10',
      tag: 'v1.1.10',
      branch: 'release/1.1.10',
      previousTag: 'v1.1.9',
      warnings: [],
    });
    expect(plan('1.1.9', '1.2.0').version).toBe('1.2.0');
  });

  it("refuses a version that does not move past main's version and the latest tag", () => {
    expect(() => plan('1.1.9', '1.1.9')).toThrow(
      "1.1.9 is not greater than main's version, 1.1.9. " +
        '1.1.9 is not greater than the latest release tag, v1.1.9.'
    );
    expect(() => plan('1.1.9', '1.1.8')).toThrow(
      "1.1.8 is not greater than main's version, 1.1.9."
    );
  });

  it('refuses a version below a newer tag than main knows about', () => {
    expect(() => plan('1.1.9', 'patch', ['v1.2.0'])).toThrow(
      '1.1.10 is not greater than the latest release tag, v1.2.0.'
    );
  });

  it('refuses a tag that already exists', () => {
    expect(() => plan('1.1.9', 'patch', ['v1.1.10'])).toThrow(
      'The tag v1.1.10 already exists on origin.'
    );
  });

  it("refuses when an earlier run's release branch is still on origin", () => {
    expect(() => plan('1.1.9', 'patch', ['release/1.1.10'])).toThrow(
      'release/1.1.10 already exists on origin. Open its pull request, or ' +
        'delete the branch (git push origin --delete release/1.1.10)'
    );
  });

  it("warns when main's own version was never tagged", () => {
    const next = plan('1.1.10', 'patch');
    expect(next.version).toBe('1.1.11');
    expect(next.previousTag).toBe('v1.1.9');
    expect(next.warnings).toEqual([
      expect.stringContaining("main's version 1.1.10 has no tag v1.1.10"),
    ]);
  });

  it('refuses a bad input before anything else', () => {
    expect(() => plan('1.1.9', 'v1.2.0')).toThrow('without the "v"');
  });
});

import {
  isSha,
  parseLsRemote,
  repoFromRemoteUrl,
  tagCommit,
} from '../../scripts/release/refs';

const MAIN = '6211479'.padEnd(40, '0');
const BRANCH = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);
const TAGGED = 'a0d8d03'.padEnd(40, '1');
const LIGHT = 'd'.repeat(40);

describe('parseLsRemote', () => {
  const output = [
    `${MAIN}\trefs/heads/main`,
    `${BRANCH}\trefs/heads/release/1.1.10`,
    `${TAG_OBJECT}\trefs/tags/v1.1.9`,
    `${TAGGED}\trefs/tags/v1.1.9^{}`,
    `${LIGHT}\trefs/tags/v1.0.0`,
    `${LIGHT}\trefs/pull/12/head`,
    'not a ref line',
    '',
  ].join('\n');

  it('reads branches, and tags with the commit each points at', () => {
    const refs = parseLsRemote(output);
    expect([...refs.heads]).toEqual([
      ['main', MAIN],
      ['release/1.1.10', BRANCH],
    ]);
    expect(refs.tags.get('v1.1.9')).toEqual({
      object: TAG_OBJECT,
      commit: TAGGED,
    });
    expect(refs.tags.get('v1.0.0')).toEqual({ object: LIGHT, commit: LIGHT });
    expect([...refs.tags.keys()]).toEqual(['v1.1.9', 'v1.0.0']);
  });

  it('takes the peeled commit whichever line comes first', () => {
    const refs = parseLsRemote(
      `${TAGGED}\trefs/tags/v1.1.9^{}\n${TAG_OBJECT}\trefs/tags/v1.1.9\n`
    );
    expect(refs.tags.get('v1.1.9')).toEqual({
      object: TAG_OBJECT,
      commit: TAGGED,
    });
  });

  it("gives an annotated tag's commit, not the tag object", () => {
    const refs = parseLsRemote(output);
    expect(tagCommit(refs, 'v1.1.9')).toBe(TAGGED);
    expect(tagCommit(refs, 'v1.0.0')).toBe(LIGHT);
    expect(tagCommit(refs, 'v2.0.0')).toBeNull();
  });
});

describe('isSha', () => {
  it('takes a full lowercase commit SHA only', () => {
    expect(isSha(MAIN)).toBe(true);
    expect(isSha('6211479')).toBe(false);
    expect(isSha(TAG_OBJECT.toUpperCase())).toBe(false);
    expect(isSha(`--${MAIN.slice(2)}`)).toBe(false);
    expect(isSha(undefined)).toBe(false);
  });
});

describe('repoFromRemoteUrl', () => {
  it('reads owner/repo from the https and ssh forms', () => {
    for (const url of [
      'https://github.com/davidlambl/nestworth.git',
      'https://github.com/davidlambl/nestworth',
      'git@github.com:davidlambl/nestworth.git',
      'ssh://git@github.com/davidlambl/nestworth.git',
    ]) {
      expect(repoFromRemoteUrl(url)).toBe('davidlambl/nestworth');
    }
  });

  it('refuses a remote that is not on GitHub', () => {
    expect(() =>
      repoFromRemoteUrl('https://gitlab.com/davidlambl/nestworth.git')
    ).toThrow('is not a GitHub repository URL');
  });
});

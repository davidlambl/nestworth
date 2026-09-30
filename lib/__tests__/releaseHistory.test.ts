import { readHistory } from '../../scripts/release/history';
import { fakeIo } from '../testing/releaseFakes';

// Which commit on main made a release, read from a clone's history. Shared
// by Publish release and `npm run release:desktop`.

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

// main's first-parent history of package.json, newest first, as
// [commit, version, parent's version].
function clone(history: [string, string, string][]) {
  const w = fakeIo((command: string, args: string[]) => {
    const words = [command, ...args].join(' ');
    if (
      words === 'git log --first-parent --format=%H origin/main -- package.json'
    ) {
      return history.map(([commit]) => commit).join('\n');
    }
    if (words === 'git show origin/main:package.json') {
      return JSON.stringify({ version: history[0][1] });
    }
    if (command === 'git' && args[0] === 'show') {
      const [, commit, parent] =
        /^([0-9a-f]{40})(\^?):package\.json$/.exec(args[1]) ?? [];
      const row = history.find(([c]) => c === commit);
      if (!row) return { status: 128, stdout: '', stderr: 'bad object' };
      return JSON.stringify({ version: parent ? row[2] : row[1] });
    }
    return { status: 128, stdout: '', stderr: 'unexpected' };
  });
  return { ...w, history: readHistory({ run: w.io.run, git: w.io.git }) };
}

describe('readHistory', () => {
  it('finds the commit that moved package.json to a version', () => {
    const { history } = clone([
      [sha(3), '1.2.0', '1.2.0'], // a later fix
      [sha(2), '1.2.0', '1.1.9'], // chore: release 1.2.0
      [sha(1), '1.1.9', '1.1.8'],
    ]);
    expect(history.releaseCommitOn('origin/main', '1.2.0')).toBe(sha(2));
    expect(history.releaseCommitOn('origin/main', '1.1.9')).toBe(sha(1));
  });

  it('takes the newest release commit when a version was bumped twice', () => {
    // 1.2.0 bumped, reverted, bumped again: the last bump is the release.
    const { history } = clone([
      [sha(5), '1.2.0', '1.1.9'],
      [sha(4), '1.1.9', '1.2.0'],
      [sha(3), '1.2.0', '1.1.9'],
      [sha(1), '1.1.9', '1.1.8'],
    ]);
    expect(history.releaseCommitOn('origin/main', '1.2.0')).toBe(sha(5));
  });

  it('passes over a revert that moved the version back down to it', () => {
    // The reviewer's repro: 1.2.1 released untagged at 6c6bc49, 1.2.2
    // released, then 1.2.2's bump reverted at 0477103.
    const { history } = clone([
      [sha(5), '1.2.1', '1.2.2'], // revert of the 1.2.2 bump
      [sha(4), '1.2.2', '1.2.1'], // chore: release 1.2.2
      [sha(3), '1.2.1', '1.2.0'], // chore: release 1.2.1
      [sha(2), '1.2.0', '1.1.9'],
    ]);
    expect(history.releaseCommitOn('origin/main', '1.2.1')).toBe(sha(3));
    // The revert is still main's newest version change.
    expect(history.lastVersionChange('origin/main')).toBe(sha(5));
  });

  it("finds main's newest version change, past commits that keep the version", () => {
    const { history } = clone([
      [sha(3), '1.2.0', '1.2.0'], // touched package.json, same version
      [sha(2), '1.2.0', '1.1.9'],
      [sha(1), '1.1.9', '1.1.8'],
    ]);
    expect(history.lastVersionChange('origin/main')).toBe(sha(2));
  });

  it('reads back only as far as the release commit', () => {
    const w = clone([
      [sha(2), '1.2.0', '1.1.9'],
      [sha(1), '1.1.9', '1.1.8'],
    ]);
    w.history.releaseCommitOn('origin/main', '1.2.0');
    expect(w.calls.some((c) => c[2]?.startsWith(sha(1)))).toBe(false);
  });

  it('finds nothing for a version main never had', () => {
    const { history } = clone([[sha(1), '1.1.9', '1.1.8']]);
    expect(history.releaseCommitOn('origin/main', '1.3.0')).toBeNull();
  });

  it('reads a version at any ref, and null for a file that is not there', () => {
    const { history } = clone([[sha(2), '1.2.0', '1.1.9']]);
    expect(history.versionAt('origin/main:package.json')).toBe('1.2.0');
    expect(history.versionAt(`${sha(9)}:package.json`)).toBeNull();
  });
});

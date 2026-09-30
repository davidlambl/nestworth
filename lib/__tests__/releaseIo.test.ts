import {
  escapeData,
  outputEntry,
  runStep,
  shellQuote,
} from '../../scripts/release/io';

describe('shellQuote', () => {
  it('leaves plain words alone and quotes the rest for the echo', () => {
    expect(shellQuote('refs/tags/v1.1.10')).toBe('refs/tags/v1.1.10');
    expect(shellQuote('user.name=github-actions[bot]')).toBe(
      "'user.name=github-actions[bot]'"
    );
    expect(shellQuote('chore: release 1.1.10')).toBe("'chore: release 1.1.10'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('escapeData', () => {
  it('keeps a multi-line message in one workflow command', () => {
    expect(escapeData('100% done\r\nnext')).toBe('100%25 done%0D%0Anext');
  });
});

describe('outputEntry', () => {
  it('writes the delimiter form, which carries any value', () => {
    expect(outputEntry('release', 'true', 'EOF_1')).toBe(
      'release<<EOF_1\ntrue\nEOF_1\n'
    );
    expect(outputEntry('body', 'a\nb', 'EOF_1')).toBe(
      'body<<EOF_1\na\nb\nEOF_1\n'
    );
  });

  it('refuses a value that contains the delimiter', () => {
    expect(() => outputEntry('body', 'x\nEOF_1\ny', 'EOF_1')).toThrow(
      'contains its own delimiter'
    );
  });
});

describe('runStep', () => {
  const steps = { find: () => 'found', tag: () => 'tagged' };

  it('runs the named step', () => {
    expect(runStep(steps, 'tag', 'publish.js')).toBe('tagged');
  });

  it('answers anything else, inherited names included, with the usage', () => {
    for (const name of ['push', 'constructor', 'toString', undefined]) {
      expect(() => runStep(steps, name, 'publish.js')).toThrow(
        'Usage: node scripts/release/publish.js <find|tag>'
      );
    }
  });
});

import { testsVerdict } from '../../scripts/release/ci';

const SHA = '6211479'.padEnd(40, '0');
const OTHER = 'f'.repeat(40);

const run = (over: Record<string, unknown> = {}) => ({
  id: 100,
  head_sha: SHA,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-29T21:00:00Z',
  html_url: 'https://github.com/davidlambl/nestworth/actions/runs/100',
  ...over,
});

describe('testsVerdict', () => {
  it('passes a green push run of the commit on main', () => {
    expect(testsVerdict([run()], SHA)).toEqual({
      ok: true,
      url: 'https://github.com/davidlambl/nestworth/actions/runs/100',
      message:
        "main's Tests run for 6211479 passed: https://github.com/davidlambl/nestworth/actions/runs/100",
    });
  });

  it('refuses when the commit has no run yet', () => {
    const verdict = testsVerdict([], SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(
      "main's Tests workflow has no run for 6211479 yet"
    );
  });

  it('ignores runs of other commits, of pull requests and of other branches', () => {
    const verdict = testsVerdict(
      [
        run({ head_sha: OTHER }),
        run({ event: 'pull_request' }),
        run({ head_branch: 'feat/release-workflow' }),
      ],
      SHA
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('has no run for 6211479 yet');
  });

  it('refuses a run that has not finished', () => {
    const verdict = testsVerdict(
      [run({ status: 'in_progress', conclusion: null })],
      SHA
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('is still in progress');
  });

  it('refuses a red run and names how it ended', () => {
    const verdict = testsVerdict([run({ conclusion: 'failure' })], SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('ended "failure"');
    expect(verdict.url).toBe(
      'https://github.com/davidlambl/nestworth/actions/runs/100'
    );
  });

  it("goes by the commit's newest run", () => {
    const older = run({
      id: 1,
      conclusion: 'failure',
      created_at: '2026-09-29T20:00:00Z',
    });
    const newer = run({ id: 2, created_at: '2026-09-29T21:00:00Z' });
    expect(testsVerdict([older, newer], SHA).ok).toBe(true);
    expect(
      testsVerdict(
        [
          run({ id: 1, created_at: '2026-09-29T20:00:00Z' }),
          run({ id: 2, conclusion: 'cancelled' }),
        ],
        SHA
      ).ok
    ).toBe(false);
  });
});

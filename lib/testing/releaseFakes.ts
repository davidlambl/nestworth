import * as realIo from '../../scripts/release/io';

// A recording stand-in for scripts/release/io, for driving the release step
// runners (prepare, publish, release, release-desktop) without git, gh or a
// shell. Every command is recorded as [command, ...args]; `answer` decides
// what each returns (a string is stdout with exit 0). ghApi calls are
// recorded as ['gh', 'api', ...args, JSON body] and answered by `api`.

export type RunResult = { status: number; stdout: string; stderr: string };
export type RunOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  allowFailure?: boolean;
  inherit?: boolean;
};
export type Answer = (
  command: string,
  args: string[],
  options: RunOptions
) => RunResult | string | undefined;
export type ApiAnswer = (args: string[], body: unknown) => unknown;

export function fakeIo(answer: Answer = () => undefined, api?: ApiAnswer) {
  const calls: string[][] = [];
  const summary: string[] = [];
  const outputs: Record<string, string> = {};
  const annotations: [string, string][] = [];
  const run = (command: string, args: string[], options: RunOptions = {}) => {
    calls.push([command, ...args]);
    const got = answer(command, args, options);
    const result: RunResult =
      typeof got === 'string'
        ? { status: 0, stdout: got, stderr: '' }
        : (got ?? { status: 0, stdout: '', stderr: '' });
    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(
        `\`${command} ${args.slice(0, 2).join(' ')}\` failed (exit ${result.status}): ${result.stderr}`
      );
    }
    return result;
  };
  const io = {
    ...realIo,
    run,
    git: (args: string[], options?: RunOptions) =>
      run('git', args, options).stdout.trim(),
    ghApi: (args: string[], body?: unknown) => {
      calls.push([
        'gh',
        'api',
        ...args,
        ...(body === undefined ? [] : [JSON.stringify(body)]),
      ]);
      return api ? api(args, body) : null;
    },
    appendSummary: (markdown: string) => {
      summary.push(markdown);
    },
    setOutput: (name: string, value: unknown) => {
      outputs[name] = String(value);
    },
    annotate: (level: string, message: string) => {
      annotations.push([level, message]);
    },
  };
  return {
    io: io as unknown as typeof realIo,
    calls,
    summary,
    outputs,
    annotations,
    // Whether any recorded call starts with these words.
    ran: (...words: string[]) =>
      calls.some((call) => words.every((word, i) => call[i] === word)),
    text: () => summary.join('\n'),
  };
}

// scripts/sweep-receipts.js, the thin command the workflow runs (#176): it
// refuses before making a client, runs the sweep with a client that never
// holds a session, prints only redacted lines, each on one line, writes the
// job summary, and exits 1 whenever the run was refused or stopped.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClient as realCreateClient } from '@supabase/supabase-js';
import { makeSupabase, type Objects, type Store } from '../testing/syncFixture';
import { main } from '../../scripts/sweep-receipts';

const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';
const TXN = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY = `${USER}/${TXN}.jpg`;
const SECRET = 'sb_secret_placeholder';
const ANY_UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

let dir: string;
let store: Store;
let objects: Objects;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-sweep-'));
  store = { transactions: [], purged_ids: [] };
  objects = new Map([
    [
      `receipts/${KEY}`,
      {
        contentType: 'image/jpeg',
        body: 'x',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        size: 3,
      },
    ],
  ]);
  lines = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}) => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
  RECEIPT_SWEEP_MODE: 'dry-run',
  SUPABASE_URL: 'https://project.supabase.co',
  RECEIPT_SWEEP_SECRET_KEY: SECRET,
  ...over,
});

function run(
  over: Record<string, string> = {},
  opts: Record<string, unknown> = {}
) {
  const createClient = jest.fn(() =>
    makeSupabase(
      store,
      { serviceRole: true, projectReads: true, ...opts },
      objects
    )
  );
  const code = main({
    env: env(over) as any,
    createClient: createClient as any,
    write: (line: string) => lines.push(line),
    now: NOW,
  });
  return { code, createClient };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * main() with the real supabase-js, every request it sends answered by
 * `answer`, or failed when `answer` throws: the network and the gateway as
 * the owner's runs meet them, whose answers the fixture's fakes do not
 * shape (postgrest-js answers a fetch that throws with status 0, and a
 * body that is not JSON as its message).
 */
function runReal(answer: (url: URL) => Promise<Response>) {
  const createClient = jest.fn((url: string, key: string, options: any) =>
    realCreateClient(url, key, {
      ...options,
      global: {
        fetch: (input: any) =>
          answer(new URL(typeof input === 'string' ? input : input.url)),
      },
    })
  );
  return main({
    env: env() as any,
    createClient: createClient as any,
    write: (line: string) => lines.push(line),
    now: NOW,
  });
}

describe('scripts/sweep-receipts.js (#176)', () => {
  it('a dry run: a client with no session, one line per photo it would remove, the job summary, exit 0, and no id anywhere', async () => {
    const { code, createClient } = run();

    expect(await code).toBe(0);
    expect(createClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      SECRET,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        // One attempt per request (#51): a failed read is not retried.
        db: { retry: false },
      }
    );
    expect(objects.has(`receipts/${KEY}`)).toBe(true);
    expect(lines[0]).toMatch(
      /^would remove: photo [0-9a-f]{12} \(transaction [0-9a-f]{12}, missing\), written 334 days ago, 3 bytes$/
    );
    const summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('| Would remove | 1 |');
    for (const text of [...lines, summary]) {
      expect([text, ANY_UUID.test(text)]).toEqual([text, false]);
      expect(text).not.toContain(SECRET);
    }
  });

  it('an apply run removes, and says so', async () => {
    expect(await run({ RECEIPT_SWEEP_MODE: 'apply' }).code).toBe(0);
    expect(objects.size).toBe(0);
    expect(lines[0]).toMatch(/^removed: photo /);
  });

  it('refuses before making any client, in one workflow error line, never echoing the key', async () => {
    const { code, createClient } = run({
      RECEIPT_SWEEP_MODE: '',
      RECEIPT_SWEEP_SECRET_KEY:
        'sb_publishable_abcdefghijklmnopqrstuv_12345678',
    });

    expect(await code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::error title=Receipt sweep refused::RECEIPT_SWEEP_MODE is not set: .*%0ARECEIPT_SWEEP_SECRET_KEY is not a secret key/
    );
    expect(lines[0]).not.toContain('sb_publishable_');
  });

  it('prints no id when a removal fails with an error that quotes the key, in its own error line as in the summary', async () => {
    const createClient = jest.fn(() => {
      const c = makeSupabase(
        store,
        { serviceRole: true, projectReads: true },
        objects
      ) as any;
      const from = c.storage.from;
      c.storage.from = (bucket: string) => ({
        ...from(bucket),
        remove: async (paths: string[]) => ({
          data: null,
          error: {
            message: `Timed out waiting for the lock on receipts/${paths[0]}`,
            statusCode: '500',
          },
        }),
      });
      return c;
    });

    const code = await main({
      env: env({ RECEIPT_SWEEP_MODE: 'apply' }) as any,
      createClient: createClient as any,
      write: (line: string) => lines.push(line),
      now: NOW,
    });

    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(
      /^::error title=Receipt sweep stopped::removing 1 photo\(s\) failed: Timed out waiting for the lock on receipts\/<id>\/<id>\.jpg \(500\)$/
    );
    for (const text of lines) {
      expect([text, ANY_UUID.test(text)]).toEqual([text, false]);
    }
  });

  it('exits 1 with a workflow error when the run stops', async () => {
    const { code } = run({}, { errorReadsOn: new Set(['purged_ids']) });

    expect(await code).toBe(1);
    expect(lines[lines.length - 1]).toBe(
      '::error title=Receipt sweep stopped::reading purged_ids got no answer (a network error), so the key was not checked: network unreachable'
    );
  });

  it('a run that gets no answer from the server says so, blames no key, and prints no listing it never made', async () => {
    // What Node's fetch throws when the host cannot be reached.
    const code = await runReal(async () => {
      throw new TypeError('fetch failed');
    });

    expect(code).toBe(1);
    const stop =
      'reading purged_ids got no answer (a network error), so the key was not checked: TypeError: fetch failed';
    expect(lines).toEqual([
      'Receipt sweep, dry-run, 2026-12-01T00:00:00.000Z, grace 30 days.',
      `Stopped before listing the bucket, so nothing was removed: ${stop}`,
      `::error title=Receipt sweep stopped::${stop}`,
    ]);
    const summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    expect(summary).not.toContain('Photos listed');
    expect(summary).toContain(
      `**Stopped before listing the bucket, so nothing was removed:** ${stop}`
    );
  });

  it('names the key as the cause only when the server refuses it', async () => {
    const refused =
      'the key cannot read purged_ids, which only a secret (service role) key can: ';
    const cases: [() => Response, string][] = [
      // The gateway, for a key it does not know.
      [
        () => json(401, { message: 'Invalid API key' }),
        `${refused}Invalid API key`,
      ],
      // PostgREST, for a user's token (008 revokes purged_ids).
      [
        () =>
          json(403, {
            code: '42501',
            details: null,
            hint: null,
            message: 'permission denied for table purged_ids',
          }),
        `${refused}permission denied for table purged_ids (42501)`,
      ],
      // A server error, which says nothing about the key.
      [
        () => new Response('Bad Gateway', { status: 502 }),
        'reading purged_ids failed with HTTP 502 (not a refusal), so the key was not checked: Bad Gateway',
      ],
    ];
    for (const [answer, stop] of cases) {
      lines = [];
      expect(await runReal(async () => answer())).toBe(1);
      expect(lines[lines.length - 1]).toBe(
        `::error title=Receipt sweep stopped::${stop}`
      );
    }
  });

  it('prints a many-line error on one line, so no line of it can start a workflow command', async () => {
    // A gateway's error page for the names read: line breaks, a %, and a
    // line that would be a command to the runner if it reached the log on
    // its own.
    const page =
      '<html>\r\n<body>502: 100% of upstreams failed</body>\r\n::warning::not a command\r\n</html>';
    const code = await runReal(async (url) => {
      if (url.pathname.endsWith('/rest/v1/purged_ids')) return json(200, []);
      if (url.pathname.endsWith('/object/list/receipts')) {
        return json(200, []);
      }
      return new Response(page, {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    });

    expect(code).toBe(1);
    const stop =
      'reading the transactions that name a receipt failed: <html>%0D%0A<body>502: 100%25 of upstreams failed</body>%0D%0A::warning::not a command%0D%0A</html>';
    expect(lines.slice(-2)).toEqual([
      `Stopped: ${stop}`,
      `::error title=Receipt sweep stopped::${stop}`,
    ]);
    for (const line of lines) {
      expect([line, /[\r\n]/.test(line)]).toEqual([line, false]);
    }
    // The job summary carries it on one line too.
    const summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    expect(summary.split('\n').slice(-3)).toEqual([
      '',
      `**Stopped:** ${stop}`,
      '',
    ]);
  });
});

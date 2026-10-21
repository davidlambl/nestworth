// What the receipt sweep (#176) SENDS, through the real supabase-js: the
// fixture's fakes answer calls, never URLs, so they cannot see a request the
// edge would refuse for its length. Here the real client builds every
// request and an in-process fake of PostgREST and Storage answers it in their
// wire formats, refusing a URL longer than the edge takes with 414
// (Cloudflare, in front of the project's API, refuses a URL over 16 KB;
// postgrest-js warns past 8,000 characters). Each last look sends up to 50
// keys in one URL, so the key's shape bounds it.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { createClient } from '@supabase/supabase-js';
import { sweepReceipts } from '../../scripts/receipt-sweep/sweep';

/** postgrest-js's own urlLengthLimit: the budget every request keeps to. */
const URL_BUDGET = 8000;
/** What the edge refuses with 414. */
const EDGE_LIMIT = 16384;
const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

let objects: Map<string, { written: number }>;
let sent: { url: string; status: number }[];

const json = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** PostgREST over no rows (every photo here is named by nothing). */
function rest(url: URL, init: any) {
  const prefer = new Headers(init.headers ?? {}).get('prefer') ?? '';
  const counted = /count=exact/.test(prefer);
  return json(200, [], counted ? { 'content-range': '*/0' } : {});
}

/** Storage's listing (storage.search: folders at the root) and removal. */
function storage(url: URL, init: any) {
  if (url.pathname.endsWith('/object/list/receipts')) {
    const { prefix, limit, offset } = JSON.parse(init.body);
    const names = [...objects.keys()].sort();
    const level = prefix
      ? names
          .filter((name) => name.startsWith(`${prefix}/`))
          .map((name) => ({
            name: name.slice(prefix.length + 1),
            id: `id-${name.length}`,
            created_at: daysAgo(objects.get(name)!.written),
            updated_at: daysAgo(objects.get(name)!.written),
            metadata: { size: 1 },
          }))
      : [...new Set(names.map((name) => name.split('/')[0]))].map((folder) => ({
          name: folder,
          id: null,
        }));
    return json(200, level.slice(offset, offset + Math.min(limit, 1500)));
  }
  const { prefixes } = JSON.parse(init.body);
  const deleted = prefixes.filter((name: string) => objects.delete(name));
  return json(
    200,
    deleted.map((name: string) => ({ name, bucket_id: 'receipts' }))
  );
}

async function edge(input: any, init: any = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const record = { url: url.toString(), status: 414 };
  sent.push(record);
  if (record.url.length > EDGE_LIMIT) {
    return new Response('URI Too Long', { status: 414 });
  }
  record.status = 200;
  return url.pathname.startsWith('/rest/v1/')
    ? rest(url, init)
    : storage(url, init);
}

const client = () =>
  createClient(
    'https://abcdefghijklmnopqrst.supabase.co',
    'sb_secret_placeholder',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: edge as any },
    }
  );

beforeEach(() => {
  objects = new Map();
  sent = [];
});

describe('the receipt sweep through the real supabase-js (#176)', () => {
  it('keeps every request URL within 8,000 characters, the longest keys the shape admits included', async () => {
    for (let n = 1; n <= 600; n += 1) {
      objects.set(
        `${USER}/${id('aaaaaaaa', n)}.${id('bbbbbbbb', n)}.abcdefgh`,
        {
          written: 400,
        }
      );
    }

    const report = await sweepReceipts(client() as any, {
      mode: 'apply',
      now: NOW,
    });

    expect(report.stopped).toBeNull();
    expect(
      report.records.filter((r: any) => r.result === 'removed')
    ).toHaveLength(500);
    const longest = Math.max(...sent.map((r) => r.url.length));
    expect(longest).toBeLessThanOrEqual(URL_BUDGET);
  });

  it("is not stalled by a user's own long-named objects: they are kept as unknown keys and never sent in a request", async () => {
    objects.set(`${USER}/${id('aaaaaaaa', 1)}.${id('bbbbbbbb', 1)}.jpg`, {
      written: 60,
    });
    for (let n = 1; n <= 40; n += 1) {
      objects.set(
        `${OTHER}/${id('cccccccc', n)}.${id('dddddddd', n)}.${'a'.repeat(900)}`,
        { written: 90 }
      );
    }

    for (let week = 0; week < 2; week += 1) {
      const report = await sweepReceipts(client() as any, {
        mode: 'apply',
        now: NOW + week * 7 * DAY,
      });
      expect(report.stopped).toBeNull();
    }

    expect(sent.every((r) => r.status === 200)).toBe(true);
    expect([...objects.keys()].filter((k) => k.startsWith(OTHER))).toHaveLength(
      40
    );
    expect([...objects.keys()].filter((k) => k.startsWith(USER))).toEqual([]);
  });
});

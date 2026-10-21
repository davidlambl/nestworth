// What a receipt sweep run prints (#176): the repository and its Actions logs
// are public, and a receipt's key carries its user's and its transaction's
// ids, so nothing printed may hold either.
import {
  anomalyLine,
  digest,
  recordLine,
  redactIds,
  summaryLines,
  summaryMarkdown,
} from '../../scripts/receipt-sweep/report';

const USER = '60d2c68b-1111-4222-8333-444455556666';
const TXN = '0e4fe9ed-a6e8-421f-a94c-59c3e1dbeb64';
const UPLOAD = '148f9d26-aaaa-4bbb-8ccc-dddddddddddd';
const KEY = `${USER}/${TXN}.${UPLOAD}.jpg`;
const ANY_UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

const report = (over: Record<string, unknown> = {}) => ({
  mode: 'apply',
  startedAt: '2026-12-01T00:00:00.000Z',
  graceDays: 30,
  folders: 2,
  nestedFolders: 1,
  listed: 9,
  states: { named: 4, orphan: 3, young: 1, 'unknown-key': 1 },
  anomalies: [{ key: `${USER}/scan.jpg`, state: 'unknown-key' }],
  records: [
    {
      key: KEY,
      result: 'removed',
      ageDays: 400,
      size: 1000,
      transaction: 'live',
    },
    {
      key: `${USER}/${TXN}.jpg`,
      result: 'already-gone',
      ageDays: 90,
      size: null,
      transaction: 'purged',
    },
    {
      key: `${USER}/${UPLOAD}.png`,
      result: 'renamed',
      ageDays: 31,
      size: 5,
      transaction: 'live',
    },
  ],
  deferred: 2,
  stopped: `removing 1 photo(s) failed: invalid input syntax for type uuid: "${TXN}"`,
  ...over,
});

describe('the sweep prints no key, user or transaction (#176)', () => {
  it('a digest is the first 12 hex digits of the SHA-256 of the key, as the SQL editor computes it', () => {
    // select left(encode(sha256(convert_to('u/t1.abc.jpg', 'UTF8')), 'hex'), 12)
    // answered d8591aa1432a on the production database (read-only, 2026-10-21).
    expect(digest('u/t1.abc.jpg')).toBe('d8591aa1432a');
  });

  it('every line, the summary and the job summary carry no UUID, and name each photo by its digest', () => {
    const r = report();
    const lines = [
      ...r.records.map(recordLine),
      ...r.anomalies.map(anomalyLine),
      ...summaryLines(r),
      summaryMarkdown(r),
    ];
    for (const line of lines) {
      expect([line, ANY_UUID.test(line)]).toEqual([line, false]);
    }
    expect(recordLine(r.records[0])).toBe(
      `removed: photo ${digest(KEY)} (transaction ${digest(TXN)}, live), written 400 days ago, 1000 bytes`
    );
    expect(recordLine(r.records[1])).toBe(
      `already gone: photo ${digest(`${USER}/${TXN}.jpg`)} (transaction ${digest(TXN)}, purged), written 90 days ago, size unknown`
    );
  });

  it('redacts a UUID wherever an error quotes one', () => {
    expect(redactIds(`no row ${TXN} in ${USER.toUpperCase()}/x`)).toBe(
      'no row <id> in <id>/x'
    );
  });

  it("the closing lines give the run's totals, and a dry run says it removed nothing", () => {
    expect(summaryLines(report())).toEqual([
      'Receipt sweep, apply, 2026-12-01T00:00:00.000Z, grace 30 days.',
      'Listed 9 photo(s) in 2 folder(s), and 1 folder(s) inside a folder, not looked into: named 4, orphan 3, unknown-key 1, young 1.',
      'Removed 1 photo(s) (1000 bytes); 1 already gone; 1 named again at the last look; 2 left for the next run.',
      'Stopped: removing 1 photo(s) failed: invalid input syntax for type uuid: "<id>"',
    ]);
    const dry = report({
      mode: 'dry-run',
      stopped: null,
      records: [
        {
          key: KEY,
          result: 'would-remove',
          ageDays: 400,
          size: 1,
          transaction: 'missing',
        },
      ],
    });
    expect(summaryLines(dry)[2]).toBe(
      "Would remove 1 photo(s); 0 named again at the last look; 2 over this run's limit. Nothing was removed (dry run)."
    );
    expect(summaryMarkdown(dry)).toContain('| Would remove | 1 |');
  });

  it('a run stopped before its listing gives no count it never made, and every stop message is printed on one line', () => {
    const notListed = report({
      folders: 0,
      nestedFolders: 0,
      listed: null,
      states: {},
      anomalies: [],
      records: [],
      deferred: 0,
      stopped: `reading purged_ids failed with HTTP 502 (not a refusal), so the key was not checked: <html>\r\n100% down, request ${TXN}\n</html>`,
    });
    expect(summaryLines(notListed)).toEqual([
      'Receipt sweep, apply, 2026-12-01T00:00:00.000Z, grace 30 days.',
      'Stopped before listing the bucket, so nothing was removed: reading purged_ids failed with HTTP 502 (not a refusal), so the key was not checked: <html>%0D%0A100%25 down, request <id>%0A</html>',
    ]);
    const markdown = summaryMarkdown(notListed);
    expect([markdown, ANY_UUID.test(markdown)]).toEqual([markdown, false]);
    for (const row of ['Photos listed', 'User folders', 'Removed', 'Left']) {
      expect(markdown).not.toContain(row);
    }
    // The job summary's stop line is the log's, on one line too.
    expect(markdown.split('\n').slice(-3)).toEqual([
      '',
      '**Stopped before listing the bucket, so nothing was removed:** reading purged_ids failed with HTTP 502 (not a refusal), so the key was not checked: <html>%0D%0A100%25 down, request <id>%0A</html>',
      '',
    ]);

    // Listed, then stopped before deciding anything: it says so.
    const listedThenStopped = report({
      states: {},
      records: [],
      deferred: 0,
      stopped:
        'reading the transactions that name a receipt failed: Bad Gateway\n100%',
    });
    expect(summaryLines(listedThenStopped)).toEqual([
      'Receipt sweep, apply, 2026-12-01T00:00:00.000Z, grace 30 days.',
      'Listed 9 photo(s) in 2 folder(s), and 1 folder(s) inside a folder, not looked into: none decided before the stop.',
      'Removed 0 photo(s) (0 bytes); 0 already gone; 0 named again at the last look; 0 left for the next run.',
      'Stopped: reading the transactions that name a receipt failed: Bad Gateway%0A100%25',
    ]);
    expect(summaryMarkdown(listedThenStopped).split('\n').slice(-3)).toEqual([
      '',
      '**Stopped:** reading the transactions that name a receipt failed: Bad Gateway%0A100%25',
      '',
    ]);
  });
});

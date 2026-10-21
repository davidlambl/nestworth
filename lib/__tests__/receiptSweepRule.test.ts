// The receipt sweep's rule (#176), alone: scripts/receipt-sweep/rule.js.
// A photo is removed only when no transaction names it, its bytes are 30
// days old, and its own transaction has not changed for 30 days (or is
// gone); everything the rule cannot read is kept.
import {
  GRACE_MS,
  STATES,
  firstLook,
  keyOwner,
  secondLook,
} from '../../scripts/receipt-sweep/rule';

const NOW = Date.parse('2026-12-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
/** PostgREST renders timestamptz with microseconds and '+00:00'. */
const pgDaysAgo = (n: number) => daysAgo(n).replace('Z', '123+00:00');

const USER = '60d2c68b-1111-4222-8333-444455556666';
const OTHER_USER = '70d2c68b-1111-4222-8333-444455556666';
const TXN = '0e4fe9ed-a6e8-421f-a94c-59c3e1dbeb64';
const UPLOAD = '148f9d26-aaaa-4bbb-8ccc-dddddddddddd';
const OLD_KEY = `${USER}/${TXN}.jpg`;
const KEY = `${USER}/${TXN}.${UPLOAD}.png`;

const photo = (key: string, written: number, created = written) => ({
  key,
  created_at: daysAgo(created),
  updated_at: daysAgo(written),
  size: 1,
});
const names = (entries: [string, number, number][]) =>
  new Map(entries.map(([k, live, deleted]) => [k, { live, deleted }]));
const row = (over: Record<string, unknown> = {}) => ({
  id: TXN,
  user_id: USER,
  receipt_path: `${USER}/${TXN}.another.jpg`,
  updated_at: pgDaysAgo(200),
  deleted_at: null,
  ...over,
});

describe('keyOwner: the keys the app makes, and nothing else', () => {
  it('reads the user and the transaction of both key shapes, lowercased', () => {
    expect(keyOwner(OLD_KEY)).toEqual({ userId: USER, transactionId: TXN });
    expect(keyOwner(KEY)).toEqual({ userId: USER, transactionId: TXN });
    expect(keyOwner(`${USER}/${TXN}.${UPLOAD}.bin`)).toEqual({
      userId: USER,
      transactionId: TXN,
    });
    expect(keyOwner(`${USER.toUpperCase()}/${TXN}.jpg`)).toEqual({
      userId: USER,
      transactionId: TXN,
    });
    expect(keyOwner(`${USER}/${TXN}.${UPLOAD}.abcdefgh`)).toEqual({
      userId: USER,
      transactionId: TXN,
    });
  });

  it.each([
    ['a folder inside the folder', `${USER}/x/${TXN}.jpg`],
    ['a file at the root', `${TXN}.jpg`],
    ['no extension', `${USER}/${TXN}`],
    ['an extension in capitals', `${USER}/${TXN}.JPG`],
    ['punctuation PostgREST would need quoted', `${USER}/${TXN}.a,b`],
    ['two upload ids', `${USER}/${TXN}.${UPLOAD}.${UPLOAD}.jpg`],
    ['a folder that is not a user id', `receipts/${TXN}.jpg`],
    ['a name that is not a transaction id', `${USER}/scan.jpg`],
    ['an extension longer than 8', `${USER}/${TXN}.${UPLOAD}.abcdefghi`],
    [
      'a name long enough to stall the last look',
      `${USER}/${TXN}.${UPLOAD}.${'a'.repeat(900)}`,
    ],
  ])('refuses %s', (_what, key) => {
    expect(keyOwner(key)).toBeNull();
  });
});

describe('firstLook: what the listing and the names say', () => {
  it('keeps a photo a live transaction names, however old', () => {
    expect(firstLook(photo(KEY, 900), names([[KEY, 1, 1]]), NOW)).toBe(
      STATES.NAMED
    );
  });

  it('keeps a photo only a deleted transaction names, until the purge reclaims the row', () => {
    expect(firstLook(photo(KEY, 900), names([[KEY, 0, 1]]), NOW)).toBe(
      STATES.NAMED_DELETED
    );
  });

  it('keeps a key the app does not make, however old and unnamed', () => {
    expect(firstLook(photo(`${USER}/scan.jpg`, 900), names([]), NOW)).toBe(
      STATES.UNKNOWN_KEY
    );
  });

  it('keeps a photo written within the grace: an upload whose attach has not reached the server yet', () => {
    expect(firstLook(photo(KEY, 29), names([]), NOW)).toBe(STATES.YOUNG);
  });

  it('asks for the transaction of a photo exactly as old as the grace', () => {
    const exactly = {
      ...photo(KEY, 0),
      updated_at: new Date(NOW - GRACE_MS).toISOString(),
      created_at: new Date(NOW - GRACE_MS).toISOString(),
    };
    expect(firstLook(exactly, names([]), NOW)).toBeNull();
  });

  it('counts an overwrite in place as a write: a key from before #23, re-uploaded 3 days ago over a photo made 200 days ago', () => {
    expect(firstLook(photo(OLD_KEY, 3, 200), names([]), NOW)).toBe(
      STATES.YOUNG
    );
  });

  it.each([
    ['no updated_at', { updated_at: null }],
    ['no created_at', { created_at: null }],
    ['an updated_at that does not parse', { updated_at: 'yesterday' }],
  ])('keeps a photo with %s', (_what, over) => {
    expect(firstLook({ ...photo(KEY, 900), ...over }, names([]), NOW)).toBe(
      STATES.YOUNG
    );
  });
});

describe('secondLook: what its own transaction says', () => {
  it('removes a photo whose transaction is gone (purged, or never uploaded)', () => {
    expect(secondLook(photo(KEY, 900), null, NOW)).toBe(STATES.ORPHAN);
  });

  it('removes a photo whose transaction names another and has not changed for the grace', () => {
    expect(secondLook(photo(KEY, 900), row(), NOW)).toBe(STATES.ORPHAN);
    expect(
      secondLook(photo(KEY, 900), row({ updated_at: pgDaysAgo(30) }), NOW)
    ).toBe(STATES.ORPHAN);
  });

  it("keeps a replaced photo while its transaction changed within the grace, however old the photo: another device's stale edit can still name it again (#23)", () => {
    expect(
      secondLook(photo(OLD_KEY, 200), row({ updated_at: pgDaysAgo(1) }), NOW)
    ).toBe(STATES.TRANSACTION_RECENT);
    expect(
      secondLook(photo(OLD_KEY, 200), row({ updated_at: pgDaysAgo(29) }), NOW)
    ).toBe(STATES.TRANSACTION_RECENT);
  });

  it('keeps a photo its transaction names again (named after the names were read)', () => {
    expect(secondLook(photo(KEY, 900), row({ receipt_path: KEY }), NOW)).toBe(
      STATES.RENAMED
    );
  });

  it("keeps a photo whose transaction belongs to another user than the key's folder", () => {
    expect(secondLook(photo(KEY, 900), row({ user_id: OTHER_USER }), NOW)).toBe(
      STATES.TRANSACTION_FOREIGN
    );
  });

  it('keeps a photo whose transaction stamp does not parse', () => {
    expect(secondLook(photo(KEY, 900), row({ updated_at: 'soon' }), NOW)).toBe(
      STATES.TRANSACTION_RECENT
    );
  });

  it("removes a deleted transaction's earlier photo once the delete is older than the grace", () => {
    expect(
      secondLook(
        photo(OLD_KEY, 900),
        row({ deleted_at: pgDaysAgo(45), updated_at: pgDaysAgo(45) }),
        NOW
      )
    ).toBe(STATES.ORPHAN);
  });
});

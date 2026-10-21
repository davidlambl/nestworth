// Which receipt photos the sweep removes (#176): the rule alone, with no I/O.
//
// A photo is removed only when nothing can still name it, as far as the
// server can tell:
//
//   - no transaction names it, live or deleted. A deleted transaction keeps
//     naming its photo until purge_tombstones() reclaims the row, 30 to 37
//     days after the delete (007, 008); a device's stale edit that lands on
//     it can still change which photo it names until then (delete wins: the
//     row stays deleted);
//   - its bytes are older than the grace: an upload whose attach has not
//     reached the server yet (offline right after the upload, a push the
//     server keeps refusing) is named by no row until it does;
//   - and its transaction has not changed for the grace either, or is gone.
//
// The last rule is the one that matters, and why a photo's own age is not
// enough. The push uploads the whole row and the server takes the newest
// arrival (CONTRIBUTING, Data Tables), so a device that edited a transaction
// before it pulled a replace still names the replaced photo, and its push
// names it again on the server (#23; syncReceiptReplace.test.ts). A replaced
// photo is usually old the moment it is replaced. Every key is
// `<user id>/<transaction id>.<…>` (lib/receiptObject.ts), and only that
// transaction ever names it: the receipt hooks build the key from the id of
// the transaction they attach it to. Every change to that transaction moves
// its `updated_at` (001's BEFORE UPDATE trigger stamps the server's clock), so
// the last moment the server named the photo is at most that row's
// `updated_at`. A device whose copy of the transaction still names the photo
// took that copy before then; it names it again only if it pushes more than
// the grace later: offline that long, or holding an edit the server refused
// that long (a pending row is never overwritten by a pull). A purged
// transaction cannot come back at all: 008 refuses its id for a year. One
// deleted any other way can: a build from before tombstones (#47) still
// hard-deletes, and its row then reads as absent here at once, with no
// grace, while a device's stale edit re-inserts it naming the photo. Nothing
// in the app deletes a transaction row since #47; anything that does must
// record the id in purged_ids (008).
//
// The grace is 30 days, the tombstone retention, so the horizon is the one
// the engine already promises: a device that syncs at least once a month
// loses nothing to the purge, and nothing to this sweep.
//
// Anything else is kept and counted: a key of another shape (nothing in the
// app makes one; 009 admits any name directly in the user's folder), a key
// whose transaction belongs to another user, a timestamp that does not
// parse. The rule never removes what it cannot read.

const RECEIPTS_BUCKET = 'receipts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a photo must have gone unnamed, and unwritten, to be removed. */
const GRACE_DAYS = 30;
const GRACE_MS = GRACE_DAYS * DAY_MS;

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * The two key shapes the app has made since #152 (no upload landed before
 * it): `<user>/<transaction>.<ext>` (before #23) and
 * `<user>/<transaction>.<upload id>.<ext>` (since), directly in the user's
 * folder, the extension one of lib/receiptObject.ts's (lowercase letters and
 * digits, at most 8 of them: the app's longest is 4). Any other name in a
 * user's folder, which 009 admits, is kept and never sent in a query. The
 * bound is what keeps the last look's request short: a key is at most 119
 * characters, so 50 of them fit a URL the edge accepts, while a name any
 * user can upload into their own folder could otherwise be a thousand
 * characters long and stall every run on a 414.
 */
const RECEIPT_KEY = new RegExp(
  `^(${UUID})/(${UUID})\\.(?:${UUID}\\.)?[a-z0-9]{1,8}$`
);

/** What the sweep decided about one object. */
const STATES = Object.freeze({
  /** A live transaction names it. */
  NAMED: 'named',
  /** Only a deleted transaction names it, until the purge reclaims the row. */
  NAMED_DELETED: 'named-deleted',
  /** Not a key the app makes: kept, never removed. */
  UNKNOWN_KEY: 'unknown-key',
  /** Written within the grace (or a timestamp that does not parse). */
  YOUNG: 'young',
  /** Its transaction names it again: it was named after the names were read. */
  RENAMED: 'renamed',
  /** Its transaction changed within the grace (or its stamp does not parse). */
  TRANSACTION_RECENT: 'transaction-recent',
  /** Its transaction belongs to another user than the key's folder. */
  TRANSACTION_FOREIGN: 'transaction-foreign',
  /** Named by nothing, old, its transaction unchanged as long: removed. */
  ORPHAN: 'orphan',
});

/** The user and the transaction a key belongs to, lowercased; null if neither. */
function keyOwner(key) {
  const match = RECEIPT_KEY.exec(String(key));
  return match
    ? { userId: match[1].toLowerCase(), transactionId: match[2].toLowerCase() }
    : null;
}

/** Milliseconds since `timestamp`; NaN when it is missing or does not parse. */
function ageMs(timestamp, now) {
  return timestamp == null ? NaN : now - Date.parse(timestamp);
}

/**
 * Milliseconds since the object's bytes were last written: the later of
 * `created_at` and `updated_at` (an overwrite in place, which builds before
 * #23 made, moves only `updated_at`). NaN unless both parse.
 */
function objectAgeMs(object, now) {
  return Math.min(ageMs(object.created_at, now), ageMs(object.updated_at, now));
}

/**
 * Whether `age` is at least the grace. False for NaN, so an unreadable time
 * always keeps the photo.
 */
function isPast(age, graceMs) {
  return age >= graceMs;
}

/**
 * The first look, from what the listing and the names read say:
 * `named` maps a key to how many live and deleted transactions name it.
 * Returns a state, or null for an object that needs its transaction read.
 */
function firstLook(object, named, now, graceMs = GRACE_MS) {
  const names = named.get(object.key);
  if (names && names.live > 0) return STATES.NAMED;
  if (names && names.deleted > 0) return STATES.NAMED_DELETED;
  if (!keyOwner(object.key)) return STATES.UNKNOWN_KEY;
  if (!isPast(objectAgeMs(object, now), graceMs)) return STATES.YOUNG;
  return null;
}

/**
 * The second look, for an object no transaction named: `row` is its own
 * transaction as read after the names (`id, user_id, receipt_path,
 * updated_at`), or null when the server holds no such row (purged, never
 * uploaded, or deleted outside the purge, which the header warns of).
 */
function secondLook(object, row, now, graceMs = GRACE_MS) {
  if (!row) return STATES.ORPHAN;
  if (row.receipt_path === object.key) return STATES.RENAMED;
  const owner = keyOwner(object.key);
  if (!owner || String(row.user_id).toLowerCase() !== owner.userId) {
    return STATES.TRANSACTION_FOREIGN;
  }
  if (!isPast(ageMs(row.updated_at, now), graceMs)) {
    return STATES.TRANSACTION_RECENT;
  }
  return STATES.ORPHAN;
}

module.exports = {
  DAY_MS,
  GRACE_DAYS,
  GRACE_MS,
  RECEIPTS_BUCKET,
  STATES,
  ageMs,
  firstLook,
  isPast,
  keyOwner,
  objectAgeMs,
  secondLook,
};

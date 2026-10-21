// One run of the receipt sweep (#176), against a supabase-js client signed
// with a secret (service role) key: scripts/sweep-receipts.js makes it, the
// tests hand in the fixture's fake (lib/testing/syncFixture.ts).
//
// The order is the safety argument:
//   1. the key must reach what only the service role can read (purged_ids:
//      RLS on, no policy, revoked from anon and authenticated by 008), or
//      nothing else runs: under any other key RLS answers the reads below
//      with nothing, and every photo would look named by nothing;
//   2. the bucket is listed first, every user's folder, page by page; an
//      object uploaded after its folder was listed is simply not looked at;
//   3. then the names: every transaction, live or deleted, that names a
//      receipt, read in pages of ids until a page comes back empty, so a
//      server cap on page size cannot end the read early;
//   4. then, for each photo no row named, its own transaction, read by id: a
//      row that names it again (pushed meanwhile) keeps it, and so does one
//      changed within the grace (rule.js says why);
//   5. right before each batch is removed, a last look for any row that
//      names one of its photos now;
//   6. only then, in an apply run, the removal: at most MAX_REMOVALS per run,
//      oldest first, a batch at a time; the rest wait for the next run.
// A read that fails stops the run before anything is removed. A removal that
// fails stops it where it is; what was removed before it stays removed and is
// in the log, and the next run carries on. Nothing is kept between runs:
// every run decides from what the server holds at that moment.

const {
  DAY_MS,
  GRACE_MS,
  RECEIPTS_BUCKET,
  STATES,
  firstLook,
  keyOwner,
  objectAgeMs,
  secondLook,
} = require('./rule');

/** Entries per listing page; storage.search caps a page at 1500. */
const LIST_PAGE = 1000;
/** Rows per page of the names read: PostgREST's max_rows on hosted Supabase. */
const READ_PAGE = 1000;
/** Ids per `in` filter: about 4 KB of URL. */
const ID_CHUNK = 100;
/**
 * Keys per `in` filter of the last look: about 6 KB of URL (6,106 characters
 * for 50 `.heic` keys, built by the installed postgrest-js; 100 ids: 4,032).
 */
const KEY_CHUNK = 50;
/** Photos per removal request; storage-api takes at most 1000. */
const REMOVE_BATCH = 100;
/** Photos removed per run at most; the rest wait for the next run. */
const MAX_REMOVALS = 500;

const MODES = ['dry-run', 'apply'];

/** A request failed: the run stops, and says what it had done by then. */
class SweepStopped extends Error {}

function describe(error) {
  if (!error) return 'no error';
  const message = error.message ?? String(error);
  const code = error.code || error.statusCode || error.status;
  return code ? `${message} (${code})` : message;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Step 1: only a service-role key can read purged_ids (008). Only a refusal
 * says the key is wrong: Postgres's 42501, or an HTTP 401 or 403, which the
 * gateway answers for a key it does not know. A read that got no answer (a
 * fetch that failed, which postgrest-js reports with the status 0) or that
 * failed otherwise says nothing about the key, and the stop says which it
 * was.
 */
async function checkAccess(client) {
  const answer = await client.from('purged_ids').select('id').limit(1);
  if (!answer.error) return;
  const { error, status } = answer;
  if (error.code === '42501' || status === 401 || status === 403) {
    throw new SweepStopped(
      `the key cannot read purged_ids, which only a secret (service role) key can: ${describe(error)}`
    );
  }
  throw new SweepStopped(
    status
      ? `reading purged_ids failed with HTTP ${status} (not a refusal), so the key was not checked: ${describe(error)}`
      : `reading purged_ids got no answer (a network error), so the key was not checked: ${describe(error)}`
  );
}

/** Every entry of one level of the bucket, page by page until an empty one. */
async function listLevel(bucket, prefix) {
  const seen = new Map();
  let offset = 0;
  for (;;) {
    const { data, error } = await bucket.list(prefix, {
      limit: LIST_PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) {
      throw new SweepStopped(`listing the bucket failed: ${describe(error)}`);
    }
    const page = data ?? [];
    const before = seen.size;
    for (const entry of page) seen.set(entry.name, entry);
    // An empty page is the end; so is a page with nothing new, which a
    // server that ignored the offset would answer forever. Either way, an
    // object not listed is an object left alone.
    if (page.length === 0 || seen.size === before) return [...seen.values()];
    offset += page.length;
  }
}

/** Step 2: every object in the bucket, with its key and timestamps. */
async function listBucket(client, report) {
  const bucket = client.storage.from(RECEIPTS_BUCKET);
  const objects = [];
  const asObject = (key, entry) => ({
    key,
    created_at: entry.created_at ?? null,
    updated_at: entry.updated_at ?? null,
    size: entry.metadata?.size ?? null,
  });
  for (const entry of await listLevel(bucket, '')) {
    if (entry.id != null) {
      // A file at the bucket's root: no key the app makes.
      objects.push(asObject(entry.name, entry));
      continue;
    }
    report.folders += 1;
    for (const file of await listLevel(bucket, entry.name)) {
      if (file.id == null) {
        // A folder inside a user's folder: no key the app makes either, and
        // never looked into.
        report.nestedFolders += 1;
        continue;
      }
      objects.push(asObject(`${entry.name}/${file.name}`, file));
    }
  }
  report.listed = objects.length;
  return objects;
}

/** Step 3: how many live and deleted transactions name each key. */
async function readNames(client) {
  const named = new Map();
  let after = null;
  for (;;) {
    let query = client
      .from('transactions')
      .select('id, receipt_path, deleted_at')
      .not('receipt_path', 'is', null);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query.order('id').range(0, READ_PAGE - 1);
    if (error) {
      throw new SweepStopped(
        `reading the transactions that name a receipt failed: ${describe(error)}`
      );
    }
    if (!data || data.length === 0) return named;
    for (const row of data) {
      const names = named.get(row.receipt_path) ?? { live: 0, deleted: 0 };
      if (row.deleted_at == null) names.live += 1;
      else names.deleted += 1;
      named.set(row.receipt_path, names);
    }
    after = data[data.length - 1].id;
  }
}

/**
 * Rows of `table` whose `column` is one of `values` (and, with `where`, whose
 * `where[0]` is `where[1]`), a chunk at a time, each chunk read whole: the
 * answer must hold every row the server counted, or the run stops, since a
 * row missing from it would read as no row at all.
 */
async function readIn(
  client,
  { table, columns, column, values, size, what, where }
) {
  const rows = [];
  for (const chunk of chunks([...new Set(values)], size)) {
    let query = client.from(table).select(columns, { count: 'exact' });
    if (where) query = query.eq(where[0], where[1]);
    const { data, error, count } = await query.in(column, chunk);
    if (error) {
      throw new SweepStopped(`reading ${what} failed: ${describe(error)}`);
    }
    if (count == null || count !== (data ?? []).length) {
      throw new SweepStopped(
        `reading ${what} came back short (${(data ?? []).length} of ${count} rows)`
      );
    }
    rows.push(...data);
  }
  return rows;
}

async function sweepReceipts(client, options) {
  const {
    mode,
    now = Date.now(),
    graceMs = GRACE_MS,
    maxRemovals = MAX_REMOVALS,
    onRecords = () => {},
  } = options;
  if (!MODES.includes(mode)) {
    throw new Error(`The sweep's mode is dry-run or apply, not ${mode}.`);
  }
  const report = {
    mode,
    startedAt: new Date(now).toISOString(),
    graceDays: graceMs / DAY_MS,
    folders: 0,
    nestedFolders: 0,
    // null until the whole bucket is listed: a run stopped before then has
    // no count to give (report.js prints none).
    listed: null,
    states: {},
    anomalies: [],
    records: [],
    deferred: 0,
    stopped: null,
  };
  const tally = (state) => {
    report.states[state] = (report.states[state] ?? 0) + 1;
  };
  const record = (records) => {
    report.records.push(...records);
    onRecords(records);
  };
  try {
    await checkAccess(client);
    const objects = await listBucket(client, report);
    const named = await readNames(client);

    const candidates = [];
    for (const object of objects) {
      const state = firstLook(object, named, now, graceMs);
      if (state === null) candidates.push(object);
      else tally(state);
      if (state === STATES.UNKNOWN_KEY) {
        report.anomalies.push({ key: object.key, state });
      }
    }

    const transactionOf = (object) => keyOwner(object.key).transactionId;
    const rows = new Map(
      (
        await readIn(client, {
          table: 'transactions',
          columns: 'id, user_id, receipt_path, updated_at, deleted_at',
          column: 'id',
          values: candidates.map(transactionOf),
          size: ID_CHUNK,
          what: 'the transactions of unnamed receipts',
        })
      ).map((row) => [String(row.id).toLowerCase(), row])
    );
    const missing = candidates.map(transactionOf).filter((id) => !rows.has(id));
    const purged = new Set(
      (
        await readIn(client, {
          table: 'purged_ids',
          columns: 'id',
          column: 'id',
          values: missing,
          size: ID_CHUNK,
          what: 'purged transaction ids',
          where: ['table_name', 'transactions'],
        })
      ).map((row) => String(row.id).toLowerCase())
    );

    const orphans = [];
    for (const object of candidates) {
      const row = rows.get(transactionOf(object)) ?? null;
      const state = secondLook(object, row, now, graceMs);
      tally(state);
      if (state === STATES.TRANSACTION_FOREIGN) {
        report.anomalies.push({ key: object.key, state });
      }
      if (state === STATES.ORPHAN) {
        orphans.push({
          key: object.key,
          ageDays: Math.floor(objectAgeMs(object, now) / DAY_MS),
          size: object.size,
          transaction: row
            ? row.deleted_at == null
              ? 'live'
              : 'deleted'
            : purged.has(transactionOf(object))
              ? 'purged'
              : 'missing',
        });
      }
    }

    // Oldest first: the photos that have waited longest go first.
    orphans.sort((a, b) => b.ageDays - a.ageDays || (a.key < b.key ? -1 : 1));
    const chosen = orphans.slice(0, Math.max(0, maxRemovals));
    report.deferred = orphans.length - chosen.length;

    for (const batch of chunks(chosen, REMOVE_BATCH)) {
      // Step 5: the last look, in a dry run too, so a dry run sends every
      // request an apply run sends except the removal itself.
      const named = new Set(
        (
          await readIn(client, {
            table: 'transactions',
            columns: 'id, receipt_path',
            column: 'receipt_path',
            values: batch.map((orphan) => orphan.key),
            size: KEY_CHUNK,
            what: 'the transactions that name the receipts about to be removed',
          })
        ).map((row) => row.receipt_path)
      );
      const renamed = batch.filter((orphan) => named.has(orphan.key));
      const doomed = batch.filter((orphan) => !named.has(orphan.key));
      record(renamed.map((orphan) => ({ ...orphan, result: 'renamed' })));
      if (doomed.length === 0) continue;
      if (mode !== 'apply') {
        record(doomed.map((orphan) => ({ ...orphan, result: 'would-remove' })));
        continue;
      }
      const { data, error } = await client.storage
        .from(RECEIPTS_BUCKET)
        .remove(doomed.map((orphan) => orphan.key));
      if (error) {
        throw new SweepStopped(
          `removing ${doomed.length} photo(s) failed: ${describe(error)}`
        );
      }
      // Storage answers the objects it deleted; one it did not find was
      // already gone (removed in the app, or by an earlier run), which is
      // what this run wanted anyway.
      const gone = new Set((data ?? []).map((entry) => entry.name));
      record(
        doomed.map((orphan) => ({
          ...orphan,
          result: gone.has(orphan.key) ? 'removed' : 'already-gone',
        }))
      );
    }
  } catch (e) {
    if (!(e instanceof SweepStopped)) throw e;
    report.stopped = e.message;
  }
  return report;
}

module.exports = {
  ID_CHUNK,
  KEY_CHUNK,
  LIST_PAGE,
  MAX_REMOVALS,
  MODES,
  READ_PAGE,
  REMOVE_BATCH,
  sweepReceipts,
};

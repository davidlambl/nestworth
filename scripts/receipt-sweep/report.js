// What a sweep run prints (#176). The repository is public and so are its
// Actions logs, while a receipt's key carries its user's id and its
// transaction's id. So nothing the sweep prints names a key, a user or a
// transaction: each photo is a digest (the first 12 hex digits of the
// SHA-256 of its key), with its state, its age and its size, and the totals.
// The digest cannot be turned back into a key (a key holds two or three
// random UUIDs), but the owner can find the photo from it in the SQL editor:
//
//   select name from storage.objects
//    where bucket_id = 'receipts'
//      and left(encode(sha256(convert_to(name, 'UTF8')), 'hex'), 12) = '<digest>';
//
// and, once it is removed, its transaction from the transaction's own
// digest the same way (`id::text` in place of `name`, from transactions).
// As a last guard, every line goes through redactIds, which replaces
// anything shaped like a UUID: an error message quoting an id prints the
// error without the id. And a message the server wrote (an error page can
// span lines) is printed on one line through escapeData: a line of the
// log that starts with `::` is a command to the runner.

const crypto = require('crypto');

const UUID_ANYWHERE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** The first 12 hex digits of the SHA-256 of `text`, as SQL computes them. */
function digest(text) {
  return crypto
    .createHash('sha256')
    .update(String(text), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

/** `text` with every UUID-shaped run replaced by `<id>`. */
function redactIds(text) {
  return String(text).replace(UUID_ANYWHERE, '<id>');
}

/**
 * `text` on one line, its `%`, CR and LF escaped as a workflow command's
 * message must be: the runner reads any line of the log that starts with
 * `::` as a command.
 */
function escapeData(text) {
  return String(text)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

const RESULT_WORDS = {
  'would-remove': 'would remove',
  removed: 'removed',
  'already-gone': 'already gone',
  renamed: 'kept (named again)',
};

/** One line per photo the run removed, would remove, or found named again. */
function recordLine(record) {
  const size = record.size == null ? 'size unknown' : `${record.size} bytes`;
  return redactIds(
    `${RESULT_WORDS[record.result] ?? record.result}: photo ${digest(record.key)}` +
      ` (transaction ${digest(keyTransaction(record.key))}, ${record.transaction})` +
      `, written ${record.ageDays} days ago, ${size}`
  );
}

/** The transaction id in a key, as the rule parses it, or the key itself. */
function keyTransaction(key) {
  const name = String(key).split('/').pop() ?? '';
  return name.split('.')[0].toLowerCase();
}

/** One line per object kept because its key or its transaction is odd. */
function anomalyLine(anomaly) {
  return redactIds(`kept, ${anomaly.state}: photo ${digest(anomaly.key)}`);
}

function totals(report) {
  const count = (result) =>
    report.records.filter((record) => record.result === result).length;
  const bytes = report.records
    .filter((record) => record.result === 'removed')
    .reduce((sum, record) => sum + (record.size ?? 0), 0);
  return {
    removed: count('removed'),
    wouldRemove: count('would-remove'),
    alreadyGone: count('already-gone'),
    renamed: count('renamed'),
    bytes,
  };
}

/** The run's closing lines for the log. */
function summaryLines(report) {
  const t = totals(report);
  const states = Object.entries(report.states)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([state, n]) => `${state} ${n}`)
    .join(', ');
  const lines = [
    `Receipt sweep, ${report.mode}, ${report.startedAt}, grace ${report.graceDays} days.`,
  ];
  if (report.listed == null) {
    // Stopped before the bucket was listed: there is no count to give.
    lines.push(
      `Stopped before listing the bucket, so nothing was removed: ${escapeData(report.stopped)}`
    );
    return lines.map(redactIds);
  }
  lines.push(
    `Listed ${report.listed} photo(s) in ${report.folders} folder(s)` +
      (report.nestedFolders
        ? `, and ${report.nestedFolders} folder(s) inside a folder, not looked into`
        : '') +
      `: ${states || (report.stopped && report.listed > 0 ? 'none decided before the stop' : 'nothing to decide')}.`,
    report.mode === 'apply'
      ? `Removed ${t.removed} photo(s) (${t.bytes} bytes); ${t.alreadyGone} already gone; ${t.renamed} named again at the last look; ${report.deferred} left for the next run.`
      : `Would remove ${t.wouldRemove} photo(s); ${t.renamed} named again at the last look; ${report.deferred} over this run's limit. Nothing was removed (dry run).`
  );
  if (report.stopped) lines.push(`Stopped: ${escapeData(report.stopped)}`);
  return lines.map(redactIds);
}

/** The job summary, Markdown: the same totals, no digests. */
function summaryMarkdown(report) {
  const t = totals(report);
  const rows = [
    ['Mode', report.mode],
    ['Started', report.startedAt],
    ['Grace', `${report.graceDays} days`],
    // A run stopped before the bucket was listed has no counts to give.
    ...(report.listed == null
      ? []
      : [
          ['Photos listed', report.listed],
          ['User folders', report.folders],
          ...Object.entries(report.states)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([state, n]) => [`State: ${state}`, n]),
          report.mode === 'apply'
            ? ['Removed', `${t.removed} (${t.bytes} bytes)`]
            : ['Would remove', t.wouldRemove],
          ['Already gone', t.alreadyGone],
          ['Named again at the last look', t.renamed],
          ['Left for the next run', report.deferred],
        ]),
  ];
  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  // The stop message on one line, as in the log: an error page spans lines.
  const stopped = report.stopped
    ? report.listed == null
      ? `\n\n**Stopped before listing the bucket, so nothing was removed:** ${escapeData(report.stopped)}\n`
      : `\n\n**Stopped:** ${escapeData(report.stopped)}\n`
    : '\n';
  return redactIds(
    `### Receipt sweep (${report.mode})\n\n| | |\n| --- | --- |\n${table}${stopped}`
  );
}

module.exports = {
  anomalyLine,
  digest,
  escapeData,
  recordLine,
  redactIds,
  summaryLines,
  summaryMarkdown,
};

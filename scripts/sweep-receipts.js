#!/usr/bin/env node
// The receipt sweep (#176): removes the receipt photos no transaction has
// named for 30 days, through the Storage API, as the service role. Run by
// .github/workflows/sweep-receipts.yml (weekly, and by hand); the rule is in
// scripts/receipt-sweep/rule.js, the run in sweep.js, what it prints in
// report.js, what it runs with in config.js. Locally it runs as a dry run
// only:
//
//   SUPABASE_URL=https://<project>.supabase.co \
//   RECEIPT_SWEEP_SECRET_KEY=<a secret key> RECEIPT_SWEEP_MODE=dry-run \
//   node scripts/sweep-receipts.js
//
// Exit status 0 when the run finished, 1 when it was refused or stopped.

const fs = require('fs');
const { readConfig } = require('./receipt-sweep/config');
const { sweepReceipts } = require('./receipt-sweep/sweep');
const {
  anomalyLine,
  escapeData,
  recordLine,
  redactIds,
  summaryLines,
  summaryMarkdown,
} = require('./receipt-sweep/report');

async function main({
  env = process.env,
  createClient = require('@supabase/supabase-js').createClient,
  write = (line) => console.log(line),
  now = Date.now(),
} = {}) {
  const say = (line) => write(redactIds(line));
  let config;
  try {
    config = readConfig(env);
  } catch (e) {
    say(`::error title=Receipt sweep refused::${escapeData(e.message)}`);
    return 1;
  }
  // No session, ever: the client signs every request with the key itself
  // (supabase-js obeys a signed-in user's RLS even with a secret key).
  // One attempt per request, as the app's client (#51): supabase-js 2.102 and
  // later retry a failed read three more times unless told not to, and a run
  // that gets no answer stops and says so (sweep.js).
  const client = createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { retry: false },
  });
  const report = await sweepReceipts(client, {
    mode: config.mode,
    now,
    onRecords: (records) =>
      records.forEach((record) => say(recordLine(record))),
  });
  report.anomalies.forEach((anomaly) => say(anomalyLine(anomaly)));
  summaryLines(report).forEach(say);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
  }
  if (report.stopped) {
    say(`::error title=Receipt sweep stopped::${escapeData(report.stopped)}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(
        redactIds(
          `::error title=Receipt sweep failed::${escapeData(e?.message ?? e)}`
        )
      );
      process.exitCode = 1;
    }
  );
}

module.exports = { main };

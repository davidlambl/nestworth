// Rows the push can never upload as they are (#115).
//
// The push leaves a row 'pending' whenever its upload fails, and retries it on
// every push: right for a failure that passes (no network, a timeout, a sign-in
// being renewed), and forever for one that never will. Two kinds of the second
// are named by the issue, and a third kind is what the server says about a
// row's own contents:
//
//  - 'account': the server refuses a NEW transaction or rule whose account is
//    gone there, with a hint-less 23503 -- 005's inherit_account_tombstone
//    while the account is tombstoned ("account <id> is deleted"), the plain
//    foreign key once it has been purged. The row was written on this device
//    (offline, or before the account's tombstone reached it) under an account
//    another device deleted. The server has never held it, and never will
//    under that account. Since #163 this device no longer writes one into an
//    account it knows is gone; it still can into one whose tombstone it has
//    not pulled yet, and rows written before #163 are still there.
//  - 'unprepared': this device cannot build the row's upload at all (a
//    recurring rule whose stored template is not JSON, #129).
//  - 'rejected': any other refusal of the row's own data: SQLSTATE class 22
//    (a data exception -- a date the server cannot read, as the CSV import
//    wrote day-first dates before #36, 22008; an amount past numeric(12,2),
//    22003; a value of the wrong type, 22P02) or class 23 (a constraint:
//    23502 not-null, 23514 check). The same row is refused the same way on
//    every push, so it is as stuck as the other two.
//
// Everything else is transient and is never remembered as refused: a request
// that never reached the server (postgrest-js gives it code ''), a timeout,
// the app's own refusal to send an anon-signed request (#109, code ''), 42501
// (RLS: a session that is not this user's), the missing-column report (42703,
// PGRST204/202), PostgREST's own errors (PGRST...), 5xx, 40001, 57014. And
// 23503 with `hint: 'purged'` is not a refusal at all: the push drops that row
// as deleted elsewhere (isPurgedRowError in lib/sync.ts, #98).
//
// The push remembers what it was refused in ONE sync_meta key per user
// (`push_refusals:<user id>`, JSON), written under the sync lock at the end of
// a push whenever it changed, and read by the status store (lib/syncStatus.ts) for
// Settings, and by the reset's refusal. An entry holds only while its row is
// still 'pending' with the `updated_at` the push read: a row the user moved,
// edited or discarded since is no longer listed, at once, and the next push
// rewrites the key from what it was told. Nothing here imports './sync' or
// './db': both lib/sync.ts and lib/syncStatus.ts import this module.

/**
 * The tables whose rows are remembered. Accounts are not: every field the
 * server checks on an account is written from validated input, and a child
 * whose account the server does not have yet waits behind that account
 * (pushRefusals in lib/sync.ts) rather than being listed.
 */
export type RefusedTable = 'transactions' | 'recurring_rules';

/** Why a row cannot be uploaded: see the file's header. */
export type RefusalKind = 'account' | 'rejected' | 'unprepared';

/** One remembered refusal, as the key stores it. */
export interface RefusalEntry {
  table: RefusedTable;
  id: string;
  /** The row's `updated_at` when the push read it: the entry holds while it is unchanged. */
  updatedAt: string | null;
  /** The row's account when the push read it. */
  accountId: string | null;
  kind: RefusalKind;
  /** The server's SQLSTATE; '' for 'unprepared'. */
  code: string;
  /** The account's name, while this device still had the account row. */
  accountName: string | null;
  /** When a push first met this refusal of this version of the row (ISO). */
  since: string;
}

/** The sync_meta key holding a user's refusals: per user, like the four pull keys. */
export function refusalsKey(userId: string): string {
  return `push_refusals:${userId}`;
}

const TABLES: readonly string[] = ['transactions', 'recurring_rules'];
const KINDS: readonly string[] = ['account', 'rejected', 'unprepared'];

/**
 * The key's entries, or none. Tolerant: a value that is missing, not JSON or
 * not an array of well-formed entries reads as no refusals (or skips the bad
 * entries), never as an error -- the next push rewrites it.
 */
export function parseRefusals(raw: string | null | undefined): RefusalEntry[] {
  if (typeof raw !== 'string' || raw === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const out: RefusalEntry[] = [];
  for (const e of parsed) {
    if (
      e == null ||
      typeof e !== 'object' ||
      !TABLES.includes((e as any).table) ||
      typeof (e as any).id !== 'string' ||
      !KINDS.includes((e as any).kind)
    ) {
      continue;
    }
    const x = e as any;
    out.push({
      table: x.table,
      id: x.id,
      updatedAt: str(x.updatedAt),
      accountId: str(x.accountId),
      kind: x.kind,
      code: str(x.code) ?? '',
      accountName: str(x.accountName),
      since: str(x.since) ?? '',
    });
  }
  return out;
}

/**
 * Is this refusal of a pending row's upsert permanent, and of which kind?
 * `null` is transient: the row is retried by the next push, as it always was,
 * and is not listed.
 *
 * The SQLSTATE class decides: 22 (data exception) and 23 (integrity
 * constraint) are answers about the row itself, which the same row gets again
 * on every push. 23503 is the 'account' kind, unless it carries 008's
 * `hint: 'purged'` (an answer the push acts on: the row was deleted
 * elsewhere). Every other error -- no code at all (a fetch that failed, a
 * timeout, the client's refusal of an anon-signed request), 42501, 42703,
 * PGRST..., 40001, 57014, 08..., 53... -- is the network, the session or the
 * server, and passes.
 *
 * The caller still decides one case this cannot: a 23503 for a row whose
 * account is itself waiting to upload here is the foreign key meeting an
 * account the server does not have YET, not a gone one (lib/sync.ts).
 */
export function refusalKind(error: any): 'account' | 'rejected' | null {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (!/^2[23][0-9A-Z]{3}$/.test(code)) {
    return null;
  }
  if (code === '23503') {
    return error?.hint === 'purged' ? null : 'account';
  }
  return 'rejected';
}

/**
 * What one push learns, merged into what the key held before it.
 *
 * The next key holds:
 *  - every row this push was refused, keeping the earlier `since` (and the
 *    account's name, when this push no longer had it) for the same version
 *    of the row under the same account;
 *  - every earlier entry whose row this push tried again and got a TRANSIENT
 *    answer for, the same version: an offline push learns nothing, and must
 *    not make Settings forget what an online one was told.
 * Nothing else: a row this push uploaded, or did not try (it is no longer
 * pending -- discarded, uploaded -- or a newer version was tried) drops out.
 * So a stale entry lasts at most until the next push that reaches the rows.
 */
export function createRefusalLog(prev: RefusalEntry[], now: string) {
  const keyOf = (table: string, id: string) => `${table}:${id}`;
  const before = new Map(prev.map((e) => [keyOf(e.table, e.id), e]));
  const refused = new Map<string, RefusalEntry>();
  const retried = new Map<string, string | null>();
  return {
    /** The push was refused this row, permanently. */
    refuse(e: Omit<RefusalEntry, 'since'>): void {
      const k = keyOf(e.table, e.id);
      const p = before.get(k);
      const sameAccount = p != null && p.accountId === e.accountId;
      const sameVersion =
        sameAccount && p!.updatedAt === e.updatedAt && p!.kind === e.kind;
      refused.set(k, {
        ...e,
        accountName: e.accountName ?? (sameAccount ? p!.accountName : null),
        since: sameVersion && p!.since ? p!.since : now,
      });
      retried.delete(k);
    },
    /** The push tried this row and the answer was transient. */
    retry(table: RefusedTable, id: string, updatedAt: string | null): void {
      const k = keyOf(table, id);
      if (!refused.has(k)) {
        retried.set(k, updatedAt);
      }
    },
    /** The key's next value. */
    next(): RefusalEntry[] {
      const out = [...refused.values()];
      for (const p of prev) {
        const k = keyOf(p.table, p.id);
        if (
          !refused.has(k) &&
          retried.has(k) &&
          retried.get(k) === p.updatedAt
        ) {
          out.push(p);
        }
      }
      return out;
    },
  };
}

export type RefusalLog = ReturnType<typeof createRefusalLog>;

// --- What Settings shows ------------------------------------------------------

interface RefusedBase {
  id: string;
  kind: RefusalKind;
  code: string;
  since: string;
  updatedAt: string | null;
  accountId: string | null;
  /** The account's name: this device's row when it still has one, else the name the push recorded. */
  accountName: string | null;
  /** Whether this device holds the account and has not marked it deleted. */
  accountLive: boolean;
}

export interface RefusedTransaction extends RefusedBase {
  table: 'transactions';
  txnDate: string | null;
  payee: string | null;
  amount: number | null;
  transferLinkId: string | null;
  /** The account of the other side of a transfer, while that side is live here. */
  partnerAccountId: string | null;
  partnerAccountName: string | null;
  /** The transaction's split lines that wait with it. */
  unsyncedSplits: number;
}

export interface RefusedRule extends RefusedBase {
  table: 'recurring_rules';
  frequency: string | null;
  nextDate: string | null;
  /** From the stored template when it reads as JSON; null when it does not. */
  payee: string | null;
  amount: number | null;
}

export type RefusedRow = RefusedTransaction | RefusedRule;

export interface RefusedSummary {
  rows: RefusedRow[];
  transactions: number;
  rules: number;
  /** Unsynced split lines under the refused transactions: they cannot go up either. */
  splits: number;
}

export const NO_REFUSALS: RefusedSummary = {
  rows: [],
  transactions: 0,
  rules: 0,
  splits: 0,
};

/** The slice of the expo-sqlite API the read needs. */
export interface RefusalReadDb {
  getAllAsync: (sql: string, params: any[]) => Promise<unknown[]>;
}

/** SQLite's bound-parameter ceiling is 32766; 500 keeps each statement small. */
const READ_CHUNK = 500;

/**
 * The refused rows still standing, for `userId`: the entries of `raw` (the
 * key's value) whose row is this user's, still 'pending', and unchanged since
 * the push read it (`updated_at`, NULL-safe). Every read is `user_id = ?`:
 * another account signed in on this device never sees these rows (#177's
 * class), and its own key is separate. No entries, no statement.
 */
export async function readRefusedRows(
  db: RefusalReadDb,
  userId: string,
  raw: string | null | undefined
): Promise<RefusedSummary> {
  const entries = parseRefusals(raw);
  if (entries.length === 0) {
    return NO_REFUSALS;
  }
  const accounts = new Map(
    (
      (await db.getAllAsync(
        'SELECT id, name, _sync_status FROM accounts WHERE user_id = ?',
        [userId]
      )) as { id: string; name: string; _sync_status: string | null }[]
    ).map((a) => [a.id, a])
  );
  const accountName = (id: string | null, recorded: string | null) =>
    (id != null ? accounts.get(id)?.name : undefined) ?? recorded;
  const accountLive = (id: string | null) =>
    id != null &&
    accounts.has(id) &&
    accounts.get(id)!._sync_status !== 'deleted';

  const byTable = (table: RefusedTable) =>
    new Map(
      entries.filter((e) => e.table === table).map((e) => [e.id, e] as const)
    );
  const read = async (sql: string, ids: string[]) => {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const chunk = ids.slice(i, i + READ_CHUNK);
      out.push(
        ...((await db.getAllAsync(
          sql.replace('(?)', `(${chunk.map(() => '?').join(', ')})`),
          [userId, ...chunk]
        )) as any[])
      );
    }
    return out;
  };

  const rows: RefusedRow[] = [];
  let splits = 0;
  const txns = byTable('transactions');
  if (txns.size > 0) {
    const found = await read(
      `SELECT t.id, t.updated_at, t.account_id, t.txn_date, t.payee, t.amount,
              t.transfer_link_id,
              (SELECT o.account_id FROM transactions o
                WHERE o.transfer_link_id = t.transfer_link_id AND o.id != t.id
                  AND o.user_id = t.user_id AND o._sync_status IS NOT 'deleted'
                LIMIT 1) AS partner_account_id,
              (SELECT COUNT(*) FROM transaction_splits s
                WHERE s.transaction_id = t.id
                  AND s._sync_status IN ('pending','deleted')) AS unsynced_splits
         FROM transactions t
        WHERE t.user_id = ? AND t._sync_status = 'pending' AND t.id IN (?)`,
      [...txns.keys()]
    );
    for (const r of found) {
      const e = txns.get(r.id)!;
      if ((r.updated_at ?? null) !== e.updatedAt) continue;
      splits += Number(r.unsynced_splits ?? 0);
      rows.push({
        table: 'transactions',
        id: r.id,
        kind: e.kind,
        code: e.code,
        since: e.since,
        updatedAt: e.updatedAt,
        accountId: r.account_id ?? null,
        accountName: accountName(
          r.account_id ?? null,
          r.account_id === e.accountId ? e.accountName : null
        ),
        accountLive: accountLive(r.account_id ?? null),
        txnDate: r.txn_date ?? null,
        payee: r.payee ?? null,
        amount: typeof r.amount === 'number' ? r.amount : null,
        transferLinkId: r.transfer_link_id ?? null,
        partnerAccountId: r.partner_account_id ?? null,
        partnerAccountName: accountName(r.partner_account_id ?? null, null),
        unsyncedSplits: Number(r.unsynced_splits ?? 0),
      });
    }
  }
  const rules = byTable('recurring_rules');
  if (rules.size > 0) {
    const found = await read(
      `SELECT r.id, r.updated_at, r.account_id, r.frequency, r.next_date, r.template
         FROM recurring_rules r
        WHERE r.user_id = ? AND r._sync_status = 'pending' AND r.id IN (?)`,
      [...rules.keys()]
    );
    for (const r of found) {
      const e = rules.get(r.id)!;
      if ((r.updated_at ?? null) !== e.updatedAt) continue;
      const template = readTemplate(r.template);
      rows.push({
        table: 'recurring_rules',
        id: r.id,
        kind: e.kind,
        code: e.code,
        since: e.since,
        updatedAt: e.updatedAt,
        accountId: r.account_id ?? null,
        accountName: accountName(
          r.account_id ?? null,
          r.account_id === e.accountId ? e.accountName : null
        ),
        accountLive: accountLive(r.account_id ?? null),
        frequency: r.frequency ?? null,
        nextDate: r.next_date ?? null,
        payee: template.payee,
        amount: template.amount,
      });
    }
  }
  rows.sort(
    (a, b) =>
      (a.table === b.table ? 0 : a.table === 'transactions' ? -1 : 1) ||
      sortDate(b).localeCompare(sortDate(a)) ||
      a.id.localeCompare(b.id)
  );
  const transactions = rows.filter((r) => r.table === 'transactions').length;
  return {
    rows,
    transactions,
    rules: rows.length - transactions,
    splits,
  };
}

function sortDate(r: RefusedRow): string {
  return (r.table === 'transactions' ? r.txnDate : r.nextDate) ?? '';
}

/** A rule's payee and amount from its stored template, which may not be JSON (#129). */
function readTemplate(raw: unknown): {
  payee: string | null;
  amount: number | null;
} {
  let t: any = raw;
  if (typeof raw === 'string') {
    try {
      t = JSON.parse(raw);
    } catch {
      return { payee: null, amount: null };
    }
  }
  return {
    payee: typeof t?.payee === 'string' ? t.payee : null,
    amount: typeof t?.amount === 'number' ? t.amount : null,
  };
}

const nounOf = (row: RefusedRow) =>
  row.table === 'transactions' ? 'transaction' : 'rule';

/**
 * Why a refused row cannot be uploaded, in the house's words: what happened,
 * then what it means for the row. A row refused for its own data whose
 * account is gone here as well (another device's delete, pulled here) says
 * both: the server casts the row's values before 005's trigger or the foreign
 * key looks at its account, so it named the value, and the account's refusal
 * would come next.
 */
export function describeRefusal(row: RefusedRow): string {
  const noun = nounOf(row);
  if (row.kind === 'account') {
    return row.accountName
      ? `Its account, ${row.accountName}, was deleted, so this ${noun} can't be uploaded.`
      : `Its account was deleted, so this ${noun} can't be uploaded.`;
  }
  // `whose` names the account's owner: "its", or "this transaction's" after
  // a clause whose "it" would read as the amount.
  const gone = (whose: string) =>
    row.accountLive
      ? ''
      : row.accountName
        ? `, and ${whose} account, ${row.accountName}, was deleted`
        : `, and ${whose} account was deleted`;
  if (row.kind === 'unprepared') {
    return `This ${noun}'s saved details can't be read${gone('its')}, so it can't be uploaded.`;
  }
  if (row.code === '22008' || row.code === '22007') {
    return `The cloud can't store this ${noun}'s date${gone('its')}, so it can't be uploaded.`;
  }
  if (row.code === '22003') {
    return row.accountLive
      ? `The cloud can't store an amount this large, so this ${noun} can't be uploaded.`
      : `The cloud can't store an amount this large${gone(`this ${noun}'s`)}, so it can't be uploaded.`;
  }
  return `The cloud refuses this ${noun} as it is (error ${row.code})${gone('its')}, so it can't be uploaded.`;
}

// --- What the list offers, and the Settings line (#115) -----------------------

/**
 * The field the edit screen must fix before a transaction refused for its own
 * data can upload: its date (22007, a date emptied on web; 22008, a day-first
 * date from the old import) or its amount (22003, past the server's
 * numeric(12,2)). Null for any other refusal, which names a field the form
 * does not write (an edit would only be refused again), and for a rule, which
 * has no edit screen.
 */
export function refusedField(row: RefusedRow): 'date' | 'amount' | null {
  if (row.table !== 'transactions' || row.kind !== 'rejected') {
    return null;
  }
  if (row.code === '22007' || row.code === '22008') {
    return 'date';
  }
  return row.code === '22003' ? 'amount' : null;
}

/**
 * The ways out the list offers for a row. Discard, always. Edit, for a
 * transaction refused for its date or amount (refusedField) while its account
 * is live here: the register's edit screen fixes the field and keeps the row
 * -- where a Discard of an edit that went wrong deletes the copy the server
 * already holds, on every device. Move, for a row whose account is gone, since
 * a live account is the only home it can upload into: a row the server
 * refused for its account, and a transaction refused for its date or amount
 * whose account has been deleted since (the server casts the row's values
 * before it looks at the account, so it named the value). That one is moved
 * first, then edited in its new account's register, where the list offers
 * Edit after the next push; without the Move, Discard would be its only way
 * out. A rule refused for its own data, or one this device cannot prepare
 * (#129), gets neither: it has no edit screen, and a Move would only be
 * refused again.
 */
export function refusedRowActions(row: RefusedRow): {
  move: boolean;
  edit: boolean;
} {
  const fixable = refusedField(row) != null;
  return {
    move: row.kind === 'account' || (fixable && !row.accountLive),
    edit: fixable && row.accountLive,
  };
}

/** The account of a transfer's other side, while that side is live here. */
function otherSide(row: RefusedRow): string | null {
  return row.table === 'transactions' && row.transferLinkId
    ? row.partnerAccountName
    : null;
}

/**
 * The confirm before a Move to the account `name`: where the row goes, and
 * what happens next. A row refused for its account then uploads there; one
 * refused for its date or amount as well is refused again until that field is
 * edited, in its new account's register.
 */
export function moveConfirmation(row: RefusedRow, name: string): string {
  const field = refusedField(row);
  const partner = otherSide(row);
  const question = partner
    ? `Move this side of the transfer to ${name}? Its other side, in ${partner}, stays linked to it.`
    : `Move this ${nounOf(row)} to ${name}?`;
  if (field) {
    return `${question} Then edit its ${field} in ${name} so it can upload.`;
  }
  return partner ? question : `${question} It then uploads under ${name}.`;
}

/**
 * The confirm before a Discard: what it deletes, and where. A row the server
 * refused for its account was never held there, and is removed from this
 * device only; any other may be an edit of a row the server holds, deleted
 * everywhere. Where the row can be kept by fixing its date or amount, the
 * confirm says how: an edit that went wrong is otherwise discarded with the
 * copy the cloud already holds.
 */
export function discardConfirmation(row: RefusedRow): string {
  const noun = nounOf(row);
  let body =
    row.kind === 'account'
      ? `Discard this ${noun}? The cloud doesn't have it, so it is removed from this device only.`
      : `Discard this ${noun}? It is deleted from this device, and from your other devices if an earlier version of it reached them.`;
  const partner = otherSide(row);
  if (partner) {
    body += ` Its other side, in ${partner}, stays.`;
  }
  const field = refusedField(row);
  if (refusedRowActions(row).edit) {
    body += ' To keep it, edit it instead.';
  } else if (field) {
    // Its account is gone: the list offers Move, then Edit.
    body += ` To keep it, move it to another account instead, then edit its ${field}.`;
  }
  return body;
}

/**
 * The accounts a row can be moved to: the user's live accounts (the caller's
 * list, useAccounts) that are not archived (as every picker), not the row's
 * own, and, for one side of a transfer, not its other side's.
 */
export function moveTargets<T extends { id: string; isArchived: boolean }>(
  accounts: readonly T[] | undefined,
  row: RefusedRow
): T[] {
  return (accounts ?? []).filter(
    (a) =>
      !a.isArchived &&
      a.id !== row.accountId &&
      (row.table !== 'transactions' || a.id !== row.partnerAccountId)
  );
}

/** How many accounts the Settings line names before "and N more". */
const NAMED_ACCOUNTS = 3;

/**
 * The Settings line (#115 asks for the count and the accounts involved): the
 * rows the list shows, then the accounts they are in or were in, by the name
 * this device has or the push recorded, in the list's order. A row whose
 * account is gone and whose name was never recorded counts as "a deleted
 * account". Null when there is nothing to say.
 */
export function refusedSummary(rows: readonly RefusedRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const names: string[] = [];
  for (const row of rows) {
    const name =
      row.accountName ?? (row.accountLive ? null : 'a deleted account');
    if (name != null && !names.includes(name)) {
      names.push(name);
    }
  }
  const shown =
    names.length > NAMED_ACCOUNTS
      ? [
          ...names.slice(0, NAMED_ACCOUNTS),
          `${names.length - NAMED_ACCOUNTS} more`,
        ]
      : names;
  const head = `${rows.length} change(s) can't be uploaded`;
  return shown.length > 0 ? `${head} (${shown.join(', ')})` : head;
}

/** The status store's counts that waitingCounts reads. */
export interface PendingAndRefused {
  pendingCount: number;
  pendingAccounts: number;
  pendingTransactions: number;
  pendingSplits: number;
  pendingRules: number;
  refusedCount: number;
  refusedTransactions: number;
  refusedRules: number;
  refusedSplits: number;
}

/**
 * How many rows still wait to upload: every unsynced row the store counts,
 * less the refused ones and the split lines under them (which go up only with
 * them). Never below zero: the store's two reads are not one snapshot
 * (lib/syncStatus.ts). The one rule for Settings (waitingCounts), the header's
 * sync label (lib/syncStatusHelpers.ts) and the sign-out warning (#194).
 */
export function waitingTotal(
  s: Pick<PendingAndRefused, 'pendingCount' | 'refusedCount' | 'refusedSplits'>
): number {
  return Math.max(0, s.pendingCount - (s.refusedCount + s.refusedSplits));
}

/**
 * The rows still waiting to upload (waitingTotal), per table as Settings'
 * breakdown shows it.
 */
export function waitingCounts(s: PendingAndRefused): {
  total: number;
  accounts: number;
  transactions: number;
  splits: number;
  rules: number;
} {
  const less = (a: number, b: number) => Math.max(0, a - b);
  return {
    total: waitingTotal(s),
    accounts: s.pendingAccounts,
    transactions: less(s.pendingTransactions, s.refusedTransactions),
    splits: less(s.pendingSplits, s.refusedSplits),
    rules: less(s.pendingRules, s.refusedRules),
  };
}

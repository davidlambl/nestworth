// The policy behind the rows the push can never upload (#115), as pure
// functions: which refusals are permanent, how one push's answers merge into
// what the key held, how a damaged key reads, the ways out the list offers,
// and the words Settings and the list show. The engine's use of them is
// syncRefusals.test.ts. A new module: its regression proofs are the named
// mutants (the unit file).
import {
  createRefusalLog,
  describeRefusal,
  discardConfirmation,
  moveConfirmation,
  moveTargets,
  parseRefusals,
  refusalKind,
  refusedField,
  refusedRowActions,
  refusedSummary,
  waitingCounts,
  type RefusalEntry,
  type RefusedRow,
} from '../syncRefusals';

const T0 = '2026-10-15T08:00:00.000Z';
const NOW = '2026-10-16T10:00:00.000Z';

describe('refusalKind (#115)', () => {
  it('K1: class 22 and 23 refusals of the row are permanent; 23503 is the account kind unless purged', () => {
    const kinds = Object.fromEntries(
      [
        ['23503', null],
        ['22008', 'Perhaps you need a different "datestyle" setting.'],
        ['22007', null],
        ['22003', null],
        ['22P02', null],
        ['23514', null],
        ['23502', null],
        ['23505', null],
      ].map(([code, hint]) => [code, refusalKind({ code, hint })])
    );
    expect(kinds).toEqual({
      '23503': 'account',
      '22008': 'rejected',
      '22007': 'rejected',
      '22003': 'rejected',
      '22P02': 'rejected',
      '23514': 'rejected',
      '23502': 'rejected',
      '23505': 'rejected',
    });
  });

  it('K2: everything that may pass is transient: no code, a purged answer, RLS, a missing column, PostgREST, the server', () => {
    const transient = [
      { code: '23503', hint: 'purged' },
      { code: '', message: 'TypeError: Failed to fetch' },
      {
        code: '',
        message: 'NoSessionError: your sign-in could not be verified',
      },
      { code: '42501' },
      { code: '42703' },
      { code: 'PGRST204' },
      { code: 'PGRST301' },
      { code: '40001' },
      { code: '40P01' },
      { code: '57014' },
      { code: '08006' },
      { code: '53300' },
      { code: '22' },
      { code: '230' },
      { code: '2350' },
      { code: 23503 },
      { message: 'no code at all' },
      null,
      undefined,
    ].map((e) => refusalKind(e));
    expect(transient.every((k) => k === null)).toBe(true);
  });
});

describe('parseRefusals (#115)', () => {
  it('K3: a missing or damaged key reads as no refusals, and bad entries are skipped', () => {
    const good = {
      table: 'transactions',
      id: 't1',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    };
    expect({
      none: [null, undefined, '', '{', '{}', '"x"', '42'].map((raw) =>
        parseRefusals(raw as any)
      ),
      mixed: parseRefusals(
        JSON.stringify([
          good,
          { ...good, table: 'accounts' },
          { ...good, kind: 'other' },
          { id: 7 },
          null,
          { ...good, id: 't2', updatedAt: null, accountName: 3 },
        ])
      ).map((e) => `${e.id}:${e.updatedAt}:${e.accountName}`),
    }).toEqual({
      none: [[], [], [], [], [], [], []],
      mixed: [`t1:${T0}:Old`, 't2:null:null'],
    });
  });
});

describe('createRefusalLog (#115)', () => {
  const before: RefusalEntry[] = [
    {
      table: 'transactions',
      id: 'kept',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    },
    {
      table: 'transactions',
      id: 'edited',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    },
    {
      table: 'transactions',
      id: 'uploaded',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    },
    {
      table: 'recurring_rules',
      id: 'again',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    },
    {
      table: 'transactions',
      id: 'moved',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      since: T0,
    },
  ];

  it('K4: one push answers what it tried; a transient answer keeps the same version; untried rows drop out', () => {
    const log = createRefusalLog(before, NOW);
    log.retry('transactions', 'kept', T0); // offline: same version
    log.retry('transactions', 'edited', NOW); // a newer version, transient
    // 'uploaded' went up: nothing is said about it.
    log.refuse({
      table: 'recurring_rules',
      id: 'again',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'account',
      code: '23503',
      accountName: null,
    });
    log.refuse({
      table: 'transactions',
      id: 'moved',
      updatedAt: NOW,
      accountId: 'a9',
      kind: 'account',
      code: '23503',
      accountName: null,
    });
    log.refuse({
      table: 'transactions',
      id: 'new',
      updatedAt: NOW,
      accountId: 'a2',
      kind: 'rejected',
      code: '22008',
      accountName: null,
    });

    expect(
      log.next().map((e) => `${e.table}:${e.id}:${e.since}:${e.accountName}`)
    ).toEqual([
      // Same version, same kind: first seen at T0, and the name carried.
      `recurring_rules:again:${T0}:Old`,
      // Moved into another account and refused there: a new refusal, no name.
      `transactions:moved:${NOW}:null`,
      `transactions:new:${NOW}:null`,
      `transactions:kept:${T0}:Old`,
    ]);
  });

  it('K5: a row refused after a transient answer in the same push is listed once, as refused', () => {
    const log = createRefusalLog([], NOW);
    log.retry('transactions', 'x', T0);
    log.refuse({
      table: 'transactions',
      id: 'x',
      updatedAt: T0,
      accountId: 'a1',
      kind: 'rejected',
      code: '23514',
      accountName: null,
    });
    log.retry('transactions', 'x', T0);

    expect(log.next().map((e) => `${e.id}:${e.kind}`)).toEqual(['x:rejected']);
  });
});

describe('describeRefusal (#115)', () => {
  const base = {
    id: 'x',
    since: T0,
    updatedAt: T0,
    accountId: 'a1',
    accountLive: false,
  };
  const txn = (over: Partial<RefusedRow>): RefusedRow =>
    ({
      ...base,
      table: 'transactions',
      kind: 'account',
      code: '23503',
      accountName: null,
      txnDate: '2026-10-15',
      payee: 'P',
      amount: -1,
      transferLinkId: null,
      partnerAccountId: null,
      partnerAccountName: null,
      unsyncedSplits: 0,
      ...over,
    }) as RefusedRow;

  it('K6: says what happened, then what it means for the row; a row refused for its own data whose account is gone too says both', () => {
    const unprepared = (accountLive: boolean) =>
      ({
        ...txn({}),
        table: 'recurring_rules',
        kind: 'unprepared',
        code: '',
        accountLive,
        frequency: 'monthly',
        nextDate: null,
        payee: null,
        amount: null,
      }) as RefusedRow;
    const rejected = (code: string, over: Partial<RefusedRow> = {}) =>
      txn({ kind: 'rejected', code, accountLive: true, ...over });
    expect([
      describeRefusal(txn({ accountName: 'Old' })),
      describeRefusal(txn({})),
      describeRefusal(unprepared(true)),
      describeRefusal(rejected('22008')),
      describeRefusal(rejected('22003')),
      describeRefusal(rejected('23514')),
      // Its account deleted since, by another device: pulled away here.
      describeRefusal(
        rejected('22008', { accountLive: false, accountName: 'Old' })
      ),
      describeRefusal(rejected('22007', { accountLive: false })),
      describeRefusal(rejected('22003', { accountLive: false })),
      describeRefusal(rejected('23514', { accountLive: false })),
      describeRefusal(unprepared(false)),
    ]).toEqual([
      "Its account, Old, was deleted, so this transaction can't be uploaded.",
      "Its account was deleted, so this transaction can't be uploaded.",
      "This rule's saved details can't be read, so it can't be uploaded.",
      "The cloud can't store this transaction's date, so it can't be uploaded.",
      "The cloud can't store an amount this large, so this transaction can't be uploaded.",
      "The cloud refuses this transaction as it is (error 23514), so it can't be uploaded.",
      "The cloud can't store this transaction's date, and its account, Old, was deleted, so it can't be uploaded.",
      "The cloud can't store this transaction's date, and its account was deleted, so it can't be uploaded.",
      "The cloud can't store an amount this large, and this transaction's account was deleted, so it can't be uploaded.",
      "The cloud refuses this transaction as it is (error 23514), and its account was deleted, so it can't be uploaded.",
      "This rule's saved details can't be read, and its account was deleted, so it can't be uploaded.",
    ]);
  });
});

describe('what the list offers, and the Settings line (#115)', () => {
  const row = (
    over: Partial<RefusedRow> & Record<string, unknown>
  ): RefusedRow =>
    ({
      id: 'x',
      since: T0,
      updatedAt: T0,
      accountId: 'a1',
      accountLive: false,
      table: 'transactions',
      kind: 'account',
      code: '23503',
      accountName: 'Old',
      txnDate: '2026-10-15',
      payee: 'P',
      amount: -1,
      transferLinkId: null,
      partnerAccountId: null,
      partnerAccountName: null,
      unsyncedSplits: 0,
      ...over,
    }) as RefusedRow;
  const rule = (over: Record<string, unknown>) =>
    row({
      table: 'recurring_rules',
      frequency: 'monthly',
      nextDate: '2026-11-01',
      ...over,
    } as any);

  it('K7: Move for a row whose account is gone, unless a move and an edit could not make it upload; Edit for a transaction refused for its date or amount while its account is live; never for a rule', () => {
    const offer = (r: RefusedRow) => {
      const a = refusedRowActions(r);
      return `${a.move ? 'move' : '-'}/${a.edit ? 'edit' : '-'}`;
    };
    expect([
      offer(row({})),
      offer(row({ kind: 'rejected', code: '22007', accountLive: true })),
      offer(row({ kind: 'rejected', code: '22003', accountLive: true })),
      offer(row({ kind: 'rejected', code: '22008', accountLive: true })),
      offer(row({ kind: 'rejected', code: '23514', accountLive: true })),
      // Refused for its date or amount, its account deleted since (the server
      // casts the value first): moved, then edited, it uploads.
      offer(row({ kind: 'rejected', code: '22008', accountLive: false })),
      offer(row({ kind: 'rejected', code: '22007', accountLive: false })),
      offer(row({ kind: 'rejected', code: '22003', accountLive: false })),
      offer(row({ kind: 'rejected', code: '23514', accountLive: false })),
      offer(rule({ kind: 'rejected', code: '22008', accountLive: true })),
      offer(rule({ kind: 'rejected', code: '22008', accountLive: false })),
      offer(rule({ kind: 'unprepared', code: '', accountLive: true })),
      offer(rule({ kind: 'unprepared', code: '', accountLive: false })),
      offer(rule({ kind: 'account' })),
      // The kind decides, whatever code a damaged key pairs with it: a row
      // refused for its account is never Edit's.
      offer(row({ kind: 'account', code: '22008', accountLive: true })),
    ]).toEqual([
      'move/-',
      '-/edit',
      '-/edit',
      '-/edit',
      '-/-',
      'move/-',
      'move/-',
      'move/-',
      '-/-',
      '-/-',
      '-/-',
      '-/-',
      '-/-',
      'move/-',
      'move/-',
    ]);
  });

  it("K8: the accounts a row can move to: not archived, not its own, not a transfer's other side", () => {
    const accounts = [
      { id: 'a1', isArchived: false },
      { id: 'a2', isArchived: false },
      { id: 'a3', isArchived: true },
      { id: 'a4', isArchived: false },
    ];
    expect([
      moveTargets(accounts, row({})).map((a) => a.id),
      moveTargets(
        accounts,
        row({ transferLinkId: 'k', partnerAccountId: 'a4' })
      ).map((a) => a.id),
      moveTargets(accounts, rule({ partnerAccountId: 'a4' })).map((a) => a.id),
      moveTargets(undefined, row({})),
    ]).toEqual([['a2', 'a4'], ['a2'], ['a2', 'a4'], []]);
  });

  it('K9: the Settings line gives the count and the accounts involved, once each, the nameless gone one in words', () => {
    expect([
      refusedSummary([]),
      refusedSummary([row({}), row({ id: 'y' })]),
      refusedSummary([
        row({}),
        row({
          id: 'y',
          kind: 'rejected',
          accountName: 'Savings',
          accountLive: true,
        }),
        row({ id: 'z', accountName: null }),
      ]),
      refusedSummary([
        row({ accountName: 'A' }),
        row({ id: 'b', accountName: 'B' }),
        row({ id: 'c', accountName: 'C' }),
        row({ id: 'd', accountName: 'D' }),
        row({ id: 'e', accountName: 'E' }),
      ]),
      refusedSummary([row({ accountName: null, accountLive: true })]),
    ]).toEqual([
      null,
      "2 change(s) can't be uploaded (Old)",
      "3 change(s) can't be uploaded (Old, Savings, a deleted account)",
      "5 change(s) can't be uploaded (A, B, C, 2 more)",
      "1 change(s) can't be uploaded",
    ]);
  });

  it('K11: the confirms say where a row goes and what a discard deletes, and how to keep one refused for its date or amount', () => {
    const leg = {
      transferLinkId: 'k',
      partnerAccountId: 'a4',
      partnerAccountName: 'Brokerage',
    };
    expect({
      field: [
        refusedField(row({})),
        refusedField(row({ kind: 'rejected', code: '22007' })),
        refusedField(row({ kind: 'rejected', code: '22008' })),
        refusedField(row({ kind: 'rejected', code: '22003' })),
        refusedField(row({ kind: 'rejected', code: '23514' })),
        refusedField(rule({ kind: 'rejected', code: '22008' })),
      ],
      move: [
        moveConfirmation(row({}), 'Savings'),
        moveConfirmation(rule(leg), 'Savings'),
        moveConfirmation(row(leg), 'Savings'),
        moveConfirmation(row({ kind: 'rejected', code: '22008' }), 'Savings'),
        moveConfirmation(row({ kind: 'rejected', code: '22003' }), 'Savings'),
        moveConfirmation(
          row({ kind: 'rejected', code: '22007', ...leg }),
          'Savings'
        ),
      ],
      discard: [
        discardConfirmation(row({})),
        discardConfirmation(row(leg)),
        discardConfirmation(rule(leg)),
        discardConfirmation(
          row({ kind: 'rejected', code: '22008', accountLive: true })
        ),
        discardConfirmation(row({ kind: 'rejected', code: '22008' })),
        discardConfirmation(row({ kind: 'rejected', code: '22003', ...leg })),
        discardConfirmation(row({ kind: 'rejected', code: '23514' })),
        discardConfirmation(rule({ kind: 'unprepared', code: '' })),
      ],
    }).toEqual({
      field: [null, 'date', 'date', 'amount', null, null],
      move: [
        'Move this transaction to Savings? It then uploads under Savings.',
        'Move this rule to Savings? It then uploads under Savings.',
        'Move this side of the transfer to Savings? Its other side, in Brokerage, stays linked to it.',
        'Move this transaction to Savings? Then edit its date in Savings so it can upload.',
        'Move this transaction to Savings? Then edit its amount in Savings so it can upload.',
        'Move this side of the transfer to Savings? Its other side, in Brokerage, stays linked to it. Then edit its date in Savings so it can upload.',
      ],
      discard: [
        "Discard this transaction? The cloud doesn't have it, so it is removed from this device only.",
        "Discard this transaction? The cloud doesn't have it, so it is removed from this device only. Its other side, in Brokerage, stays.",
        "Discard this rule? The cloud doesn't have it, so it is removed from this device only.",
        'Discard this transaction? It is deleted from this device, and from your other devices if an earlier version of it reached them. To keep it, edit it instead.',
        'Discard this transaction? It is deleted from this device, and from your other devices if an earlier version of it reached them. To keep it, move it to another account instead, then edit its date.',
        'Discard this transaction? It is deleted from this device, and from your other devices if an earlier version of it reached them. Its other side, in Brokerage, stays. To keep it, move it to another account instead, then edit its amount.',
        'Discard this transaction? It is deleted from this device, and from your other devices if an earlier version of it reached them.',
        'Discard this rule? It is deleted from this device, and from your other devices if an earlier version of it reached them.',
      ],
    });
  });
});

describe('waitingCounts (#115)', () => {
  it('K10: what waits to upload is the unsynced rows less the refused ones and their split lines, never below zero', () => {
    const counts = {
      pendingCount: 7,
      pendingAccounts: 1,
      pendingTransactions: 3,
      pendingSplits: 2,
      pendingRules: 1,
      refusedCount: 2,
      refusedTransactions: 1,
      refusedRules: 1,
      refusedSplits: 2,
    };
    expect([
      waitingCounts(counts),
      waitingCounts({ ...counts, pendingCount: 3 }).total,
    ]).toEqual([
      { total: 3, accounts: 1, transactions: 2, splits: 0, rules: 0 },
      0,
    ]);
  });
});

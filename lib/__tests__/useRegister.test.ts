// The registers' hooks a page at a time (#28): useRegister and
// useAllAccountsRegister over a seeded register of 10,000 rows, as the
// screens use them (registerView and allAccountsView put the pages, the
// balances and the summary together; the screens have no component test,
// so what they draw is verified in a browser). The pages must show what the
// whole register showed -- the same rows, the same balance per row, the same
// summary -- through what TanStack does to them: a write's invalidation
// refetching every loaded page, the list asking for the next page while that
// refetch is out, an edit patched in before it lands, a search typed into
// the box, a realtime burst. A new hook: its tests cannot load on the code
// before #28, so their red proofs are the named mutants (the unit file's
// mutant table).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: jest.fn(() => `new-${++n}`) };
});

import { createElement, Fragment, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDb } from '../db';
import { mapAccount, mapRecurringRule, mapTransaction } from '../mappers';
import { createInvalidationBatcher } from '../realtimeBatch';
import {
  activeAccountTransactions,
  allAccountsView,
  computeAllAccountsBalanceSummary,
  computeBalanceSummary,
  computeRunningBalances,
  filterTransactions,
  nextCheckNumber,
  registerView,
  uniquePayees,
  type BalanceSummary,
} from '../register';
import { REGISTER_INDEXES_SQL, type RegisterFilter } from '../registerRead';
import {
  useAccount,
  useAccounts,
  useUpdateAccount,
} from '../hooks/useAccounts';
import { usePostRecurringTransaction } from '../hooks/useRecurringRules';
import {
  useAllAccountsRegister,
  useCreateTransaction,
  useRegister,
  useTransactionHints,
  useUpdateTransaction,
} from '../hooks/useTransactions';
import { seedRegister } from '../testing/registerSeed';
import {
  insertLocalAccount,
  insertLocalRule,
  makeAdapter,
} from '../testing/syncFixture';
import type {
  DbAccount,
  DbRecurringRule,
  DbTransaction,
  TransactionWithSplits,
} from '../types';

const ALL: RegisterFilter = { status: 'all', search: '' };

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;

/** What the register screen was given at one commit. */
type Shown = {
  rows: string[];
  balances: (number | undefined)[];
  summary: BalanceSummary;
  isLoading: boolean;
};
let shown: Shown[];
let loadMore: () => Promise<void>;
let update: ReturnType<typeof useUpdateTransaction>;
let create: ReturnType<typeof useCreateTransaction>;
let hints: ReturnType<typeof useTransactionHints>;

/** The register screen's reads (app/account/[id].tsx). */
function Register({
  filter,
  accountId = 'acct-00',
}: {
  filter: RegisterFilter;
  accountId?: string;
}) {
  const account = useAccount(accountId);
  const pages = useRegister(accountId, filter);
  const upd = useUpdateTransaction();
  const crt = useCreateTransaction();
  const view = registerView(account.data, accountId, pages.data);
  useEffect(() => {
    loadMore = pages.loadMore;
    update = upd;
    create = crt;
  });
  shown.push({
    rows: view.rows.map((t) => t.id),
    balances: view.rows.map((t) => view.balances.get(t.id)),
    summary: view.summary,
    isLoading: pages.isLoading,
  });
  return null;
}

/** The New Transaction form's read (app/transaction/new.tsx). */
function Form() {
  const h = useTransactionHints('acct-00');
  const crt = useCreateTransaction();
  useEffect(() => {
    hints = h;
    create = crt;
  });
  return null;
}

let allShown: { rows: string[]; summary: BalanceSummary }[];

/** The All Accounts screen's reads (app/account/all.tsx). */
function AllAccounts({ filter }: { filter: RegisterFilter }) {
  const accounts = useAccounts();
  const pages = useAllAccountsRegister(filter);
  const ledger = allAccountsView(accounts.data, pages.data);
  useEffect(() => {
    loadMore = pages.loadMore;
  });
  allShown.push({
    rows: ledger.rows.map((t) => t.id),
    summary: ledger.summary,
  });
  return null;
}

async function settle() {
  for (let i = 0, idle = 0; i < 60 && idle < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    idle = qc.isFetching() + qc.isMutating() > 0 ? 0 : idle + 1;
  }
}

async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, element)
    );
  });
  await settle();
}

async function rerender(element: ReturnType<typeof createElement>) {
  await act(async () => {
    renderer.update(
      createElement(QueryClientProvider, { client: qc }, element)
    );
  });
}

/** Reads answer after a round trip, as expo-sqlite's and wa-sqlite's do. */
function slowReads(ms: number) {
  const read = adapter.getAllAsync;
  adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
    await new Promise((r) => setTimeout(r, ms));
    return read(sql, params as any);
  }) as typeof adapter.getAllAsync;
}

/** Counts the register's page reads (not its totals, not its splits). */
function countPageReads(): () => number {
  let n = 0;
  const read = adapter.getAllAsync;
  adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
    if (/SELECT t\.\*, t\.rowid AS _rowid/.test(sql)) n++;
    return read(sql, params as any);
  }) as typeof adapter.getAllAsync;
  return () => n;
}

/** The whole register as the code before #28 listed it (registerRead.test P1). */
function wholeRegister(): TransactionWithSplits[] {
  return (
    adapter._sqlite
      .prepare(
        `SELECT * FROM transactions
          WHERE account_id = 'acct-00' AND user_id = 'u' AND _sync_status != 'deleted'
          ORDER BY txn_date DESC, created_at DESC, rowid ASC`
      )
      .all() as DbTransaction[]
  ).map((r) => ({ ...mapTransaction(r), splits: [] }));
}

function initialBalance(): number {
  return mapAccount(
    adapter._sqlite
      .prepare("SELECT * FROM accounts WHERE id = 'acct-00'")
      .get() as DbAccount
  ).initialBalance;
}

/** What the whole-list rules put on screen for the first `n` rows. */
function expected(filter: RegisterFilter, n: number) {
  const whole = wholeRegister();
  const kept = filterTransactions(whole, filter.status, filter.search);
  const balances = computeRunningBalances(initialBalance(), whole, kept);
  return {
    rows: kept.slice(0, n).map((t) => t.id),
    balances: kept.slice(0, n).map((t) => balances.get(t.id)),
    summary: computeBalanceSummary(initialBalance(), whole),
  };
}

const last = () => {
  const s = shown[shown.length - 1];
  return { rows: s.rows, balances: s.balances, summary: s.summary };
};

/** A row written at the top of the register, outside any hook. */
function writeNewest(id: string, amount: number) {
  adapter._sqlite
    .prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'acct-00', '2026-12-31', 'Newest', ?, 'pending', '2026-12-31T00:00:00.000Z', '2026-12-31T00:00:00.000Z', 'synced')`
    )
    .run(id, amount);
}

beforeEach(() => {
  adapter = makeAdapter();
  seedRegister(adapter._sqlite, { userId: 'u', mainRows: 10_000 });
  adapter._sqlite.exec(REGISTER_INDEXES_SQL);
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  shown = [];
  allShown = [];
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  adapter._sqlite.close();
});

describe('an account register of 10,000 rows (#28)', () => {
  it('H1: opens on its first page, each row with the balance and under it the summary the whole register gave', async () => {
    await mount(createElement(Register, { filter: ALL }));
    expect(last()).toEqual(expected(ALL, 100));
  });

  it('H2: the next page continues the balance from the last row of the first', async () => {
    await mount(createElement(Register, { filter: ALL }));
    await act(async () => {
      await loadMore();
    });
    await settle();
    expect(last()).toEqual(expected(ALL, 200));
  });

  it("H3: a save's refetch reads every loaded page again from the new top, the rows shifted and every balance the whole register's", async () => {
    await mount(createElement(Register, { filter: ALL }));
    await act(async () => {
      await loadMore();
    });
    await settle();
    const reads = countPageReads();

    await act(async () => {
      await create.mutateAsync({
        accountId: 'acct-00',
        txnDate: '2026-12-31',
        payee: 'Newest',
        amount: -12.34,
      });
    });
    await settle();

    expect({ ...last(), pageReads: reads() }).toEqual({
      ...expected(ALL, 200),
      pageReads: 2,
    });
    expect(last().rows[0]).toBe('new-1');
  });

  it("H4: the list asking for the next page while a sync's refetch is out joins it, then reads the page -- the refetch is not cancelled", async () => {
    await mount(createElement(Register, { filter: ALL }));
    writeNewest('late', -1);
    slowReads(15);

    await act(async () => {
      void qc.invalidateQueries();
      await new Promise((r) => setTimeout(r, 1));
      await loadMore();
    });
    await settle();

    expect(last()).toEqual(expected(ALL, 200));
    expect(last().rows[0]).toBe('late');
  });

  it('H5: a pending row ticked Cleared leaves the Pending list and moves its amount in the summary before the write lands', async () => {
    const pending: RegisterFilter = { status: 'pending', search: '' };
    await mount(createElement(Register, { filter: pending }));
    const ticked = last().rows[0];
    const amount = wholeRegister().find((t) => t.id === ticked)!.amount;
    const before = last().summary;
    let release!: () => void;
    const held = adapter.withTransactionAsync(
      () => new Promise<void>((r) => (release = r))
    );

    await act(async () => {
      update.mutate({ id: ticked, accountId: 'acct-00', status: 'cleared' });
      await new Promise((r) => setTimeout(r, 0));
    });
    const optimistic = last();
    await act(async () => {
      release();
      await held;
    });
    await settle();

    expect({
      gone: optimistic.rows.includes(ticked),
      outstanding: Math.round(optimistic.summary.outstanding * 100),
      cleared: Math.round(optimistic.summary.cleared * 100),
      balance: optimistic.summary.balance,
    }).toEqual({
      gone: false,
      outstanding: Math.round((before.outstanding - amount) * 100),
      cleared: Math.round((before.cleared + amount) * 100),
      balance: before.balance,
    });
    expect(last()).toEqual(expected(pending, 100));
  });

  it('H6: an edit refused when it lands is rolled back to the pages before it, then refetched', async () => {
    await mount(createElement(Register, { filter: ALL }));
    const first = last();
    const edited = first.rows[0];
    const amount = wholeRegister().find((t) => t.id === edited)!.amount;
    let release!: () => void;
    const held = adapter.withTransactionAsync(
      () => new Promise<void>((r) => (release = r))
    );
    await act(async () => {
      update.mutate({ id: edited, accountId: 'acct-00', amount: 99_999 });
      await new Promise((r) => setTimeout(r, 0));
    });
    const optimistic = last();
    // The row goes meanwhile (a pulled tombstone's plain DELETE): the edit
    // finds nothing to update and is refused.
    adapter._sqlite
      .prepare('DELETE FROM transactions WHERE id = ?')
      .run(edited);
    slowReads(20);
    const from = shown.length;
    await act(async () => {
      release();
      await held;
    });
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await settle();

    // The top row shows the account's balance: the edit's new amount moved
    // into the totals at once.
    expect(Math.round(optimistic.balances[0]! * 100)).toBe(
      Math.round((first.balances[0]! + 99_999 - amount) * 100)
    );
    expect(shown.slice(from).map((s) => s.balances[0])).toContainEqual(
      first.balances[0]
    );
    expect(last()).toEqual(expected(ALL, 100));
  });

  it('H7: a search typed into the box keeps the rows on screen until its first page lands, and never shows the spinner', async () => {
    await mount(createElement(Register, { filter: ALL }));
    slowReads(10);
    const from = shown.length;
    for (const search of ['s', 'st', 'sta', 'star']) {
      await rerender(
        createElement(Register, { filter: { status: 'all', search } })
      );
    }
    await settle();
    const during = shown.slice(from);
    expect({
      spinner: during.some((s) => s.isLoading),
      empty: during.some((s) => s.rows.length === 0),
    }).toEqual({ spinner: false, empty: false });
    expect(last()).toEqual(expected({ status: 'all', search: 'star' }, 100));
  });

  it("H8: a realtime burst of 40 rows refetches the register's loaded pages once per window, not once per row", async () => {
    await mount(createElement(Register, { filter: ALL }));
    await act(async () => {
      await loadMore();
    });
    await settle();
    const reads = countPageReads();
    const batcher = createInvalidationBatcher(
      (queryKey) => void qc.invalidateQueries({ queryKey }),
      200
    );
    await act(async () => {
      for (let i = 0; i < 40; i++) {
        writeNewest(`burst-${i}`, -1);
        batcher.add(['transactions', '__all__'], ['transactions', 'acct-00']);
        await new Promise((r) => setTimeout(r, 2));
      }
      await new Promise((r) => setTimeout(r, 400));
    });
    await settle();
    batcher.cancel();

    expect(reads()).toBeLessThanOrEqual(4);
    expect(last()).toEqual(expected(ALL, 200));
  });

  it("H10: opening another account's register (the sidebar's next account) never shows the last one's rows while it reads", async () => {
    adapter._sqlite.exec(
      `INSERT INTO accounts (id, user_id, name, type, initial_balance, created_at, updated_at)
       VALUES ('acct-x', 'u', 'Other', 'checking', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
       INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at)
       VALUES ('x1', 'u', 'acct-x', '2026-01-02', 'X', -1, 'cleared', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`
    );
    await mount(createElement(Register, { filter: ALL }));
    const before = new Set(last().rows);
    slowReads(10);
    const from = shown.length;
    await rerender(
      createElement(Register, { filter: ALL, accountId: 'acct-x' })
    );
    await settle();
    expect(
      shown.slice(from).some((s) => s.rows.some((id) => before.has(id)))
    ).toBe(false);
    expect(last().rows).toEqual(['x1']);
  });

  it('H9: at the end of the register, asking for more reads nothing', async () => {
    adapter._sqlite
      .prepare(
        "DELETE FROM transactions WHERE account_id = 'acct-00' AND rowid NOT IN (SELECT rowid FROM transactions WHERE account_id = 'acct-00' ORDER BY rowid LIMIT 150)"
      )
      .run();
    await mount(createElement(Register, { filter: ALL }));
    await act(async () => {
      await loadMore();
    });
    await settle();
    const reads = countPageReads();
    await act(async () => {
      await loadMore();
    });
    await settle();
    expect({ shown: last(), reads: reads() }).toEqual({
      shown: expected(ALL, 200),
      reads: 0,
    });
  });
});

describe('the New Transaction form (#28)', () => {
  it("F1: is offered the whole register's payees and next check number, and a save's refetch adds the new payee first", async () => {
    await mount(createElement(Form));
    const whole = wholeRegister();
    const before = hints.data;
    await act(async () => {
      await create.mutateAsync({
        accountId: 'acct-00',
        txnDate: '2026-12-31',
        payee: 'Zebra Café',
        amount: -1,
        checkNumber: '99999',
      });
    });
    await settle();
    expect({
      before,
      after: {
        first: hints.data?.payees[0],
        next: hints.data?.nextCheckNumber,
      },
    }).toEqual({
      before: {
        payees: uniquePayees(whole),
        nextCheckNumber: nextCheckNumber(whole),
      },
      after: { first: 'Zebra Café', next: '100000' },
    });
  });
});

describe('All Accounts (#28)', () => {
  beforeEach(() => {
    adapter._sqlite.close();
    adapter = makeAdapter();
    seedRegister(adapter._sqlite, {
      userId: 'u',
      mainRows: 1_000,
      siblings: 9,
      siblingRows: 4_000,
    });
    adapter._sqlite.exec(REGISTER_INDEXES_SQL);
    (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  });

  it("L1: lists the active accounts' rows a page at a time, and its summary is the whole list's", async () => {
    await mount(createElement(AllAccounts, { filter: ALL }));
    await act(async () => {
      await loadMore();
    });
    await settle();
    const accounts = (
      adapter._sqlite
        .prepare(
          "SELECT * FROM accounts WHERE user_id = 'u' AND _sync_status != 'deleted'"
        )
        .all() as DbAccount[]
    ).map(mapAccount);
    const whole = (
      adapter._sqlite
        .prepare(
          `SELECT * FROM transactions WHERE user_id = 'u' AND _sync_status != 'deleted'
            ORDER BY txn_date DESC, created_at DESC, rowid ASC`
        )
        .all() as DbTransaction[]
    ).map((r) => ({ ...mapTransaction(r), splits: [] }));
    const s = allShown[allShown.length - 1];
    expect(s).toEqual({
      rows: activeAccountTransactions(accounts, whole)
        .slice(0, 200)
        .map((t) => t.id),
      summary: computeAllAccountsBalanceSummary(accounts, whole),
    });
  });
});

// The attack lens's findings (u28bal): BAL2 All Accounts follows an account
// archived or unarchived, BAL4 a search typed over another stops its reads,
// BAL5 the optimistic patch of a transfer and of a searched register.
describe('the registers after an edit elsewhere (#28)', () => {
  let rowsShown: { id: string; amount: number }[][];
  let updateAccount: ReturnType<typeof useUpdateAccount>;

  function Ledger({ filter }: { filter: RegisterFilter }) {
    const accounts = useAccounts();
    const pages = useAllAccountsRegister(filter);
    const upd = useUpdateTransaction();
    const updAccount = useUpdateAccount();
    const ledger = allAccountsView(accounts.data, pages.data);
    useEffect(() => {
      update = upd;
      updateAccount = updAccount;
    });
    allShown.push({
      rows: ledger.rows.map((t) => t.id),
      summary: ledger.summary,
    });
    rowsShown.push(ledger.rows.map((t) => ({ id: t.id, amount: t.amount })));
    return null;
  }

  /** The next write waits for release(): the screen meanwhile is the optimistic patch. */
  function holdWrites(): () => Promise<void> {
    let release!: () => void;
    const held = adapter.withTransactionAsync(
      () => new Promise<void>((r) => (release = r))
    );
    return async () => {
      release();
      await held;
    };
  }

  beforeEach(() => {
    adapter._sqlite.close();
    adapter = makeAdapter();
    adapter._sqlite.exec(REGISTER_INDEXES_SQL);
    adapter._sqlite.exec(`
      INSERT INTO accounts (id, user_id, name, type, initial_balance, created_at, updated_at) VALUES
        ('acct-00', 'u', 'Checking', 'checking', 1000, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
        ('B', 'u', 'Savings', 'savings', 500, '2020-01-02T00:00:00Z', '2020-01-02T00:00:00Z');
      INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, transfer_link_id, created_at, updated_at) VALUES
        ('tA', 'u', 'acct-00', '2026-03-02', 'Transfer to Savings', -100, 'cleared', 'L', '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
        ('tB', 'u', 'B', '2026-03-02', 'Transfer from Checking', 100, 'cleared', 'L', '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z'),
        ('s1', 'u', 'acct-00', '2026-03-01', 'Starbucks', -5, 'pending', NULL, '2026-03-01T08:00:00.000Z', '2026-03-01T08:00:00.000Z'),
        ('s2', 'u', 'acct-00', '2026-02-28', 'Starbucks', -6, 'cleared', NULL, '2026-02-28T08:00:00.000Z', '2026-02-28T08:00:00.000Z');
    `);
    (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
    rowsShown = [];
  });

  it("PT1: a transfer's amount edited in All Accounts shows both legs at once, the other with the opposite sign, and the summary does not move", async () => {
    await mount(createElement(Ledger, { filter: ALL }));
    const before = allShown[allShown.length - 1];
    const release = holdWrites();
    await act(async () => {
      update.mutate({ id: 'tA', accountId: 'acct-00', amount: -150 });
      await new Promise((r) => setTimeout(r, 0));
    });
    const optimistic = {
      legs: rowsShown[rowsShown.length - 1]
        .filter((t) => t.id === 'tA' || t.id === 'tB')
        .map((t) => t.amount),
      summary: allShown[allShown.length - 1].summary,
    };
    await act(async () => {
      await release();
    });
    await settle();
    expect(optimistic).toEqual({ legs: [-150, 150], summary: before.summary });
  });

  it('PT2: a row whose payee is edited out of the search leaves the searched register at once, as the whole-list filter took it out', async () => {
    await mount(
      createElement(Register, { filter: { status: 'all', search: 'star' } })
    );
    expect(last().rows).toEqual(['s1', 's2']);
    const release = holdWrites();
    await act(async () => {
      update.mutate({ id: 's1', accountId: 'acct-00', payee: 'Shell' });
      await new Promise((r) => setTimeout(r, 0));
    });
    const optimistic = last().rows;
    await act(async () => {
      await release();
    });
    await settle();
    expect({ optimistic, after: last().rows }).toEqual({
      optimistic: ['s2'],
      after: ['s2'],
    });
  });

  it('AR1: an account archived here leaves All Accounts with its rows, as the summary does', async () => {
    await mount(createElement(Ledger, { filter: ALL }));
    await act(async () => {
      await updateAccount.mutateAsync({ id: 'B', isArchived: true });
    });
    await settle();
    // Before: ['tA', 'tB', 's1', 's2'] under a summary without B -- the
    // archived account's rows listed and not summed (#24).
    expect(allShown[allShown.length - 1].rows).toEqual(['tA', 's1', 's2']);
  });

  it('AR3: an account unarchived here comes back to All Accounts with its rows', async () => {
    adapter._sqlite.exec("UPDATE accounts SET is_archived = 1 WHERE id = 'B'");
    await mount(createElement(Ledger, { filter: ALL }));
    expect(allShown[allShown.length - 1].rows).toEqual(['tA', 's1', 's2']);
    await act(async () => {
      await updateAccount.mutateAsync({ id: 'B', isArchived: false });
    });
    await settle();
    expect(allShown[allShown.length - 1].rows).toEqual([
      'tA',
      'tB',
      's1',
      's2',
    ]);
  });
});

describe('a search typed over another (#28)', () => {
  it('TY1: a keystroke typed over a search stops the reads of the search it replaced', async () => {
    await mount(createElement(Register, { filter: ALL }));
    // The batches a search reads bind its query (the check number's instr).
    const batchesOf = new Map<string, number>();
    const read = adapter.getAllAsync;
    adapter.getAllAsync = (async (sql: string, params?: unknown[]) => {
      await new Promise((r) => setTimeout(r, 5));
      for (const q of ['ø', 'øs']) {
        if (params?.includes(q)) batchesOf.set(q, (batchesOf.get(q) ?? 0) + 1);
      }
      return read(sql, params as any);
    }) as typeof adapter.getAllAsync;
    await rerender(
      createElement(Register, { filter: { status: 'all', search: 'ø' } })
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    await rerender(
      createElement(Register, { filter: { status: 'all', search: 'øs' } })
    );
    // Until every read is done (bounded): the replaced search's batches, if
    // it was not stopped, run on with their 5 ms each.
    for (let i = 0; i < 200 && qc.isFetching() > 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    await settle();
    // Read to its end, the 'ø' search is 5 batches here (4,330 rows holding
    // text outside ASCII, nothing kept); typed over, it stops at the batch
    // in flight. 'øs' is read to its end.
    expect({
      replaced: (batchesOf.get('ø') ?? 0) <= 2,
      last: batchesOf.get('øs'),
      rows: last().rows,
    }).toEqual({ replaced: true, last: 5, rows: [] });
  });
});

describe('a row saved before the cap (#28, #165)', () => {
  beforeEach(async () => {
    await insertLocalAccount(adapter, { id: 'big', user_id: 'u' });
    const insert = adapter._sqlite.prepare(
      `INSERT INTO transactions (id, user_id, account_id, txn_date, payee, amount, status, created_at, updated_at, _sync_status)
       VALUES (?, 'u', 'big', ?, 'P', ?, ?, ?, ?, 'pending')`
    );
    for (const [id, day, amount, status] of [
      ['fare', '2025-01-03', 5, 'pending'],
      ['typo', '2025-01-02', 1e19, 'pending'],
      ['old', '2025-01-01', 12.34, 'cleared'],
      ['older', '2024-12-31', -0.07, 'pending'],
    ] as const) {
      const at = `${day}T00:00:00.000Z`;
      insert.run(id, day, amount, status, at, at);
    }
  });

  // The Unsynced screen's Edit (#115) is how such a row is put right. Before
  // the fix the edit took 1e21 cents out of a float sum that had swallowed
  // the other rows' cents: until the write landed the register showed a top
  // of 17.34 and an Outstanding of 5.00.
  it('BC1: edited down to a real amount, it moves the totals at once: before the write lands every balance and the summary are the exact ones', async () => {
    await mount(createElement(Register, { filter: ALL, accountId: 'big' }));
    let release!: () => void;
    const held = adapter.withTransactionAsync(
      () => new Promise<void>((r) => (release = r))
    );
    await act(async () => {
      update.mutate({ id: 'typo', accountId: 'big', amount: 5 });
      await new Promise((r) => setTimeout(r, 0));
    });
    const optimistic = last();
    await act(async () => {
      release();
      await held;
    });
    await settle();

    const exact = {
      rows: ['fare', 'typo', 'old', 'older'],
      balances: [22.27, 17.27, 12.27, -0.07],
      summary: { cleared: 12.34, outstanding: 9.93, balance: 22.27 },
    };
    expect({ optimistic, landed: last() }).toEqual({
      optimistic: exact,
      landed: exact,
    });
  });
});

describe('a recurring occurrence posted while the register is open (#28)', () => {
  let post: ReturnType<typeof usePostRecurringTransaction>;

  function Poster() {
    const mutation = usePostRecurringTransaction();
    useEffect(() => {
      post = mutation;
    });
    return null;
  }

  // An overdue rule posts at its due date, inside the history: the pages read
  // after it list the new row, under a first page that does not count it.
  // Before the fix the post refetched neither register: every row below it
  // showed a balance short by its amount until the next sync, offline for
  // as long as the device stayed offline.
  it('RP1: refetches the register, so the next page and every balance count the posted row', async () => {
    const day = wholeRegister()[150].txnDate;
    await insertLocalRule(adapter, {
      id: 'r1',
      account_id: 'acct-00',
      frequency: 'monthly',
      next_date: day,
      template: {
        payee: 'Storage unit',
        amount: -1200,
        checkNumber: null,
        memo: null,
        splits: [],
      },
    });
    const rule = mapRecurringRule(
      adapter._sqlite
        .prepare("SELECT * FROM recurring_rules WHERE id = 'r1'")
        .get() as DbRecurringRule
    );
    await mount(
      createElement(
        Fragment,
        null,
        createElement(Register, { filter: ALL }),
        createElement(Poster)
      )
    );
    expect(last().rows).toHaveLength(100);

    await act(async () => {
      await post.mutateAsync(rule);
    });
    await settle();
    await act(async () => {
      await loadMore();
    });
    await settle();

    const posted = wholeRegister().findIndex((t) => t.payee === 'Storage unit');
    expect({ onPage2: posted >= 100 && posted < 200, shown: last() }).toEqual({
      onPage2: true,
      shown: expected(ALL, 200),
    });
  });
});

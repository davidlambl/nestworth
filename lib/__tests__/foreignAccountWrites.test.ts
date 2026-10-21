// A row is created only under an account of the signed-in user's (#177).
// Every writer that creates a row under an account checks the account first
// (#163: live here, not marked deleted), and that check read the account by
// id alone. Several accounts sign in on one device in turn, and sign-out wipes
// no local rows, so a second account could open the New Transaction screen on
// the first one's account id (/transaction/new?accountId=..., from the
// browser's history) or the Transfer screen from it
// (/transaction/transfer?fromAccountId=...): the account was live here, so the
// row went in under it, owned by the second account, and the server took it
// (001's foreign key and policy look at the row's own user only). Now the
// check is for an account of the signed-in user's, and another account's reads
// as missing -- in the words every refusal of a missing account already uses,
// never the "was deleted on this device" that would say the account exists
// here for someone else. The CSV import, a new rule and a rule's post take
// their account from the user's own lists, so no screen reaches them with
// another account's; they make the same check, so that no writer is the
// exception.
//
// And an account is edited only by its own user. useUpdateAccount wrote by
// id alone, and the Accounts tab's Edit Account sheet and icon picker keep
// the account they opened in their own state: left open in one tab of the
// app while another tab signed a second account in over the first (auth-js
// tells this tab SIGNED_IN alone, so the tabs never passed through "signed
// out"), the sheet's Save renamed the first account's account. It now
// requires the user's own account too, and words another's as missing, in
// #55's words, never as deleted here.
//
// Own file, importing the six writers and the fixture; every test loads on
// the code before #177. F1, F2, F4 and F5 are red there; F3 and F6 are pins.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
let mockUserId = 'b';
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: mockUserId } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { applyAccountDelete } from '../accountDelete';
import { createTransfer } from '../transferCreate';
import { applyTransactionImport } from '../transactionImport';
import { mapRecurringRule } from '../mappers';
import { useUpdateAccount } from '../hooks/useAccounts';
import { useCreateTransaction } from '../hooks/useTransactions';
import {
  useCreateRecurringRule,
  usePostRecurringTransaction,
} from '../hooks/useRecurringRules';
import {
  insertLocalAccount,
  insertLocalRule,
  makeAdapter,
} from '../testing/syncFixture';
import type { DbRecurringRule } from '../types';

const SYNCED_AT = '2026-05-10T00:00:00Z';
const NOW = '2026-10-21T12:00:00.000Z';

const TEMPLATE = {
  payee: 'Gym',
  amount: -30,
  checkNumber: null,
  memo: null,
  splits: [],
};

/** Each writer's words for an account that is not here. */
const GONE = {
  transaction:
    'Error: This account no longer exists on this device, so the transaction was not saved.',
  transferFrom:
    'Error: The account you are transferring from no longer exists on this device, so the transfer was not saved.',
  transferTo:
    'Error: The account you are transferring to no longer exists on this device, so the transfer was not saved.',
  import:
    'Error: This account no longer exists on this device, so nothing was imported.',
  rule: 'Error: This account no longer exists on this device, so the rule was not created.',
  post: 'Error: This account no longer exists on this device, so nothing was posted.',
};

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let hooks: {
  createTxn: ReturnType<typeof useCreateTransaction>;
  createRule: ReturnType<typeof useCreateRecurringRule>;
  post: ReturnType<typeof usePostRecurringTransaction>;
  updateAccount: ReturnType<typeof useUpdateAccount>;
};
let quiet: jest.SpyInstance[];

function Harness() {
  const createTxn = useCreateTransaction();
  const createRule = useCreateRecurringRule();
  const post = usePostRecurringTransaction();
  const updateAccount = useUpdateAccount();
  useEffect(() => {
    hooks = { createTxn, createRule, post, updateAccount };
  });
  return null;
}

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  let outcome = 'resolved';
  await act(async () => {
    try {
      await p;
    } catch (e) {
      outcome = String(e);
    }
  });
  return outcome;
}

/** The pure writers' ids, one sequence per test so that no two collide. */
let seq = 0;
const nextId = () => `new-${++seq}`;

/** Every transaction and rule the writers made: `owner:account`, sorted. */
function written() {
  const of = (table: string) =>
    (
      adapter._sqlite
        .prepare(
          `SELECT user_id, account_id FROM ${table} WHERE id LIKE 'id-%' OR id LIKE 'new-%' ORDER BY id`
        )
        .all() as { user_id: string; account_id: string }[]
    )
      .map((r) => `${r.user_id}:${r.account_id}`)
      .sort();
  return { transactions: of('transactions'), rules: of('recurring_rules') };
}

/** An account's owner, name and status, as stored here. */
const accountRow = (id: string) =>
  adapter._sqlite
    .prepare('SELECT user_id, name, _sync_status FROM accounts WHERE id = ?')
    .get(id);

/** b's rule r1, filed under `accountId`, as the Recurring list maps it. */
async function ruleOn(accountId: string) {
  await insertLocalRule(adapter, {
    id: 'r1',
    user_id: 'b',
    account_id: accountId,
    next_date: '2026-11-01',
    template: TEMPLATE,
    updated_at: SYNCED_AT,
  });
  return mapRecurringRule(
    adapter._sqlite
      .prepare("SELECT * FROM recurring_rules WHERE id = 'r1'")
      .get() as DbRecurringRule
  );
}

/** The five writers, each into `accountId` as b, in the screens' shapes. */
async function writeAllInto(accountId: string, own: string) {
  const ruleCreate = {
    accountId,
    frequency: 'monthly' as const,
    nextDate: '2026-11-01',
    template: TEMPLATE,
  };
  return {
    transaction: await outcomeOf(
      hooks.createTxn.mutateAsync({
        accountId,
        txnDate: '2026-10-21',
        payee: 'Grocer',
        amount: -12.34,
        status: 'pending',
      })
    ),
    transferFrom: await outcomeOf(
      createTransfer(
        adapter,
        {
          userId: 'b',
          fromAccountId: accountId,
          toAccountId: own,
          fromAccountName: 'From',
          toAccountName: 'To',
          amount: 10,
          txnDate: '2026-10-21',
        },
        { now: NOW, newId: nextId }
      )
    ),
    transferTo: await outcomeOf(
      createTransfer(
        adapter,
        {
          userId: 'b',
          fromAccountId: own,
          toAccountId: accountId,
          fromAccountName: 'From',
          toAccountName: 'To',
          amount: 10,
          txnDate: '2026-10-21',
        },
        { now: NOW, newId: nextId }
      )
    ),
    import: await outcomeOf(
      applyTransactionImport(
        adapter,
        {
          userId: 'b',
          accountId,
          rows: [
            {
              date: '2026-10-21',
              rawDate: '2026-10-21',
              payee: 'Shop',
              amount: -5,
            },
          ],
        },
        { now: NOW, newId: nextId }
      )
    ),
    rule: await outcomeOf(hooks.createRule.mutateAsync(ruleCreate)),
    post: await outcomeOf(hooks.post.mutateAsync(await ruleOn(accountId))),
  };
}

beforeEach(async () => {
  mockUserId = 'b';
  seq = 0;
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  quiet = (['log', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
  // u's Checking, and b's two accounts.
  await insertLocalAccount(adapter, {
    id: 'a1',
    user_id: 'u',
    name: 'Checking',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(adapter, {
    id: 'b1',
    user_id: 'b',
    name: 'Wallet',
    updated_at: SYNCED_AT,
  });
  await insertLocalAccount(adapter, {
    id: 'b2',
    user_id: 'b',
    name: 'Savings',
    updated_at: SYNCED_AT,
  });
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: qc }, createElement(Harness))
    );
  });
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  qc.getMutationCache().clear();
  qc.clear();
  quiet.forEach((spy) => spy.mockRestore());
  adapter._sqlite.close();
});

describe("a row is created only under the signed-in user's own account (#177)", () => {
  // Before #177: all six resolved, and b's rows went in under u's a1.
  it("F1: b writing into u's account is refused by every writer as a missing account, and nothing is written", async () => {
    const outcomes = await writeAllInto('a1', 'b1');

    expect(outcomes).toEqual(GONE);
    expect(written()).toEqual({ transactions: [], rules: [] });
    expect(requestPush).not.toHaveBeenCalled();
  });

  // u deleted a1 on this device and the push has not uploaded it yet. Before
  // #177 every writer refused it (a dead account) in the words for an
  // account deleted HERE: true for u, and for b a statement that the account
  // exists on this device for someone else.
  it("F2: the refusal never says another account's account was deleted on this device", async () => {
    await applyAccountDelete(adapter, 'a1', { now: NOW });

    expect(await writeAllInto('a1', 'b1')).toEqual(GONE);
  });

  it("F3 (pin): b's writes into b's own accounts go in, owned by b, under b's account", async () => {
    const outcomes = await writeAllInto('b2', 'b1');

    expect(Object.values(outcomes).filter((o) => o !== 'resolved')).toEqual([]);
    // Into b2: the transaction, a leg of each transfer, the imported row and
    // the posted one; into b1, the transfers' other legs.
    expect(written()).toEqual({
      transactions: ['b:b1', 'b:b1', 'b:b2', 'b:b2', 'b:b2', 'b:b2', 'b:b2'],
      rules: ['b:b2'],
    });
  });
});

describe('an account is edited only by its own user (#177)', () => {
  // Before #177: resolved, and u's Checking became "Renamed by b", pending,
  // its push requested as b -- uploaded at u's next sign-in.
  it("F4: b's edit of u's account (the Edit Account sheet kept open through a change of account) is refused and changes nothing", async () => {
    const outcome = await outcomeOf(
      hooks.updateAccount.mutateAsync({ id: 'a1', name: 'Renamed by b' })
    );

    expect({ outcome, row: accountRow('a1') }).toEqual({
      outcome: 'Error: updateAccount: no local row matched a1',
      row: { user_id: 'u', name: 'Checking', _sync_status: 'synced' },
    });
    expect(requestPush).not.toHaveBeenCalled();
  });

  // u deleted a1 on this device and the push has not uploaded it yet. Before
  // #177 b's edit read the account's status by id alone and said it was
  // deleted on this device: that it exists here, for someone else.
  it("F5: b's edit of an account u deleted here never says it was deleted on this device", async () => {
    await applyAccountDelete(adapter, 'a1', { now: NOW });

    expect(
      await outcomeOf(
        hooks.updateAccount.mutateAsync({ id: 'a1', name: 'Renamed by b' })
      )
    ).toBe('Error: updateAccount: no local row matched a1');
  });

  it("F6 (pin): b's own account takes b's edit", async () => {
    const outcome = await outcomeOf(
      hooks.updateAccount.mutateAsync({ id: 'b1', name: 'Wallet 2' })
    );

    expect({ outcome, row: accountRow('b1') }).toEqual({
      outcome: 'resolved',
      row: { user_id: 'b', name: 'Wallet 2', _sync_status: 'pending' },
    });
    expect(requestPush).toHaveBeenCalledWith('b');
  });
});

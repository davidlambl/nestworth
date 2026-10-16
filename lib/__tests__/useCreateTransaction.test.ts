// useCreateTransaction refuses a transaction for an account this device has
// deleted, or no longer has (#163). Its INSERT never looked at the account:
// after an account delete (applyAccountDelete marks the account, its
// transactions and its rules 'deleted', and the push then removes the row), a
// register re-opened on the account (the browser's Forward, a stale link), or
// on screen when another device deleted it, still offered "+", and the new
// row went in 'pending' under the dead account. The server refuses a NEW
// child of a tombstoned account with 23503 (005's inherit_account_tombstone),
// so the row stayed pending on this device forever: retried on every push,
// shown in no register, and counted by the reset guard. Now the INSERT
// carries the account's status inside the statement and writes nothing for a
// dead account, and the mutation rejects with its own words, which the
// mutation cache renders as "Save failed: …".
//
// Own file, importing only the hook, applyAccountDelete and the fixture, so
// it loads on the code before #163 as well: that is where the regressions
// were proven red. The harness is useUpdateAccount.test.ts's.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({ requestPush: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { applyAccountDelete } from '../accountDelete';
import { useCreateTransaction } from '../hooks/useTransactions';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';

/** When every seeded row last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When the account delete marked its rows. */
const DELETED_AT = '2026-10-15T11:00:00.000Z';

const DELETED_HERE =
  'Error: This account was deleted on this device, so the transaction was not saved.';
const GONE =
  'Error: This account no longer exists on this device, so the transaction was not saved.';

let adapter: ReturnType<typeof makeAdapter>;
let qc: QueryClient;
let renderer: ReactTestRenderer;
let createTxn: ReturnType<typeof useCreateTransaction>;
let invalidate: jest.SpyInstance;

function Harness() {
  const mutation = useCreateTransaction();
  useEffect(() => {
    createTxn = mutation;
  });
  return null;
}

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  (requestPush as unknown as jest.Mock).mockClear();
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  // a1 with one transaction, synced; a2 live and empty.
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(adapter, { id: 'a2', updated_at: SYNCED_AT });
  await insertLocalTxn(adapter, {
    id: 't1',
    account_id: 'a1',
    updated_at: SYNCED_AT,
  });

  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  invalidate = jest.spyOn(qc, 'invalidateQueries');
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
  adapter._sqlite.close();
});

/** `id:account:status@updated_at` for every transaction, by id. */
function txns(): string[] {
  return (
    adapter._sqlite
      .prepare(
        'SELECT id, account_id, _sync_status, updated_at FROM transactions ORDER BY id'
      )
      .all() as {
      id: string;
      account_id: string;
      _sync_status: string;
      updated_at: string;
    }[]
  ).map((r) => `${r.id}:${r.account_id}:${r._sync_status}@${r.updated_at}`);
}

function splits(): string[] {
  return (
    adapter._sqlite
      .prepare('SELECT id, transaction_id FROM transaction_splits ORDER BY id')
      .all() as { id: string; transaction_id: string }[]
  ).map((r) => `${r.id}>${r.transaction_id}`);
}

/** Rejection as a string: never rejects.toThrow() next to better-sqlite3. */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  return 'resolved';
}

type CreateInput = Parameters<typeof createTxn.mutateAsync>[0];

function input(accountId: string, extra: Partial<CreateInput> = {}) {
  return {
    accountId,
    txnDate: '2026-10-15',
    payee: 'Grocer',
    amount: -12.34,
    status: 'pending' as const,
    ...extra,
  };
}

/** Creates a transaction through the hook. */
async function createThrough(i: CreateInput): Promise<string> {
  let outcome = '';
  await act(async () => {
    outcome = await rejectionOf(createTxn.mutateAsync(i));
  });
  return outcome;
}

/** The query keys invalidated so far, in order. */
function invalidated(): unknown[] {
  return invalidate.mock.calls.map((c) => c[0]?.queryKey);
}

describe('useCreateTransaction into an account that is not live here (#163)', () => {
  // Before #163: resolved, and id-1 went in 'pending' under the deleted a1,
  // with a push requested. The push's upsert of a NEW row into a tombstoned
  // account is refused with 23503 (005), so the row never left the device.
  it('C1: refuses an account this device has deleted, writes nothing and requests no push', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });

    const outcome = await createThrough(input('a1'));

    expect({
      outcome,
      txns: txns(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
    }).toEqual({
      outcome: DELETED_HERE,
      txns: [`t1:a1:deleted@${DELETED_AT}`],
      pushes: 0,
    });
  });

  // The register's commonest case online: the delete's push has uploaded the
  // tombstone and removed the account row, so the account is simply missing
  // here (the same as one deleted on another device and pulled).
  it('C2: refuses an account no longer on this device, writes nothing and requests no push', async () => {
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();

    const outcome = await createThrough(input('a1'));

    expect({
      outcome,
      txns: txns(),
      pushes: (requestPush as unknown as jest.Mock).mock.calls.length,
    }).toEqual({
      outcome: GONE,
      txns: [`t1:a1:synced@${SYNCED_AT}`],
      pushes: 0,
    });
  });

  // A splits UI (#26) would pass splits: none may go in under a refused
  // parent. Before #163 the parent and both splits went in.
  it('C3: a refused transaction inserts none of its splits', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });

    const outcome = await createThrough(
      input('a1', {
        splits: [
          { amount: -10, memo: 'food' },
          { amount: -2.34, memo: 'tax' },
        ],
      })
    );

    expect({ outcome, splits: splits() }).toEqual({
      outcome: DELETED_HERE,
      splits: [],
    });
  });

  // The account check is part of the INSERT itself, so nothing can land
  // between them: here an account delete runs to completion right before the
  // INSERT reaches SQLite (an offline Delete and Create resumed together can
  // order them so). A check read before the INSERT, as a separate statement,
  // passes, and the row goes in after the delete has marked a1's rows: a
  // pending row under a deleted account. Before #163, the same.
  it('C4: an account delete that lands just before the INSERT still refuses it', async () => {
    const run = adapter.runAsync;
    let fired = false;
    adapter.runAsync = async (sql: string, params: any[] = []) => {
      if (!fired && /^\s*INSERT INTO transactions/.test(sql)) {
        fired = true;
        await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      }
      return run(sql, params);
    };

    const outcome = await createThrough(input('a1'));
    adapter.runAsync = run;

    expect({ fired, outcome, txns: txns() }).toEqual({
      fired: true,
      outcome: DELETED_HERE,
      txns: [`t1:a1:deleted@${DELETED_AT}`],
    });
  });

  // The create is a plain statement, which the transaction queue does not
  // serialise, so it can also land INSIDE applyAccountDelete's transaction,
  // between its statements (an offline Delete and Create resumed together
  // can interleave so). The account is marked first: before that mark the
  // row goes in and the transactions mark takes it; after it, the guard
  // refuses. Marked last (the order before #163), a create landing after the
  // children's marks found the account live and stayed pending under it.
  it.each([
    ['before', 'UPDATE accounts SET'],
    ['before', 'UPDATE transactions SET'],
    ['before', 'UPDATE recurring_rules SET'],
    ['after', 'UPDATE recurring_rules SET'],
  ] as const)(
    'C10: a create landing %s the delete statement %s leaves nothing pending under the account',
    async (when, prefix) => {
      const run = adapter.runAsync;
      let fired = false;
      let outcome = 'not run';
      const createNow = async () => {
        fired = true;
        outcome = await rejectionOf(createTxn.mutateAsync(input('a1')));
      };
      adapter.runAsync = async (sql: string, params: any[] = []) => {
        const hit = !fired && sql.startsWith(prefix);
        if (hit && when === 'before') await createNow();
        const res = await run(sql, params);
        if (hit && when === 'after') await createNow();
        return res;
      };
      await act(async () => {
        await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
      });
      adapter.runAsync = run;

      expect({
        fired,
        outcome: outcome === 'resolved' ? 'resolved' : outcome,
        pendingUnderA1: txns().filter((t) => /:a1:pending@/.test(t)),
      }).toEqual({
        fired: true,
        outcome: expect.stringMatching(
          /^(resolved|Error: This account was deleted on this device, so the transaction was not saved\.)$/
        ),
        pendingUnderA1: [],
      });
    }
  );

  // A refused create came from a screen whose account is dead: the register
  // that opened it reads ['account', id], and a picker reads ['accounts'].
  // Both refetch, so the register can show the account is gone.
  it('C5: a refused create refetches the account and the accounts list', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });

    await createThrough(input('a1'));

    expect(invalidated()).toEqual(
      expect.arrayContaining([['account', 'a1'], ['accounts']])
    );
  });

  it('C6 (pin): a live account takes the transaction, pending, with one push for the user', async () => {
    const outcome = await createThrough(input('a2', { memo: 'weekly' }));
    const row = adapter._sqlite
      .prepare(
        'SELECT account_id, txn_date, payee, amount, memo, status, _sync_status FROM transactions WHERE id = ?'
      )
      .get('id-1');

    expect({
      outcome,
      row,
      pushes: (requestPush as unknown as jest.Mock).mock.calls,
      refetched: invalidated(),
    }).toEqual({
      outcome: 'resolved',
      row: {
        account_id: 'a2',
        txn_date: '2026-10-15',
        payee: 'Grocer',
        amount: -12.34,
        memo: 'weekly',
        status: 'pending',
        _sync_status: 'pending',
      },
      pushes: [['u']],
      refetched: expect.arrayContaining([
        ['transactions', 'a2'],
        ['transactions', '__all__'],
        ['accounts'],
      ]),
    });
  });

  // `IS NOT 'deleted'`, not `!=` or `= 'synced'`: a NULL status (no writer
  // makes one) is not a delete, and a pending account (created offline, not
  // yet pushed) is live.
  it.each([
    ['NULL', null],
    ['pending', 'pending'],
  ])(
    'C7 (pin): an account whose status is %s takes the transaction',
    async (_label, status) => {
      adapter._sqlite
        .prepare('UPDATE accounts SET _sync_status = ? WHERE id = ?')
        .run(status, 'a2');

      const outcome = await createThrough(input('a2'));

      expect({
        outcome,
        txns: txns().filter((t) => t.startsWith('id-1')),
      }).toEqual({
        outcome: 'resolved',
        txns: [expect.stringMatching(/^id-1:a2:pending@/)],
      });
    }
  );

  // The words follow what is on disk: a row still marked deleted reads as
  // deleted here, a missing one as gone. Two accounts, so the read cannot be
  // the wrong row's.
  it('C8: the words name the case of the account written to, not another', async () => {
    await applyAccountDelete(adapter, 'a1', { now: DELETED_AT });
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a2'").run();

    const intoA2 = await createThrough(input('a2'));
    const intoA1 = await createThrough(input('a1'));

    expect({ intoA2, intoA1 }).toEqual({ intoA2: GONE, intoA1: DELETED_HERE });
  });
  // The account was missing when the INSERT ran and is back by the time the
  // words are read (a reset's re-download restoring it in between). The
  // refusal stands -- nothing was written -- and reads as gone, the state
  // the write met, never as a delete the user did not make.
  it('C9: an account back by the time the words are read still reads as gone', async () => {
    adapter._sqlite.prepare("DELETE FROM accounts WHERE id = 'a1'").run();
    const run = adapter.runAsync;
    adapter.runAsync = async (sql: string, params: any[] = []) => {
      const res = await run(sql, params);
      if (/^\s*INSERT INTO transactions/.test(sql) && res.changes === 0) {
        await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
      }
      return res;
    };

    const outcome = await createThrough(input('a1'));
    adapter.runAsync = run;

    expect({ outcome, txns: txns() }).toEqual({
      outcome: GONE,
      txns: [`t1:a1:synced@${SYNCED_AT}`],
    });
  });
});

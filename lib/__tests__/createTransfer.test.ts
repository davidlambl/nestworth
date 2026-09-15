// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { createTransfer } from '../transferCreate';
import { insertLocalAccount, makeAdapter } from '../testing/syncFixture';

type Row = {
  id: string;
  account_id: string;
  payee: string;
  amount: number;
  memo: string | null;
  status: string;
  transfer_link_id: string | null;
  created_at: string;
  updated_at: string;
  _sync_status: string;
};

const NOW = '2026-09-15T12:00:00.000Z';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(async () => {
  adapter = makeAdapter();
  await insertLocalAccount(adapter, { id: 'acc-checking', name: 'Checking' });
  await insertLocalAccount(adapter, { id: 'acc-savings', name: 'Savings' });
});

afterEach(() => {
  adapter._sqlite.close();
});

function rows(): Row[] {
  return adapter._sqlite
    .prepare('SELECT * FROM transactions ORDER BY amount')
    .all() as Row[];
}

const input = {
  userId: 'u',
  fromAccountId: 'acc-checking',
  toAccountId: 'acc-savings',
  fromAccountName: 'Checking',
  toAccountName: 'Savings',
  amount: 25.5,
  txnDate: '2026-09-15',
};

describe('createTransfer', () => {
  it('writes both legs with a shared link, mirrored amounts and payees', async () => {
    const result = await createTransfer(adapter, input, {
      now: NOW,
      newId: ids(),
    });

    const [from, to] = rows();
    expect(rows()).toHaveLength(2);

    expect(from.account_id).toBe('acc-checking');
    expect(from.amount).toBe(-25.5);
    expect(from.payee).toBe('Transfer to Savings');
    expect(to.account_id).toBe('acc-savings');
    expect(to.amount).toBe(25.5);
    expect(to.payee).toBe('Transfer from Checking');

    for (const leg of [from, to]) {
      expect(leg.transfer_link_id).toBe('id-1');
      expect(leg.memo).toBe('Transfer');
      expect(leg.status).toBe('cleared');
      expect(leg._sync_status).toBe('pending');
      expect(leg.created_at).toBe(NOW);
      expect(leg.updated_at).toBe(NOW);
    }

    expect(result.linkId).toBe('id-1');
    expect(result.from.id).toBe('id-2');
    expect(result.to.id).toBe('id-3');
    expect(result.from.transferLinkId).toBe('id-1');
    expect(result.to.transferLinkId).toBe('id-1');
    expect(result.from.amount).toBe(-25.5);
    expect(result.to.amount).toBe(25.5);
  });

  it('leaves no leg behind when the second insert fails', async () => {
    // Fail only the to-leg. Without the transaction the from-leg would survive
    // as an orphan carrying a transfer_link_id nothing else resolves — the bug
    // in #17.
    let inserts = 0;
    const flaky = {
      ...adapter,
      runAsync: async (sql: string, params: any[] = []) => {
        if (sql.trimStart().startsWith('INSERT INTO transactions')) {
          inserts++;
          if (inserts === 2) {
            throw new Error('simulated failure on the second leg');
          }
        }
        return adapter.runAsync(sql, params);
      },
    };

    await expect(
      createTransfer(flaky, input, { now: NOW, newId: ids() })
    ).rejects.toThrow('simulated failure on the second leg');

    expect(inserts).toBe(2);
    expect(rows()).toHaveLength(0);
  });

  it('refuses a transfer within one account and writes nothing', async () => {
    await expect(
      createTransfer(
        adapter,
        { ...input, toAccountId: 'acc-checking' },
        { now: NOW, newId: ids() }
      )
    ).rejects.toThrow('Source and destination must be different.');
    expect(rows()).toHaveLength(0);
  });

  it('refuses a zero amount and normalises a negative one', async () => {
    await expect(
      createTransfer(
        adapter,
        { ...input, amount: 0 },
        { now: NOW, newId: ids() }
      )
    ).rejects.toThrow('Transfer amount must be positive.');
    expect(rows()).toHaveLength(0);

    await createTransfer(
      adapter,
      { ...input, amount: -10 },
      { now: NOW, newId: ids() }
    );
    const [from, to] = rows();
    expect(from.amount).toBe(-10);
    expect(to.amount).toBe(10);
  });

  it('keeps a custom memo on both legs and defaults a blank one', async () => {
    await createTransfer(
      adapter,
      { ...input, memo: '  Rent share  ' },
      { now: NOW, newId: ids() }
    );
    expect(rows().map((r) => r.memo)).toEqual(['Rent share', 'Rent share']);

    adapter._sqlite.prepare('DELETE FROM transactions').run();
    await createTransfer(
      adapter,
      { ...input, memo: '   ' },
      { now: NOW, newId: ids() }
    );
    expect(rows().map((r) => r.memo)).toEqual(['Transfer', 'Transfer']);
  });
});

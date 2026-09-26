// applyReceiptAttach (#138): a receipt is attached only to a transaction this
// device still has and has not marked deleted. useReceiptPhoto's UPDATE used
// to match nothing for a transaction gone during the upload, and to set a
// deleted one back to 'pending' (#139's receipt half), reporting success both
// times. The hook itself, with the upload, the removal and what the user is
// shown, is driven in useReceiptPhoto.test.ts.
//
// This module is new with #138, so this suite cannot load on the code before
// it. Each regression test was proven red with the part of the statement it
// guards removed: the `changes` check, or the status filter. Without both, the
// statement is the hook's before #138.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import { applyReceiptAttach } from '../receiptAttach';
import { insertLocalTxn, makeAdapter } from '../testing/syncFixture';

/** When every seeded transaction last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When t2 was edited offline, and not pushed since. */
const EDITED_AT = '2026-09-20T09:00:00.000Z';
/** When t1 was deleted here, before the attach landed. */
const DELETED_AT = '2026-09-26T11:00:00.000Z';
/** The attach's timestamp. */
const NOW = '2026-09-26T12:00:00.000Z';

const REFUSAL =
  'Error: The receipt was not attached: this transaction no longer exists on this device, or was deleted here.';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

/** `id:status@updated_at:receipt_path` for every transaction, by id. */
function txns(): string[] {
  return (
    adapter._sqlite
      .prepare(
        'SELECT id, _sync_status, updated_at, receipt_path FROM transactions ORDER BY id'
      )
      .all() as {
      id: string;
      _sync_status: string | null;
      updated_at: string;
      receipt_path: string | null;
    }[]
  ).map((r) => `${r.id}:${r._sync_status}@${r.updated_at}:${r.receipt_path}`);
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

describe('applyReceiptAttach (#138)', () => {
  it('rejects an attach to a transaction this device no longer has, and writes nothing', async () => {
    await insertLocalTxn(adapter, { id: 't2', updated_at: SYNCED_AT });

    const outcome = await rejectionOf(
      applyReceiptAttach(adapter, 't1', 'u/t1.jpg', { now: NOW })
    );

    // With the `changes` check removed: 'resolved'.
    expect(outcome).toBe(REFUSAL);
    expect(txns()).toEqual([`t2:synced@${SYNCED_AT}:null`]);
  });

  it('rejects an attach to a transaction marked deleted here, and leaves it deleted (#139)', async () => {
    await insertLocalTxn(adapter, {
      id: 't1',
      updated_at: DELETED_AT,
      _sync_status: 'deleted',
    });

    const outcome = await rejectionOf(
      applyReceiptAttach(adapter, 't1', 'u/t1.jpg', { now: NOW })
    );

    // With the status filter removed: 'resolved', and t1 'pending' again with
    // the receipt, so the next push would upload a transaction the user had
    // deleted.
    expect(txns()).toEqual([`t1:deleted@${DELETED_AT}:null`]);
    expect(outcome).toBe(REFUSAL);
  });

  it('pin: a synced and a pending transaction each take the receipt, the stamp and pending', async () => {
    await insertLocalTxn(adapter, { id: 't1', updated_at: SYNCED_AT });
    await insertLocalTxn(adapter, {
      id: 't2',
      updated_at: EDITED_AT,
      _sync_status: 'pending',
    });

    await applyReceiptAttach(adapter, 't1', 'u/t1.jpg', { now: NOW });
    await applyReceiptAttach(adapter, 't2', 'u/t2.png', { now: NOW });

    expect(txns()).toEqual([
      `t1:pending@${NOW}:u/t1.jpg`,
      `t2:pending@${NOW}:u/t2.png`,
    ]);
  });

  it('pin: a transaction whose status is NULL takes it too (IS NOT, not !=)', async () => {
    // No writer sets a NULL status; the filter still lets one through, so a
    // refusal means exactly "missing or deleted here".
    await insertLocalTxn(adapter, { id: 't1', updated_at: SYNCED_AT });
    adapter._sqlite
      .prepare("UPDATE transactions SET _sync_status = NULL WHERE id = 't1'")
      .run();

    await applyReceiptAttach(adapter, 't1', 'u/t1.jpg', { now: NOW });

    expect(txns()).toEqual([`t1:pending@${NOW}:u/t1.jpg`]);
  });
});

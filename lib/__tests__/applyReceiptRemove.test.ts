// applyReceiptRemove (#23): the local half of removing a receipt, after
// useRemoveReceipt has removed its photo from Storage. The transaction's
// receipt_path goes to NULL and the row to 'pending', so the push uploads the
// removal like any field edit; only while the row still names the receipt
// that was removed, and never for a row this device has marked deleted, which
// setting back to 'pending' would un-delete (#139). The hook, with the Storage
// request and what the user is shown, is driven in useRemoveReceipt.test.ts;
// the push and the pull in syncReceiptRemove.test.ts.
//
// This module is new with #23, so this suite cannot load on the code before
// it. Each test was proven red under the mutant named in its title.
//
// The fixture module imports the Supabase client and the DB layer at module
// scope; neither is needed here, so both are stubbed as the other suites do.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));

import {
  applyReceiptRemove,
  RECEIPT_ALREADY_GONE_AND_TXN_GONE,
  RECEIPT_REMOVED_BUT_GONE,
} from '../receiptRemove';
import { insertLocalTxn, makeAdapter } from '../testing/syncFixture';

/** When every seeded transaction last synced. */
const SYNCED_AT = '2026-05-10T00:00:00Z';
/** When t1 was deleted here, while the removal was out. */
const DELETED_AT = '2026-10-15T11:00:00.000Z';
/** The removal's timestamp. */
const NOW = '2026-10-15T12:00:00.000Z';
const PATH = 'u/t1.n1.jpg';

let adapter: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  adapter = makeAdapter();
});

afterEach(() => {
  adapter._sqlite.close();
});

/** Seeds a transaction naming `receipt`. */
async function seed(
  id: string,
  receipt: string | null,
  extra: Record<string, unknown> = {}
) {
  await insertLocalTxn(adapter, { id, updated_at: SYNCED_AT, ...extra });
  adapter._sqlite
    .prepare('UPDATE transactions SET receipt_path = ? WHERE id = ?')
    .run(receipt, id);
}

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

/** The outcome as a string: never rejects.toThrow() next to better-sqlite3. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    return `resolved ${String(await p)}`;
  } catch (e) {
    return String(e);
  }
}

describe('applyReceiptRemove (#23)', () => {
  it('clears the receipt, stamps the row and marks it pending, and resolves true (mutants: no pending, no stamp)', async () => {
    await seed('t1', PATH);
    await seed('t2', 'u/t2.n2.png');

    const outcome = await outcomeOf(
      applyReceiptRemove(adapter, 't1', PATH, { now: NOW })
    );

    expect(outcome).toBe('resolved true');
    expect(txns()).toEqual([
      `t1:pending@${NOW}:null`,
      `t2:synced@${SYNCED_AT}:u/t2.n2.png`,
    ]);
  });

  it('refuses a transaction this device has marked deleted, and leaves it deleted (mutant: the status filter dropped)', async () => {
    await seed('t1', PATH, {
      updated_at: DELETED_AT,
      _sync_status: 'deleted',
    });

    const outcome = await outcomeOf(
      applyReceiptRemove(adapter, 't1', PATH, { now: NOW })
    );

    // Without the filter: 'resolved true', and t1 'pending' again, so the
    // next push would upload a transaction the user had deleted.
    expect(txns()).toEqual([`t1:deleted@${DELETED_AT}:${PATH}`]);
    expect(outcome).toBe(`Error: ${RECEIPT_REMOVED_BUT_GONE}`);
  });

  it('refuses a transaction this device no longer has, and writes nothing (mutant: a zero match read as moved on)', async () => {
    await seed('t2', 'u/t2.n2.png');

    const outcome = await outcomeOf(
      applyReceiptRemove(adapter, 't1', PATH, { now: NOW })
    );

    expect(outcome).toBe(`Error: ${RECEIPT_REMOVED_BUT_GONE}`);
    expect(txns()).toEqual([`t2:synced@${SYNCED_AT}:u/t2.n2.png`]);
  });

  it('says the photo was already gone when Storage had none to remove, for a transaction deleted here or no longer here (mutants: the words of a removal that removed one, the two words swapped)', async () => {
    await seed('t1', PATH, {
      updated_at: DELETED_AT,
      _sync_status: 'deleted',
    });

    const deleted = await outcomeOf(
      applyReceiptRemove(adapter, 't1', PATH, {
        now: NOW,
        photoAlreadyGone: true,
      })
    );
    const missing = await outcomeOf(
      applyReceiptRemove(adapter, 't2', 'u/t2.n2.png', {
        now: NOW,
        photoAlreadyGone: true,
      })
    );

    // Storage removed nothing: "The receipt was removed, but…" would say it
    // had.
    expect([deleted, missing]).toEqual([
      `Error: ${RECEIPT_ALREADY_GONE_AND_TXN_GONE}`,
      `Error: ${RECEIPT_ALREADY_GONE_AND_TXN_GONE}`,
    ]);
    expect(txns()).toEqual([`t1:deleted@${DELETED_AT}:${PATH}`]);
  });

  it('leaves a transaction that names another receipt, or none, as it is, and resolves false (mutants: the path condition dropped, a zero match refused)', async () => {
    // Replaced on another device, and pulled here while the removal was out.
    await seed('t1', 'u/t1.n9.png');
    // Removed on another device, and pulled here.
    await seed('t2', null);

    const replaced = await outcomeOf(
      applyReceiptRemove(adapter, 't1', PATH, { now: NOW })
    );
    const gone = await outcomeOf(
      applyReceiptRemove(adapter, 't2', 'u/t2.n2.png', { now: NOW })
    );

    // Without the path condition: t1 cleared, the receipt that replaced the
    // removed one taken off with it, its photo left in the bucket.
    expect(txns()).toEqual([
      `t1:synced@${SYNCED_AT}:u/t1.n9.png`,
      `t2:synced@${SYNCED_AT}:null`,
    ]);
    expect([replaced, gone]).toEqual(['resolved false', 'resolved false']);
  });

  it('pin: a pending transaction takes the removal, and so does one whose status is NULL (IS NOT, not !=)', async () => {
    await seed('t1', PATH, { _sync_status: 'pending' });
    await seed('t2', 'u/t2.n2.png');
    // No writer sets a NULL status; the filter still lets one through, so a
    // refusal means exactly "missing or deleted here".
    adapter._sqlite
      .prepare("UPDATE transactions SET _sync_status = NULL WHERE id = 't2'")
      .run();

    await applyReceiptRemove(adapter, 't1', PATH, { now: NOW });
    await applyReceiptRemove(adapter, 't2', 'u/t2.n2.png', { now: NOW });

    expect(txns()).toEqual([
      `t1:pending@${NOW}:null`,
      `t2:pending@${NOW}:null`,
    ]);
  });
});

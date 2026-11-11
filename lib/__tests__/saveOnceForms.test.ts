// A second tap on Save no longer makes a second transaction: the forms that
// write a new record from a press, pressed twice.
//
// New Transaction's Save was on again for the whole upload of its photo (a
// mutate()-level onSuccess runs once the mutation has settled, and nothing
// awaits it), so a second tap then made a second transaction -- the v2.0.0
// simulator pass's two rows. And on every form, two taps that reach the app
// in one beat both saved: a button turned off on the mutation's isPending
// (TanStack tells React from a setTimeout(0)) or on a state flag of the
// form's own (Transfer, Import) is not yet rendered for the second, because
// React Native dispatches the touches of one beat together, with no render
// between them (EventQueueProcessor::flushEvents). Each form now saves
// through useSaveOnce (lib/saveOnce.ts).
//
// The screens themselves, not a copy of their logic: what went wrong lives
// between the press, the query library's notifications and the button's
// `disabled`, which nothing below the screen holds. Each is rendered
// (react-test-renderer, iOS -- the preset's platform) over the real hooks and
// writers on the fixture's SQLite and the app's own queryClient; navigation,
// the theme, the insets, the photo picker and upload, the header buttons and
// the date picker are stand-ins. A tap presses a button only while it is not
// `disabled`, as TouchableOpacity does; two taps in one `act` are two taps of
// one beat: no render between them. What a device adds -- the beat, the
// touch, the sheet's animation -- is the lead's simulator pass.
//
// Red proofs: every test named RED fails on the forms before this change
// (fix/242-navigation-guard @ e767db1); the PINs pass there too and say what
// they pin.

jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../db', () => ({
  getDb: jest.fn(),
  getSyncMeta: jest.fn(),
  setSyncMeta: jest.fn(),
}));
jest.mock('../auth', () => ({ useAuth: () => ({ user: { id: 'u' } }) }));
jest.mock('../sync', () => ({
  requestPush: jest.fn(),
  fullSync: jest.fn(),
  startSyncSession: jest.fn(),
}));
// The sync indicator's line: the mutation cache's "Save failed: ..." (the
// app's own queryClient, lib/query.tsx) and the import's.
jest.mock('../syncStatus', () => ({
  setLastError: jest.fn(),
  setOnline: jest.fn(),
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: () => () => {},
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams.current,
  useNavigation: () => mockNavigation,
  router: {},
}));
jest.mock('../theme', () => ({
  useTheme: () => ({ fontScale: 1, colorScheme: 'light' }),
}));
jest.mock('../hooks/useScreenInsets', () => ({
  useScreenInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The photo the person attached, and its upload: held open by a test, or
// answered at once. uploadPhoto never throws (useReceiptPhoto): a failure is
// an alert, the sync indicator's line, and null.
jest.mock('../hooks/useReceiptPhoto', () => ({
  useReceiptPhoto: () => ({
    pickPhoto: jest.fn(),
    takePhoto: jest.fn(),
    clearPhoto: jest.fn(),
    uploading: mockUploading.current,
    photo: mockPhoto.current,
    uploadPhoto: (...args: unknown[]) => mockUpload(...args),
  }),
}));
jest.mock('../../components/ReceiptPreview', () => ({
  ReceiptPreview: () => null,
}));
// The Accounts tab's "+" is a header button: the test presses what it was
// given.
jest.mock('../../components/HeaderActions', () => ({
  sheetCancel: () => ({}),
  accountsButtons: (options: { onAdd: () => void }) => {
    mockHeader.onAdd = options.onAdd;
    return {};
  },
}));
jest.mock('../../components/TabStack', () => ({
  useTabHeaderNavigation: () => mockNavigation,
}));
jest.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
}));

import { createElement, type ComponentType } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { getDb } from '../db';
import { setLastError } from '../syncStatus';
import { queryClient } from '../query';
import { applyAccountDelete } from '../accountDelete';
import {
  insertLocalAccount,
  insertLocalTxn,
  makeAdapter,
} from '../testing/syncFixture';
import AccountsScreen from '../../app/(tabs)/(home)/index';
import ImportScreen from '../../app/import';
import NewRecurringScreen from '../../app/recurring/new';
import EditTransactionScreen from '../../app/transaction/[id]';
import NewTransactionScreen from '../../app/transaction/new';
import TransferScreen from '../../app/transaction/transfer';

const mockParams: { current: Record<string, string> } = { current: {} };
// closeScreen's GO_BACK goes to `dispatch`: one per close.
const mockNavigation = {
  setOptions: jest.fn(),
  dispatch: jest.fn(),
  getState: () => ({ key: 'root-stack' }),
};
const mockPhoto: { current: { uri: string; mimeType: string } | null } = {
  current: null,
};
const mockUploading = { current: false };
const mockUpload = jest.fn();
const mockHeader: { onAdd?: () => void } = {};

const SYNCED_AT = '2026-05-10T00:00:00Z';
const DELETED_HERE =
  'This account was deleted on this device, so the transaction was not saved.';

let adapter: ReturnType<typeof makeAdapter>;
let renderer: ReactTestRenderer | null = null;

beforeAll(() => {
  // A mutation's gc timer outlives the cache's clear(): with the app's
  // five-minute default, jest would wait for it after the last test.
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    mutations: { ...defaults.mutations, gcTime: 0 },
  });
});

beforeEach(async () => {
  adapter = makeAdapter();
  (getDb as unknown as jest.Mock).mockResolvedValue(adapter);
  let n = 0;
  (Crypto.randomUUID as unknown as jest.Mock).mockImplementation(
    () => `id-${++n}`
  );
  await insertLocalAccount(adapter, { id: 'a1', updated_at: SYNCED_AT });
  await insertLocalAccount(adapter, {
    id: 'a2',
    name: 'Savings',
    type: 'savings',
    sort_order: 1,
    updated_at: SYNCED_AT,
  });
  mockParams.current = {};
  mockNavigation.dispatch.mockClear();
  mockPhoto.current = null;
  mockUploading.current = false;
  mockUpload.mockReset();
  delete mockHeader.onAdd;
  (setLastError as unknown as jest.Mock).mockClear();
});

afterEach(async () => {
  if (renderer) {
    const shown = renderer;
    await act(async () => shown.unmount());
    renderer = null;
  }
  queryClient.getMutationCache().clear();
  queryClient.clear();
  adapter._sqlite.close();
});

async function open(screen: ComponentType, params: Record<string, string>) {
  mockParams.current = params;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(screen)
      )
    );
  });
  // Its reads answered: the account chips, the row an edit is seeded from.
  await settle();
}

function shown(): ReactTestRenderer {
  if (!renderer) {
    throw new Error('no screen open');
  }
  return renderer;
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}

/** What the screen says, every text joined. */
function screenText(): string {
  return textOf(shown().root);
}

/** The element a person presses or types into, by testID or by its text. */
function control(
  which: { testID: string } | { text: string }
): ReactTestInstance | undefined {
  return shown().root.findAll(
    (node) =>
      (typeof node.props.onPress === 'function' ||
        typeof node.props.onChangeText === 'function') &&
      ('testID' in which
        ? node.props.testID === which.testID
        : textOf(node) === which.text)
  )[0];
}

/** A tap: TouchableOpacity refuses a press while `disabled`. */
function tap(which: { testID: string } | { text: string }) {
  const button = control(which);
  if (!button) {
    throw new Error(`nothing to tap: ${JSON.stringify(which)}`);
  }
  if (!button.props.disabled) {
    button.props.onPress();
  }
}

function type(testID: string, text: string) {
  const field = control({ testID });
  if (!field) {
    throw new Error(`no field ${testID}`);
  }
  act(() => field.props.onChangeText(text));
}

/** Whether the button shows its spinner (its label is gone) and is off. */
function busy(testID: string): { disabled: boolean; spinner: boolean } {
  const button = control({ testID })!;
  return {
    disabled: !!button.props.disabled,
    spinner: textOf(button) === '',
  };
}

/** Lets the saves' promises, TanStack's setTimeout(0) and React's renders run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function query<T>(sql: string): T[] {
  return adapter._sqlite.prepare(sql).all() as T[];
}

function transactions(): string[] {
  return query<{
    id: string;
    account_id: string;
    payee: string;
    amount: number;
  }>('SELECT id, account_id, payee, amount FROM transactions ORDER BY id').map(
    (r) => `${r.id}:${r.account_id}:${r.payee}:${r.amount}`
  );
}

function closes(): number {
  return mockNavigation.dispatch.mock.calls.length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('New Transaction', () => {
  async function fillIn() {
    await open(NewTransactionScreen, { accountId: 'a1' });
    type('new-txn-payee', 'Corner Shop');
    type('new-txn-amount', '1234');
  }

  it('RED: a second tap while the photo uploads saves nothing more -- one transaction, with its photo, and Save shows its spinner until the sheet has closed', async () => {
    // Before: Save on again for the upload (disabled false, its label back),
    // a second transaction id-2, its own upload, and two closes.
    mockPhoto.current = { uri: 'file:///receipt.jpg', mimeType: 'image/jpeg' };
    const upload = deferred<string | null>();
    mockUpload.mockReturnValue(upload.promise);
    await fillIn();

    act(() => tap({ testID: 'new-txn-save' }));
    await settle();
    const whileUploading = {
      rows: transactions(),
      save: busy('new-txn-save'),
      closes: closes(),
    };
    act(() => tap({ testID: 'new-txn-save' }));
    await settle();
    upload.resolve('u/id-1/receipt.jpg');
    await settle();
    const afterClose = busy('new-txn-save');
    // The sheet is going away; a tap that still reached Save saves nothing.
    act(() => tap({ testID: 'new-txn-save' }));
    await settle();

    expect({
      whileUploading,
      afterClose,
      rows: transactions(),
      uploads: mockUpload.mock.calls.map(([, txnId]) => txnId),
      closes: closes(),
    }).toStrictEqual({
      whileUploading: {
        rows: ['id-1:a1:Corner Shop:-12.34'],
        save: { disabled: true, spinner: true },
        closes: 0,
      },
      afterClose: { disabled: true, spinner: true },
      rows: ['id-1:a1:Corner Shop:-12.34'],
      uploads: ['id-1'],
      closes: 1,
    });
  });

  it('RED: two taps in one beat save one transaction', async () => {
    // Before: id-1 and id-2, one close (TanStack keeps only the second
    // mutate()'s callbacks).
    await fillIn();

    act(() => {
      tap({ testID: 'new-txn-save' });
      tap({ testID: 'new-txn-save' });
    });
    await settle();

    expect({ rows: transactions(), closes: closes() }).toStrictEqual({
      rows: ['id-1:a1:Corner Shop:-12.34'],
      closes: 1,
    });
  });

  it('a refused save says why, and Save answers again: corrected, it saves once (PIN)', async () => {
    // Kills a save that keeps the latch after a validation.
    await open(NewTransactionScreen, { accountId: 'a1' });
    type('new-txn-payee', 'Corner Shop');

    act(() => tap({ testID: 'new-txn-save' }));
    await settle();
    const refused = {
      said: screenText().includes('Please enter a valid amount.'),
      save: busy('new-txn-save'),
      rows: transactions(),
    };
    type('new-txn-amount', '1234');
    act(() => tap({ testID: 'new-txn-save' }));
    await settle();

    expect({ refused, rows: transactions(), closes: closes() }).toStrictEqual({
      refused: {
        said: true,
        save: { disabled: false, spinner: false },
        rows: [],
      },
      rows: ['id-1:a1:Corner Shop:-12.34'],
      closes: 1,
    });
  });

  it("a write the database refuses (#163) is said on the form and once by the cache's Save failed line, and Save answers again (PIN)", async () => {
    // Kills a refusal that keeps the latch, and one the form does not say.
    await applyAccountDelete(adapter, 'a1', {
      now: '2026-10-15T11:00:00.000Z',
    });
    await fillIn();

    act(() => tap({ testID: 'new-txn-save' }));
    await settle();
    const first = {
      said: screenText().includes(DELETED_HERE),
      saveFailed: (setLastError as unknown as jest.Mock).mock.calls.slice(),
      save: busy('new-txn-save'),
    };
    act(() => tap({ testID: 'new-txn-save' }));
    await settle();

    expect({
      first,
      tries: (setLastError as unknown as jest.Mock).mock.calls.length,
      rows: transactions(),
      closes: closes(),
    }).toStrictEqual({
      first: {
        said: true,
        saveFailed: [[`Save failed: ${DELETED_HERE}`]],
        save: { disabled: false, spinner: false },
      },
      tries: 2,
      rows: [],
      closes: 0,
    });
  });

  it('a photo that fails to upload leaves the transaction saved, and the sheet closes (PIN)', async () => {
    // uploadPhoto says the failure itself and answers null.
    mockPhoto.current = { uri: 'file:///receipt.jpg', mimeType: 'image/jpeg' };
    mockUpload.mockResolvedValue(null);
    await fillIn();

    act(() => tap({ testID: 'new-txn-save' }));
    await settle();

    expect({ rows: transactions(), closes: closes() }).toStrictEqual({
      rows: ['id-1:a1:Corner Shop:-12.34'],
      closes: 1,
    });
  });
});

describe('New Account (the Accounts tab keeps its sheet mounted)', () => {
  function accounts(): string[] {
    return query<{ id: string; name: string }>(
      'SELECT id, name FROM accounts ORDER BY id'
    ).map((r) => `${r.id}:${r.name}`);
  }

  async function openSheet() {
    act(() => mockHeader.onAdd!());
  }

  it('RED: two taps on Create in one beat create one account', async () => {
    // Before: id-1 and id-2, both "Groceries".
    await open(AccountsScreen, {});
    await openSheet();
    type('accounts-new-name', 'Groceries');

    act(() => {
      tap({ testID: 'accounts-create-btn' });
      tap({ testID: 'accounts-create-btn' });
    });
    await settle();

    expect(accounts()).toStrictEqual([
      'a1:Checking',
      'a2:Savings',
      'id-1:Groceries',
    ]);
  });

  it('the sheet opened again by + creates the next account (PIN)', async () => {
    // Kills a latch kept past the sheet's next opening: the e2e specs and
    // flows create two accounts in a row.
    await open(AccountsScreen, {});
    await openSheet();
    type('accounts-new-name', 'Groceries');
    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();
    const hidden = control({ testID: 'accounts-create-btn' }) === undefined;

    await openSheet();
    type('accounts-new-name', 'Rent');
    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();

    expect({ hidden, accounts: accounts() }).toStrictEqual({
      hidden: true,
      accounts: ['a1:Checking', 'a2:Savings', 'id-1:Groceries', 'id-2:Rent'],
    });
  });

  it('a create that finishes while the icon picker is open leaves Create answering when the picker brings the sheet back (PIN)', async () => {
    // Kills the picker's way back without reopenCreate, and a Create that is
    // not off while its create runs. The create is held at its database
    // read while the person goes to the picker.
    await open(AccountsScreen, {});
    await openSheet();
    type('accounts-new-name', 'Groceries');
    const db = deferred<typeof adapter>();
    (getDb as unknown as jest.Mock).mockReturnValueOnce(db.promise);

    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();
    const whileCreating = busy('accounts-create-btn');
    act(() => tap({ testID: 'accounts-new-icon-picker' }));
    db.resolve(adapter);
    await settle();
    act(() => tap({ testID: 'accounts-icon-💰' }));
    type('accounts-new-name', 'Rent');
    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();

    expect({ whileCreating, accounts: accounts() }).toStrictEqual({
      whileCreating: { disabled: true, spinner: true },
      accounts: ['a1:Checking', 'a2:Savings', 'id-1:Groceries', 'id-2:Rent'],
    });
  });

  it("a create the database refuses is said once by the cache's Save failed line, and Create answers again (PIN)", async () => {
    // Kills a refusal that keeps the latch.
    await open(AccountsScreen, {});
    await openSheet();
    type('accounts-new-name', 'Groceries');
    (getDb as unknown as jest.Mock).mockRejectedValueOnce(
      new Error('database is locked')
    );

    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();
    const refused = {
      saveFailed: (setLastError as unknown as jest.Mock).mock.calls.slice(),
      create: busy('accounts-create-btn'),
    };
    act(() => tap({ testID: 'accounts-create-btn' }));
    await settle();

    expect({ refused, accounts: accounts() }).toStrictEqual({
      refused: {
        saveFailed: [['Save failed: database is locked']],
        create: { disabled: false, spinner: false },
      },
      accounts: ['a1:Checking', 'a2:Savings', 'id-1:Groceries'],
    });
  });
});

describe('New Recurring Rule', () => {
  function rules(): string[] {
    return query<{ id: string; account_id: string; template: string }>(
      'SELECT id, account_id, template FROM recurring_rules ORDER BY id'
    ).map((r) => `${r.id}:${r.account_id}:${JSON.parse(r.template).payee}`);
  }

  async function fillIn() {
    await open(NewRecurringScreen, {});
    act(() => tap({ text: 'Checking' }));
    type('recurring-payee', 'Rent');
    type('recurring-amount', '1500');
  }

  it('RED: two taps in one beat create one rule, Create Rule off while it is created', async () => {
    // Before: id-1 and id-2. The create is held at its database read.
    await fillIn();
    const db = deferred<typeof adapter>();
    (getDb as unknown as jest.Mock).mockReturnValueOnce(db.promise);

    act(() => {
      tap({ testID: 'recurring-save' });
      tap({ testID: 'recurring-save' });
    });
    await settle();
    const whileCreating = busy('recurring-save');
    db.resolve(adapter);
    await settle();
    // The screen is going away; a tap that still reached it creates nothing.
    act(() => tap({ testID: 'recurring-save' }));
    await settle();

    expect({
      whileCreating,
      rules: rules(),
      closes: closes(),
    }).toStrictEqual({
      whileCreating: { disabled: true, spinner: true },
      rules: ['id-1:a1:Rent'],
      closes: 1,
    });
  });

  it('a create the database refuses (#163) is said on the form, and Create Rule answers again (PIN)', async () => {
    await fillIn();
    await applyAccountDelete(adapter, 'a1', {
      now: '2026-10-15T11:00:00.000Z',
    });

    act(() => tap({ testID: 'recurring-save' }));
    await settle();
    const said = screenText().includes(
      'This account was deleted on this device, so the rule was not created.'
    );
    act(() => tap({ testID: 'recurring-save' }));
    await settle();

    expect({
      said,
      tries: (setLastError as unknown as jest.Mock).mock.calls.length,
      rules: rules(),
      closes: closes(),
    }).toStrictEqual({ said: true, tries: 2, rules: [], closes: 0 });
  });
});

describe('Transfer', () => {
  async function fillIn() {
    await open(TransferScreen, { fromAccountId: 'a1' });
    act(() => tap({ testID: 'transfer-to-picker' }));
    act(() => tap({ testID: 'picker-savings' }));
    type('transfer-amount', '5000');
  }

  it('RED: two taps in one beat make one transfer', async () => {
    // Before: two transfers, four rows -- its `loading` was set by the first
    // tap and not yet rendered for the second.
    await fillIn();

    act(() => {
      tap({ testID: 'transfer-save' });
      tap({ testID: 'transfer-save' });
    });
    await settle();
    // The screen is going away; a tap that still reached it moves nothing.
    act(() => tap({ testID: 'transfer-save' }));
    await settle();

    expect({ rows: transactions().length, closes: closes() }).toStrictEqual({
      rows: 2,
      closes: 1,
    });
  });

  it('two taps in separate beats made one transfer before as well: the flag was rendered between them (PIN)', async () => {
    await fillIn();

    act(() => tap({ testID: 'transfer-save' }));
    act(() => tap({ testID: 'transfer-save' }));
    await settle();

    expect({ rows: transactions().length, closes: closes() }).toStrictEqual({
      rows: 2,
      closes: 1,
    });
  });

  it('a refused transfer is said on the form, and Transfer answers again (PIN)', async () => {
    await fillIn();
    await applyAccountDelete(adapter, 'a2', {
      now: '2026-10-15T11:00:00.000Z',
    });

    act(() => tap({ testID: 'transfer-save' }));
    await settle();
    const said = screenText().includes('Transfer failed: ');
    act(() => tap({ testID: 'transfer-save' }));
    await settle();

    expect({
      said,
      tries: (setLastError as unknown as jest.Mock).mock.calls.length,
      closes: closes(),
    }).toStrictEqual({ said: true, tries: 2, closes: 0 });
  });
});

describe('CSV import', () => {
  const CSV =
    'Date,Title,Note,Amount\n11/01/2026,"Corner Shop",,-5.50\n11/02/2026,"Paycheck",,100.00';

  it('RED: two taps on Import in one beat import once, and the screen says what was imported', async () => {
    // Before: a second run, which found the first one's rows and skipped
    // them, and the screen then said "0 transactions imported successfully.
    // 2 duplicates skipped."
    await open(ImportScreen, {});
    type('import-csv-input', CSV);
    act(() => tap({ text: 'Checking' }));
    act(() => tap({ testID: 'import-preview-btn' }));
    const importButton = { text: 'Import 2 Transactions' };

    act(() => {
      tap(importButton);
      tap(importButton);
    });
    await settle();

    expect({
      rows: transactions().length,
      imported: screenText().includes('2 transactions imported successfully.'),
      duplicates: screenText().includes('duplicate'),
    }).toStrictEqual({ rows: 2, imported: true, duplicates: false });
  });

  it('a refused import is said on the form, and Import answers again (PIN)', async () => {
    // Kills a refusal that keeps the latch. The import's own line on the
    // sync indicator counts the tries.
    await open(ImportScreen, {});
    type('import-csv-input', CSV);
    act(() => tap({ text: 'Checking' }));
    act(() => tap({ testID: 'import-preview-btn' }));
    await applyAccountDelete(adapter, 'a1', {
      now: '2026-10-15T11:00:00.000Z',
    });
    const importButton = { text: 'Import 2 Transactions' };

    act(() => tap(importButton));
    await settle();
    const said = screenText().includes('Import failed: ');
    act(() => tap(importButton));
    await settle();

    expect({
      said,
      tries: (setLastError as unknown as jest.Mock).mock.calls.length,
      rows: transactions().length,
    }).toStrictEqual({ said: true, tries: 2, rows: 0 });
  });
});

describe('Edit Transaction, unchanged (measured)', () => {
  it('two taps on Save in one beat write the same values twice, upload the photo once and close once (PIN)', async () => {
    // Why Edit is not changed: TanStack keeps only the second mutate()'s
    // callbacks, so one upload runs, and from the first render on Save is
    // off on `updateTxn.isPending || uploading` until the close. If a
    // library update makes this upload twice, Edit needs the latch too.
    await insertLocalTxn(adapter, {
      id: 't1',
      account_id: 'a1',
      payee: 'Corner Shop',
      amount: -12.34,
      updated_at: SYNCED_AT,
    });
    mockPhoto.current = { uri: 'file:///receipt.jpg', mimeType: 'image/jpeg' };
    mockUpload.mockResolvedValue('u/t1/receipt.jpg');
    await open(EditTransactionScreen, { id: 't1', accountId: 'a1' });
    await settle();

    act(() => {
      tap({ testID: 'edit-txn-save' });
      tap({ testID: 'edit-txn-save' });
    });
    await settle();

    expect({
      rows: transactions(),
      uploads: mockUpload.mock.calls.map(([, txnId]) => txnId),
      closes: closes(),
    }).toStrictEqual({
      rows: ['t1:a1:Corner Shop:-12.34'],
      uploads: ['t1'],
      closes: 1,
    });
  });
});

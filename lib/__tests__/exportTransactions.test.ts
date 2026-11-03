// lib/exportTransactions.ts writes the CSV to a cache file and opens the share
// sheet on it (iOS). Since SDK 58, expo-file-system's File.write is
// asynchronous ("File.write() is now asynchronous and returns a Promise"), so
// the share must wait for the write: a share opened first hands the share
// sheet an empty or partial file (#51). The write below finishes only when the
// test says so, as a slow disk would.
import { exportTransactionsToCsv } from '../exportTransactions';
import { getDb } from '../db';
import * as Sharing from 'expo-sharing';

jest.mock('../db', () => ({ getDb: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

const mockEvents: string[] = [];
let mockFinishWrite: () => void = () => undefined;
const mockWrite = jest.fn(
  (_content: string) =>
    new Promise<void>((resolve) => {
      mockFinishWrite = () => {
        mockEvents.push('written');
        resolve();
      };
    })
);
jest.mock('expo-file-system', () => ({
  Paths: {
    cache: {
      createFile: jest.fn(() => ({
        uri: 'file:///cache/t.csv',
        write: mockWrite,
      })),
    },
  },
}));

beforeEach(() => {
  mockEvents.length = 0;
  mockWrite.mockClear();
  (Sharing.shareAsync as jest.Mock).mockImplementation(async () => {
    mockEvents.push('shared');
  });
  (getDb as jest.Mock).mockResolvedValue({
    getAllAsync: jest.fn(async (sql: string) =>
      sql.includes('FROM transactions')
        ? [
            {
              txn_date: '2026-10-01',
              account_id: 'a1',
              payee: 'Rent',
              amount: -120000,
              check_number: null,
              memo: null,
              status: 'cleared',
            },
          ]
        : [{ id: 'a1', name: 'Checking' }]
    ),
  });
});

it('shares the CSV only once its write has finished (#51)', async () => {
  const done = exportTransactionsToCsv('u1');
  // Long enough for every await before the share to settle.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(mockWrite).toHaveBeenCalledWith(
    'Date,Account,Payee,Amount,Check #,Memo,Status\n' +
      '2026-10-01,"Checking","Rent",-120000,"","",cleared'
  );
  expect(Sharing.shareAsync).not.toHaveBeenCalled();

  mockFinishWrite();
  await done;
  expect(mockEvents).toEqual(['written', 'shared']);
  expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/t.csv', {
    mimeType: 'text/csv',
    dialogTitle: 'Export transactions',
  });
});

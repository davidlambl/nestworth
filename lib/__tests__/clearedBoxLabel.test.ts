// The register's cleared box is a checkbox (#38). Where a screen reader
// reaches it on its own and reads its checked state with it (web, Electron,
// Android), its label is what checking it means; on iOS, where the row's label
// is its children's labels joined without their checked state, it is the
// row's state.
//
// react-native is mocked down to `Platform`, a plain object so each test can
// set `OS`, as in formError.test.ts.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { clearedBoxLabel } from '../clearedBoxLabel';
import type { TransactionStatus } from '../types';

// The mocked module object itself, the one lib/clearedBoxLabel.ts reads at
// each call.
const rn = jest.requireMock('react-native') as { Platform: { OS: string } };

const STATUSES: TransactionStatus[] = ['pending', 'cleared', 'reconciled'];

describe("the register's cleared box label (#38)", () => {
  it.each(['web', 'android'])(
    'on %s it is "Cleared" in both states, so a pending row does not read "Pending, not checked"',
    (os) => {
      rn.Platform.OS = os;
      expect(STATUSES.map((s) => clearedBoxLabel(s))).toStrictEqual([
        'Cleared',
        'Cleared',
        'Cleared',
      ]);
    }
  );

  it("on iOS it is the row's state, which the row's label starts with", () => {
    // PIN: a fixed "Cleared" would start every pending row's label with it.
    rn.Platform.OS = 'ios';
    expect(STATUSES.map((s) => clearedBoxLabel(s))).toStrictEqual([
      'Pending',
      'Cleared',
      'Cleared',
    ]);
  });
});

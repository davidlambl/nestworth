import { isExcludedFromTotals, netBalance } from '../accountTotals';

type Acct = {
  name: string;
  isArchived: boolean;
  excludeFromTotal: boolean;
  currentBalance: number;
};

const activeIncluded: Acct = {
  name: 'Checking',
  isArchived: false,
  excludeFromTotal: false,
  currentBalance: 100.1,
};
const activeExcluded: Acct = {
  name: 'Brokerage',
  isArchived: false,
  excludeFromTotal: true,
  currentBalance: 2000.2,
};
const archivedIncluded: Acct = {
  name: 'PayPal Checking',
  isArchived: true,
  excludeFromTotal: false,
  currentBalance: 30000.3,
};
const archivedExcluded: Acct = {
  name: 'PayPal Savings',
  isArchived: true,
  excludeFromTotal: true,
  currentBalance: 400000.4,
};

describe('isExcludedFromTotals (#146)', () => {
  // T1 — the regression test: the reported card, archived with its own switch
  // still on. The label on main read the switch alone; replacing the body of
  // isExcludedFromTotals with that condition (`account.excludeFromTotal`)
  // fails here.
  it('excludes an archived account whose own switch is on', () => {
    expect(isExcludedFromTotals(archivedIncluded)).toBe(true);
  });

  // T2 — pins: the switch keeps its meaning.
  it('excludes an archived account whose switch is off', () => {
    expect(isExcludedFromTotals(archivedExcluded)).toBe(true);
  });

  it('excludes an active account only when its switch is off', () => {
    expect(isExcludedFromTotals(activeExcluded)).toBe(true);
    expect(isExcludedFromTotals(activeIncluded)).toBe(false);
  });
});

describe('netBalance (#146)', () => {
  const all = [
    activeIncluded,
    activeExcluded,
    archivedIncluded,
    archivedExcluded,
  ];

  // T3 — pin: the total the Accounts tab and the sidebar showed on main.
  it('sums only the active accounts whose switch is on', () => {
    expect(netBalance(all)).toBe(100.1);
    expect(
      netBalance([activeIncluded, { ...activeIncluded, currentBalance: -0.1 }])
    ).toBe(100);
  });

  // T4 — pin: equals main's two-step filter (index.tsx:174-181,
  // AccountsPanel.tsx:36-42) over every mix of the four kinds, in order.
  it("equals main's archived-then-switch filter for every mix", () => {
    const kinds = [
      activeIncluded,
      activeExcluded,
      archivedIncluded,
      archivedExcluded,
    ];
    for (let mask = 0; mask < 16; mask++) {
      const accounts = kinds.filter((_, i) => mask & (1 << i));
      const main = accounts
        .filter((a) => !a.isArchived)
        .filter((a) => !a.excludeFromTotal)
        .reduce((s, a) => s + a.currentBalance, 0);
      expect(netBalance(accounts)).toBe(main);
    }
  });

  // T5 — pin: the tab renders before the accounts query resolves.
  it('is 0 before the accounts load and for none', () => {
    expect(netBalance(undefined)).toBe(0);
    expect(netBalance([])).toBe(0);
  });

  // T6 — the label and the total cannot disagree: an account shows as
  // excluded exactly when leaving it out changes nothing in the total. Main's
  // two separate rules fail it on PayPal Checking.
  it('leaves out exactly the accounts the predicate marks excluded', () => {
    for (const a of all) {
      const without = all.filter((b) => b !== a);
      expect(netBalance(without) === netBalance(all)).toBe(
        isExcludedFromTotals(a)
      );
    }
  });

  // T7 -- pin: the same accounts in the same order as main, so the float sum is
  // bit-identical too. T4's fixture has one includable kind, so it cannot see
  // the order: 0.1 + 0.2 + 0.3 is 0.6000000000000001 in this order, but 0.6
  // summed in reverse or largest first, or with each step rounded to cents.
  it("sums in the accounts' own order, as main did", () => {
    const tenth = { ...activeIncluded, currentBalance: 0.1 };
    const fifth = { ...activeIncluded, currentBalance: 0.2 };
    const third = { ...activeIncluded, currentBalance: 0.3 };
    const mix = [tenth, archivedIncluded, fifth, activeExcluded, third];
    const main = mix
      .filter((a) => !a.isArchived)
      .filter((a) => !a.excludeFromTotal)
      .reduce((s, a) => s + a.currentBalance, 0);
    expect(main).toBe(0.6000000000000001);
    expect(netBalance(mix)).toBe(main);
  });
});

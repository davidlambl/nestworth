import { parseCSV, parseImportAmount } from '../csvImport';
import { parseAmount } from '../format';

describe('parseCSV', () => {
  it('parses a standard CSV with Date/Title/Amount headers', () => {
    const csv = `Date,Title,Category,Note,Amount
04/02/2026,"Coffee Shop",Food,Morning,-5.50
04/03/2026,Paycheck,Income,,2500.00`;

    const result = parseCSV(csv).rows;
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      date: '2026-04-02',
      payee: 'Coffee Shop',
      category: 'Food',
      memo: 'Morning',
      amount: -5.5,
      selected: true,
    });
    expect(result[1]).toMatchObject({
      date: '2026-04-03',
      payee: 'Paycheck',
      amount: 2500,
    });
  });

  it('handles various header name synonyms', () => {
    const csv = `Transaction Date,Payee,Total
2026-01-15,Grocery Store,-42.33`;

    const result = parseCSV(csv).rows;
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-01-15');
    expect(result[0].payee).toBe('Grocery Store');
    expect(result[0].amount).toBe(-42.33);
  });

  it('detects Description/Value headers', () => {
    const csv = `Date,Description,Value
01/15/2026,Electric Bill,-120.99`;

    const result = parseCSV(csv).rows;
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Electric Bill');
    expect(result[0].amount).toBe(-120.99);
  });

  it('handles quoted fields containing commas', () => {
    const csv = `Date,Title,Amount
04/01/2026,"Smith, John",100.00`;

    const result = parseCSV(csv).rows;
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Smith, John');
  });

  it('handles escaped double quotes in quoted fields', () => {
    const csv = `Date,Title,Amount
04/01/2026,"The ""Best"" Store",50.00`;

    const result = parseCSV(csv).rows;
    expect(result[0].payee).toBe('The "Best" Store');
  });

  it('normalizes MM/DD/YYYY dates to YYYY-MM-DD', () => {
    const csv = `Date,Title,Amount
4/2/2026,Test,10`;

    const result = parseCSV(csv).rows;
    expect(result[0].date).toBe('2026-04-02');
  });

  it('preserves YYYY-MM-DD dates as-is', () => {
    const csv = `Date,Title,Amount
2026-04-02,Test,10`;

    const result = parseCSV(csv).rows;
    expect(result[0].date).toBe('2026-04-02');
  });

  // The old strip removed the $; parseAmount reads it (#165).
  it('reads an amount written with a dollar sign', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,$1234.56`;

    const result = parseCSV(csv).rows;
    expect(result[0].amount).toBe(1234.56);
  });

  it('returns no rows for empty input', () => {
    expect(parseCSV('')).toEqual({ rows: [], refused: [] });
  });

  it('returns no rows for header-only input', () => {
    expect(parseCSV('Date,Title,Amount')).toEqual({ rows: [], refused: [] });
  });

  it('skips rows with too few fields', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,100
X`;

    const { rows, refused } = parseCSV(csv);
    expect(rows).toHaveLength(1);
    // A one-field line is not a transaction line: skipped, not listed (#165).
    expect(refused).toEqual([]);
  });

  // A spreadsheet's empty rows export as ",,,,": skipped like a blank line,
  // as before, and never listed as lines that cannot be imported (#165).
  it('skips a line whose every field is blank', () => {
    const csv = `Date,Title,Category,Note,Amount
04/01/2026,Test,,,100
,,,,
" ",,,,""`;

    const { rows, refused } = parseCSV(csv);
    expect(rows.map((r) => r.payee)).toEqual(['Test']);
    expect(refused).toEqual([]);
  });

  // #165: the line is still not imported, but no longer dropped without a
  // word -- the preview lists it with the reason.
  it('refuses a row whose amount is not a number, with its line and the reason', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,not-a-number
04/02/2026,Valid,50`;

    const { rows, refused } = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].payee).toBe('Valid');
    expect(refused).toEqual([
      { line: 2, payee: 'Test', reason: '"not-a-number" is not an amount.' },
    ]);
  });

  it('handles \\r\\n line endings', () => {
    const csv = 'Date,Title,Amount\r\n04/01/2026,Test,100\r\n';
    const result = parseCSV(csv).rows;
    expect(result).toHaveLength(1);
  });

  it('sets category and memo to empty string when columns are absent', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,100`;

    const result = parseCSV(csv).rows;
    expect(result[0].category).toBe('');
    expect(result[0].memo).toBe('');
  });

  it('handles Memo/Note header synonyms', () => {
    const csv = `Date,Title,Note,Amount
04/01/2026,Test,Remember this,100`;

    const result = parseCSV(csv).rows;
    expect(result[0].memo).toBe('Remember this');
  });
});

describe('parseCSV amounts (#165)', () => {
  const csvWith = (amount: string) =>
    `Date,Title,Amount\n04/01/2026,Test,${amount}`;

  // I1 -- the sign flip: the old strip dropped the parentheses and read +5.
  it('reads an accounting negative as a negative amount', () => {
    const csv = `Date,Title,Amount
04/01/2026,Refund,(5.00)
04/02/2026,Fee,($5.00)
04/03/2026,Rent,"($1,234.56)"`;

    expect(parseCSV(csv).rows.map((r) => r.amount)).toEqual([-5, -5, -1234.56]);
  });

  // I2 -- what the old strip read as some other number, refused instead.
  it.each([
    ['−5', 'a Unicode minus sign (read as 5)'],
    ['"1.234,56"', 'a comma as the decimal separator (read as 1.23456)'],
    ['"12,34"', 'a comma decimal (read as 1234)'],
    ['1e5', 'an exponent (read as 15)'],
    ['0x10', 'hexadecimal (read as 10)'],
    ['5-', 'a trailing minus (read as 5)'],
    ['1.005', 'more than two decimal places (read as 1.005)'],
    ['$123.4567', 'a digit past the cents other than 0 (read as 123.4567)'],
    ['1.0050', 'a digit past the cents other than 0, then a 0 (read as 1.005)'],
    ['5.00 CR', 'a credit marker (read as 5)'],
    ['$(5.00)', 'a dollar sign outside the parentheses (read as 5)'],
    ['(-5.00)', 'a minus inside the parentheses (read as -5)'],
    ['99999999999999', 'more than numeric(12,2) holds (pending forever)'],
  ])('refuses %s (%s)', (amount) => {
    const raw = amount.replace(/^"|"$/g, '');
    expect(parseCSV(csvWith(amount))).toEqual({
      rows: [],
      refused: [
        { line: 2, payee: 'Test', reason: `"${raw}" is not an amount.` },
      ],
    });
  });

  // I3 -- an empty amount was skipped without a word; a line shorter than the
  // amount column was imported as $0.00.
  it('refuses a line with no amount, empty, blank or missing', () => {
    const csv = `Date,Title,Amount
04/01/2026,Empty,
04/02/2026,Truncated
04/03/2026,Blank,"   "`;

    expect(parseCSV(csv)).toEqual({
      rows: [],
      refused: [
        { line: 2, payee: 'Empty', reason: 'There is no amount.' },
        { line: 3, payee: 'Truncated', reason: 'There is no amount.' },
        { line: 4, payee: 'Blank', reason: 'There is no amount.' },
      ],
    });
  });

  // I4 -- with no Amount/Total/Value/Sum header, the first column is read as
  // the amount: the old strip turned the date 2026-01-15 into $2,026.00 and
  // 04/02/2026 into $4,022,026.00.
  it('refuses the dates a header without an amount column hands it', () => {
    const csv = `Date,Title,Debit
2026-01-15,Coffee,5.00
04/02/2026,Lunch,12.00`;

    expect(parseCSV(csv)).toEqual({
      rows: [],
      refused: [
        { line: 2, payee: 'Coffee', reason: '"2026-01-15" is not an amount.' },
        { line: 3, payee: 'Lunch', reason: '"04/02/2026" is not an amount.' },
      ],
    });
  });

  // I5 -- the line the person sees in their editor or spreadsheet.
  it('numbers a refused line as the pasted text does, counting blank lines', () => {
    const csv =
      'Date,Title,Amount\r\n\r\n04/01/2026,First,1.00\r\n\r\n\r\n04/02/2026,Bad,"12,34"\r\n';

    const { rows, refused } = parseCSV(csv);
    expect(rows.map((r) => r.payee)).toEqual(['First']);
    expect(refused).toEqual([
      { line: 6, payee: 'Bad', reason: '"12,34" is not an amount.' },
    ]);
  });

  // I6 -- a refused line costs only itself: the rest still import, in order.
  it('keeps the rows around a refused line, in file order', () => {
    const csv = `Date,Title,Amount
04/01/2026,One,-1.00
04/02/2026,Two,(2.00
04/03/2026,Three,3.00`;

    const { rows, refused } = parseCSV(csv);
    expect(rows.map((r) => [r.payee, r.amount])).toEqual([
      ['One', -1],
      ['Three', 3],
    ]);
    expect(refused.map((r) => r.line)).toEqual([3]);
  });

  // I7 -- pin: the amounts the old strip already read right read the same
  // (the e2e spec's -4.50 and 2500.00, the placeholder's -5.50).
  it.each([
    ['-4.50', -4.5],
    ['2500.00', 2500],
    ['-5.50', -5.5],
    ['"$1,234.56"', 1234.56],
    ['-$5.00', -5],
    ['+5', 5],
    ['0', 0],
    ['.5', 0.5],
  ])('reads %s as %p', (amount, expected) => {
    expect(parseCSV(csvWith(amount)).rows.map((r) => r.amount)).toEqual([
      expected,
    ]);
  });

  // I8 -- zeros past the cents change nothing: the old strip read "$123.4500"
  // as 123.45, and an export may write every amount to four places.
  it.each([
    ['$123.4500', 123.45],
    ['"$9,999.9900"', 9999.99],
    ['5.000', 5],
    ['-$0.0000', 0],
    ['(1.2300)', -1.23],
    ['"($1,234.5000)"', -1234.5],
  ])('reads %s as %p, zeros past the cents dropped', (amount, expected) => {
    const { rows, refused } = parseCSV(csvWith(amount));
    expect(rows.map((r) => r.amount)).toEqual([expected]);
    expect(refused).toEqual([]);
  });
});

describe('parseImportAmount (#165)', () => {
  // P1
  it('reads an accounting negative, with or without a dollar sign inside', () => {
    expect(parseImportAmount('(5.00)')).toBe(-5);
    expect(parseImportAmount('($5.00)')).toBe(-5);
    expect(parseImportAmount('($1,234.56)')).toBe(-1234.56);
    expect(parseImportAmount(' (5) ')).toBe(-5);
    expect(parseImportAmount('(9,999,999,999.99)')).toBe(-9999999999.99);
  });

  // P2 -- toBe is Object.is: -0 would fail.
  it('reads an accounting zero as 0, never -0', () => {
    expect(parseImportAmount('(0.00)')).toBe(0);
  });

  // P3
  it.each([
    '(-5.00)',
    '(+5)',
    '((5.00))',
    '()',
    '(5.00',
    '5.00)',
    '$(5.00)',
    '-(5.00)',
    '(12,34)',
    '(1e5)',
    '(10,000,000,000.00)',
  ])('refuses %j', (text) => {
    expect(parseImportAmount(text)).toBeNull();
  });

  // P4 -- pin: without parentheses, or zeros past the cents, it is
  // parseAmount, exactly.
  it.each([
    '-68,655.02',
    '$1,234.56',
    '-$5',
    '5.',
    '  5 ',
    '12,34',
    '1.005',
    '1e5',
    '10000000000',
    '',
  ])('reads %j as parseAmount does', (text) => {
    expect(parseImportAmount(text)).toBe(parseAmount(text));
  });

  // P5 -- zeros past the cents are dropped, outside the parentheses or
  // inside them, with spaces around them too.
  it.each([
    ['$123.4500', 123.45],
    ['5.000', 5],
    [' 5.000 ', 5],
    ['.5000', 0.5],
    ['9,999,999,999.9900', 9999999999.99],
    ['(1.2300)', -1.23],
    ['( $1.2300 )', -1.23],
  ])('reads %j as %p, zeros past the cents dropped', (text, expected) => {
    expect(parseImportAmount(text)).toBe(expected);
  });

  // P6 -- toBe is Object.is: a padded zero is 0, never -0.
  it('reads a zero padded past the cents as 0, never -0', () => {
    expect(parseImportAmount('(0.0000)')).toBe(0);
    expect(parseImportAmount('-$0.0000')).toBe(0);
  });

  // P7 -- pin: only zeros are dropped. Another digit past the cents makes an
  // amount the server would round (1.005 is stored as 1.01): refused, as is
  // an amount still over the cap once its zeros are gone.
  it.each([
    '1.005',
    '1.0050',
    '1.2345',
    '$123.4567',
    '(1.2345)',
    '(1.0050)',
    '10,000,000,000.0000',
  ])('still refuses %j', (text) => {
    expect(parseImportAmount(text)).toBeNull();
  });
});

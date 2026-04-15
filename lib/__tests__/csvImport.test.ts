import { parseCSV } from '../csvImport';

describe('parseCSV', () => {
  it('parses a standard CSV with Date/Title/Amount headers', () => {
    const csv = `Date,Title,Category,Note,Amount
04/02/2026,"Coffee Shop",Food,Morning,-5.50
04/03/2026,Paycheck,Income,,2500.00`;

    const result = parseCSV(csv);
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

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-01-15');
    expect(result[0].payee).toBe('Grocery Store');
    expect(result[0].amount).toBe(-42.33);
  });

  it('detects Description/Value headers', () => {
    const csv = `Date,Description,Value
01/15/2026,Electric Bill,-120.99`;

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Electric Bill');
    expect(result[0].amount).toBe(-120.99);
  });

  it('handles quoted fields containing commas', () => {
    const csv = `Date,Title,Amount
04/01/2026,"Smith, John",100.00`;

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Smith, John');
  });

  it('handles escaped double quotes in quoted fields', () => {
    const csv = `Date,Title,Amount
04/01/2026,"The ""Best"" Store",50.00`;

    const result = parseCSV(csv);
    expect(result[0].payee).toBe('The "Best" Store');
  });

  it('normalizes MM/DD/YYYY dates to YYYY-MM-DD', () => {
    const csv = `Date,Title,Amount
4/2/2026,Test,10`;

    const result = parseCSV(csv);
    expect(result[0].date).toBe('2026-04-02');
  });

  it('preserves YYYY-MM-DD dates as-is', () => {
    const csv = `Date,Title,Amount
2026-04-02,Test,10`;

    const result = parseCSV(csv);
    expect(result[0].date).toBe('2026-04-02');
  });

  it('strips currency symbols from amounts', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,$1234.56`;

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(1234.56);
  });

  it('returns empty array for empty input', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('returns empty array for header-only input', () => {
    expect(parseCSV('Date,Title,Amount')).toEqual([]);
  });

  it('skips rows with too few fields', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,100
X`;

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
  });

  it('skips rows with NaN amounts', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,not-a-number
04/02/2026,Valid,50`;

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].payee).toBe('Valid');
  });

  it('handles \\r\\n line endings', () => {
    const csv = "Date,Title,Amount\r\n04/01/2026,Test,100\r\n";
    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
  });

  it('sets category and memo to empty string when columns are absent', () => {
    const csv = `Date,Title,Amount
04/01/2026,Test,100`;

    const result = parseCSV(csv);
    expect(result[0].category).toBe('');
    expect(result[0].memo).toBe('');
  });

  it('handles Memo/Note header synonyms', () => {
    const csv = `Date,Title,Note,Amount
04/01/2026,Test,Remember this,100`;

    const result = parseCSV(csv);
    expect(result[0].memo).toBe('Remember this');
  });
});

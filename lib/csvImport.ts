import { calendarDate, parseAmount } from './format';

export interface ParsedTransaction {
  date: string;
  /**
   * The date as the line wrote it, trimmed ("2026-01-15T08:10:00"), of which
   * `date` keeps the day: the import's dedup tells two lines of one day apart
   * by it (`applyTransactionImport`, #36).
   */
  rawDate: string;
  payee: string;
  memo: string;
  amount: number;
  selected: boolean;
}

/** A line the import does not take, and why: the preview lists it (#165). */
export interface RefusedCSVRow {
  /** The line of the pasted text, counting from 1 and counting blank lines. */
  line: number;
  payee: string;
  reason: string;
  /**
   * True when the line's date can only be day first ("15/01/2026"): if the
   * file writes the day first, its dates up to the 12th were read month
   * first, and the preview says so (#36). Absent otherwise.
   */
  dayFirst?: boolean;
}

export interface ParsedCSV {
  /** The rows that can be imported, in the order of the file. */
  rows: ParsedTransaction[];
  /**
   * The lines whose date or amount cannot be read, in the order of the file.
   */
  refused: RefusedCSVRow[];
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// The two forms of date en-US exports write, read whole (#36): month first
// with slashes and a four- or two-digit year ("4/2/2026", "04/02/26"), or
// year first with dashes ("2026-04-02", "2026-4-2"). Either may carry a time
// of day, which is dropped ("2026-04-02T10:30:00Z", "4/2/2026 10:30 AM").
const MONTH_FIRST_DATE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?: \d{1,2}:\d{2}.*)?$/;
const YEAR_FIRST_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}.*)?$/;

/**
 * Reads the date column of an imported row (trimmed) as the "YYYY-MM-DD" the
 * app stores, or returns null when it is not a date the import reads (#36):
 * month first, as en-US exports write it ("4/2/2026", "04/02/2026"), or year
 * first ("2026-04-02"). A two-digit year is read as the server reads one,
 * 00-69 as 20xx and 70-99 as 19xx; a time of day is dropped and the date kept
 * as written, as the server's date column keeps it, offset or not. Only a day
 * of the calendar is read (`calendarDate`, lib/format.ts, the rule the forms
 * check their dates with too).
 *
 * Day first is never inferred: "15/01/2026" is refused, not read as 15
 * January. A file that writes it also writes "05/01/2026", which reads as
 * May 1 just as well, so a guess made line by line would put the lines of one
 * file a month or more apart without a word. The import used to store
 * "15/01/2026" as "2026-15-01", and any other text it could not read as
 * written; the server refuses such a date (22008, or 22007 for a blank or a
 * "1/5"), so the row stayed pending on this device forever, and the reset
 * refused to run over it.
 */
function parseImportDate(text: string): string | null {
  const monthFirst = MONTH_FIRST_DATE.exec(text);
  if (monthFirst) {
    const [, m, d, y] = monthFirst;
    const year = Number(y);
    const fullYear =
      y.length === 4 ? year : year < 70 ? 2000 + year : 1900 + year;
    return calendarDate(fullYear, Number(m), Number(d));
  }
  const yearFirst = YEAR_FIRST_DATE.exec(text);
  if (yearFirst) {
    const [, y, m, d] = yearFirst;
    return calendarDate(Number(y), Number(m), Number(d));
  }
  return null;
}

/**
 * Whether a date can only be day first: its first number is over 12, so no
 * month, and with its first two numbers swapped it is a day of the calendar
 * ("15/01/2026" as 01/15/2026). `parseImportDate` refuses such a date, which
 * only a day-first file writes, or a typo. Day first is still not inferred;
 * the preview warns instead that in such a file the dates up to the 12th were
 * read month first, "05/01/2026" as May 1 (#36).
 */
function onlyDayFirst(text: string): boolean {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(.*)$/.exec(text);
  if (!parts || Number(parts[1]) <= 12) {
    return false;
  }
  return parseImportDate(`${parts[2]}/${parts[1]}/${parts[3]}`) !== null;
}

type ColumnMap = {
  date: number;
  payee: number;
  memo: number;
  amount: number;
};

/**
 * Finds the columns the import reads, by their headers. A category is not
 * one of them (#27): the app has had no categories since migration 002, so
 * the import stores none, and a "Category", "Type" or "Class" column is
 * ignored like any other column the import does not read. The preview used to
 * show its text on each row as though it were imported. Reading it belongs
 * with the return of categories (#31).
 */
function detectColumns(headers: string[]): ColumnMap {
  const lower = headers.map((h) => h.trim().toLowerCase());

  const find = (candidates: string[]): number =>
    lower.findIndex((h) => candidates.includes(h));

  return {
    date: Math.max(
      0,
      find(['date', 'txn_date', 'transaction date', 'posted date'])
    ),
    payee: Math.max(
      0,
      find(['title', 'payee', 'description', 'name', 'merchant'])
    ),
    memo: find(['note', 'memo', 'notes', 'comment', 'reference']),
    amount: Math.max(0, find(['amount', 'total', 'value', 'sum'])),
  };
}

/**
 * Drops the zeros an export writes past the cents ("$123.4500" is $123.45),
 * which the old strip read right. Any other digit there stays, so
 * `parseAmount` still refuses "1.005": an amount the server would round.
 */
function withoutZerosPastCents(text: string): string {
  return text.trim().replace(/(\.\d{2})0+$/, '$1');
}

/**
 * Reads the amount column of an imported row, or returns null when the text is
 * not an amount (#165): `parseAmount`'s strict en-US form ("-1,234.56",
 * "$5.00", "-$5"), plus the accounting negative bank and spreadsheet exports
 * write, "(5.00)" or "($1,234.56)", read as -5.00 and -1,234.56. Zeros past
 * the cents are dropped first ("5.000", "(1.2300)").
 *
 * The import used to strip every character but digits, "." and "-" before
 * parseFloat, which read "(5.00)" as +5, "12,34" as 1234, "1.234,56" as
 * 1.23456, "1e5" as 15 and "5-" as 5 -- and an amount longer than the
 * server's numeric(12,2) holds, which the push then retried forever.
 */
export function parseImportAmount(text: string): number | null {
  const accounting = /^\((.*)\)$/.exec(text.trim());
  if (!accounting) {
    return parseAmount(withoutZerosPastCents(text));
  }
  // "(-5.00)" says minus twice; refuse it rather than guess.
  if (/[+-]/.test(accounting[1])) {
    return null;
  }
  const value = parseAmount(withoutZerosPastCents(accounting[1]));
  return value === null || value === 0 ? value : -value;
}

/**
 * The sample the import screen shows in its empty paste box: a header naming
 * the columns the import reads (#27) and one line under it. The line parses
 * to one row with nothing refused (csvImport.test.ts holds it to that), so a
 * sample with a field too many or too few fails a test instead of showing a
 * line the import would refuse.
 */
export const CSV_SAMPLE =
  'Date,Title,Note,Amount\n04/02/2026,"Coffee Shop",,-5.50';

/**
 * Parses pasted CSV into the rows to import and the lines refused (#165).
 *
 * A line whose amount cannot be read -- missing, blank, or not an amount
 * `parseImportAmount` accepts -- is not imported, and it is not dropped
 * silently either: it is returned in `refused` with its line number and the
 * reason, for the preview to show. So is a line whose date cannot be read
 * (`parseImportDate`, #36), with both reasons when both fail; a date that can
 * only be day first is named so, and its line marked `dayFirst`. A line with
 * fewer than two fields, or with nothing in any field (a spreadsheet's empty
 * row, ",,,,"), is not a transaction line at all and is skipped, as before.
 */
export function parseCSV(text: string): ParsedCSV {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ text: l.trim(), line: i + 1 }))
    .filter((l) => l.text.length > 0);

  if (lines.length < 2) {
    return { rows: [], refused: [] };
  }

  const headerFields = parseCSVLine(lines[0].text);
  const cols = detectColumns(headerFields);

  const rows: ParsedTransaction[] = [];
  const refused: RefusedCSVRow[] = [];

  for (const { text: lineText, line } of lines.slice(1)) {
    const fields = parseCSVLine(lineText);
    if (fields.length < 2 || fields.every((f) => f.trim() === '')) {
      continue;
    }

    const payee = (fields[cols.payee] ?? '').trim();
    const rawDate = (fields[cols.date] ?? '').trim();
    const date = parseImportDate(rawDate);
    const rawAmount = (fields[cols.amount] ?? '').trim();
    const amount = parseImportAmount(rawAmount);
    if (date === null || amount === null) {
      // Every reason at once, so a line fixed for one is not refused again
      // for the other.
      const reasons: string[] = [];
      const dayFirst = onlyDayFirst(rawDate);
      if (date === null) {
        if (rawDate === '') {
          reasons.push('There is no date.');
        } else if (dayFirst) {
          reasons.push(`"${rawDate}" can only be day first.`);
        } else {
          reasons.push(`"${rawDate}" is not a date.`);
        }
      }
      if (amount === null) {
        reasons.push(
          rawAmount === ''
            ? 'There is no amount.'
            : `"${rawAmount}" is not an amount.`
        );
      }
      const row: RefusedCSVRow = { line, payee, reason: reasons.join(' ') };
      if (dayFirst) {
        row.dayFirst = true;
      }
      refused.push(row);
      continue;
    }

    rows.push({
      date,
      rawDate,
      payee,
      memo: cols.memo >= 0 ? (fields[cols.memo] ?? '').trim() : '',
      amount,
      selected: true,
    });
  }

  return { rows, refused };
}

import { parseAmount } from './format';

export interface ParsedTransaction {
  date: string;
  payee: string;
  category: string;
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
}

export interface ParsedCSV {
  /** The rows that can be imported, in the order of the file. */
  rows: ParsedTransaction[];
  /** The lines whose amount cannot be read, in the order of the file. */
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

function normalizeDate(raw: string): string {
  raw = raw.trim();

  // MM/DD/YYYY -> YYYY-MM-DD
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY-MM-DD already correct
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  // DD/MM/YYYY variant (if month > 12 it's clearly DD first)
  const altMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (altMatch) {
    const [, a, b, y] = altMatch;
    return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }

  return raw;
}

type ColumnMap = {
  date: number;
  payee: number;
  category: number;
  memo: number;
  amount: number;
};

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
    category: find(['category', 'type', 'class']),
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
 * Parses pasted CSV into the rows to import and the lines refused (#165).
 *
 * A line whose amount cannot be read -- missing, blank, or not an amount
 * `parseImportAmount` accepts -- is not imported, and it is not dropped
 * silently either: it is returned in `refused` with its line number and the
 * reason, for the preview to show. A line with fewer than two fields, or with
 * nothing in any field (a spreadsheet's empty row, ",,,,"), is not a
 * transaction line at all and is skipped, as before.
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
    const rawAmount = (fields[cols.amount] ?? '').trim();
    const amount = parseImportAmount(rawAmount);
    if (amount === null) {
      refused.push({
        line,
        payee,
        reason:
          rawAmount === ''
            ? 'There is no amount.'
            : `"${rawAmount}" is not an amount.`,
      });
      continue;
    }

    rows.push({
      date: normalizeDate(fields[cols.date] ?? ''),
      payee,
      category: cols.category >= 0 ? (fields[cols.category] ?? '').trim() : '',
      memo: cols.memo >= 0 ? (fields[cols.memo] ?? '').trim() : '',
      amount,
      selected: true,
    });
  }

  return { rows, refused };
}

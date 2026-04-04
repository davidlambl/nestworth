export interface ParsedTransaction {
  date: string;
  payee: string;
  category: string;
  memo: string;
  amount: number;
  selected: boolean;
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
    date: Math.max(0, find(['date', 'txn_date', 'transaction date', 'posted date'])),
    payee: Math.max(0, find(['title', 'payee', 'description', 'name', 'merchant'])),
    category: find(['category', 'type', 'class']),
    memo: find(['note', 'memo', 'notes', 'comment', 'reference']),
    amount: Math.max(0, find(['amount', 'total', 'value', 'sum'])),
  };
}

export function parseCSV(text: string): ParsedTransaction[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headerFields = parseCSVLine(lines[0]);
  const cols = detectColumns(headerFields);

  const results: ParsedTransaction[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 2) {
      continue;
    }

    const rawAmount = fields[cols.amount]?.trim() ?? '0';
    const amount = parseFloat(rawAmount.replace(/[^0-9.\-]/g, ''));
    if (isNaN(amount)) {
      continue;
    }

    results.push({
      date: normalizeDate(fields[cols.date] ?? ''),
      payee: (fields[cols.payee] ?? '').trim(),
      category: cols.category >= 0 ? (fields[cols.category] ?? '').trim() : '',
      memo: cols.memo >= 0 ? (fields[cols.memo] ?? '').trim() : '',
      amount,
      selected: true,
    });
  }

  return results;
}

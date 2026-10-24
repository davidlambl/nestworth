export function formatCurrency(amount: number): string {
  const display = Math.abs(amount) < 0.005 ? 0 : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(display);
}

/**
 * The largest amount, in cents, that the server's `numeric(12,2)` columns hold
 * (`accounts.initial_balance`, `transactions.amount` and
 * `transaction_splits.amount` in supabase/migrations/001_initial.sql): ten
 * digits before the point. A larger value is refused by Postgres, and the push
 * would leave its row pending with only a console warning.
 */
export const MAX_AMOUNT_CENTS = 999_999_999_999;

// What a person types or pastes as an en-US dollar amount -- the only kind
// formatCurrency prints: one optional sign before or after an optional "$",
// whole dollars either plain or with a comma between every group of three
// digits, and at most two decimal places.
const AMOUNT_PATTERN =
  /^(?:([+-])\$?|\$([+-])?)?([1-9]\d{0,2}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?$/;

/**
 * Parses a typed amount, or returns null when the text is not one (#145).
 *
 * `parseFloat` stops at the first character it cannot read, so "-68,655.02"
 * became -68 and "$5.00" became NaN. This reads the whole text or refuses it:
 * "-68,655.02", "$1,234.56", "-$5" and "1234.5" parse; "12,34", "1.234,56",
 * "1.005", "1e5", "(5.00)" and "" do not, so a form can say so instead of
 * saving a different number. Every accepted value is a whole number of cents
 * within MAX_AMOUNT_CENTS, so it round-trips through formatCurrency exactly.
 */
export function parseAmount(text: string): number | null {
  const match = AMOUNT_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  const [, signBefore, signAfter, whole, fraction = ''] = match;
  if (whole === '' && fraction === '') {
    return null;
  }
  const cents =
    Number(whole.replace(/,/g, '') || '0') * 100 +
    Number(fraction.padEnd(2, '0'));
  if (cents > MAX_AMOUNT_CENTS) {
    return null;
  }
  if (cents === 0) {
    return 0;
  }
  return ((signBefore ?? signAfter) === '-' ? -cents : cents) / 100;
}

/**
 * The New Account modal's starting balance (#145): left blank it is the
 * placeholder's 0.00, as it always was; anything else must read as an amount
 * (`parseAmount`), or this returns null and the modal says so. The screen used
 * `parseFloat(text) || 0`, which cut "-68,655.02" to -68 and turned "$5.00"
 * into 0 without a word.
 */
export function parseStartingBalance(text: string): number | null {
  return text.trim() === '' ? 0 : parseAmount(text);
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The Date a stored "YYYY-MM-DD" names, at the start of that day here (local
 * midnight, or the first hour after it where a clock change skips midnight):
 * the value the date pickers of the transaction, transfer and recurring
 * screens start from. A stored date is a day of the calendar, not an instant,
 * so it is read in the local zone, never as UTC (`new Date("2026-01-15")` is
 * UTC midnight, the evening of the 14th in New York). Each of the four screens
 * had its own copy of this and of formatDateStr until #36.
 */
export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The "YYYY-MM-DD" of the local calendar day a Date falls on: what a date
 * picker's choice is stored as, at whatever time of that day the picker hands
 * it back. Not `toISOString()`, which gives the UTC day (#36).
 */
export function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayString(): string {
  return formatDateStr(new Date());
}

/**
 * The "YYYY-MM-DD" of a day of the calendar, or null when there is no such
 * day (month 13, February 30, February 29 outside a leap year). Written from
 * the numbers themselves: a Date would roll February 30 into March 2 without
 * a word. A year before 1000 is refused too, as the date pickers of iOS and
 * Android cannot carry one: they start from `parseDateStr`, which reads year
 * 26 as 1926 (the Date constructor's rule), and store a choice with
 * `formatDateStr`, which writes year 999 as "999-12-31", not four digits.
 *
 * The app's one calendar rule: the CSV import reads a date with it
 * (`parseImportDate`, lib/csvImport.ts, #36), and the forms check theirs
 * with it through `isDateStr` (#192).
 */
export function calendarDate(
  year: number,
  month: number,
  day: number
): string | null {
  if (year < 1000 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  // Day 0 of the next month is the last day of this one; in UTC, where no
  // zone's clock change can move it.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Whether text is a date as the app stores one: "YYYY-MM-DD", four digits of
 * year and two each of month and day, naming a day of the calendar
 * (`calendarDate`). Every form with a date checks it with this before it
 * saves (#192). The web and desktop date field (components/WebDateInput.tsx,
 * an `<input type="date">`) reads '' once it is emptied and while a date is
 * only partly typed, and the forms used to save that: the register showed the
 * row as "Invalid Date", the server refused it (22007) so it stayed pending,
 * and a rule's blank next date failed every Post Now. The rest of the rule
 * covers what is not '': the field also takes a year of five digits
 * ("20260-10-23"), which the register shows as "Invalid Date", and the edit
 * screen starts from the stored row, which an import before #36 could leave
 * as "2026-15-01" (the server refuses it, 22008).
 */
export function isDateStr(text: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return (
    parts !== null &&
    calendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) !== null
  );
}

/** What a form says when its date field holds no date it can save (#192). */
export const DATE_MISSING_MESSAGE = 'Please enter a valid date.';

export function balanceColor(
  value: number,
  colors: { income: string; expense: string; textSecondary: string }
): string {
  if (Math.abs(value) < 0.005) return colors.textSecondary;
  return value > 0 ? colors.income : colors.expense;
}

/**
 * Relative time since the last COMPLETE cloud pull (sync_meta last_pull_at). A
 * pull that could not read or trust every table does not stamp it (#66).
 */
export function formatRelativeSyncedTime(iso: string | null): string {
  if (!iso) {
    return 'Never';
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 'Unknown';
  }
  const now = Date.now();
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) {
    return 'Just now';
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} minute${min === 1 ? '' : 's'} ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 48) {
    return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

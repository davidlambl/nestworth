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

export function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

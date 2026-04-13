export function formatCurrency(amount: number): string {
  const display = Math.abs(amount) < 0.005 ? 0 : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(display);
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
  colors: { income: string; expense: string; textSecondary: string },
): string {
  if (Math.abs(value) < 0.005) return colors.textSecondary;
  return value > 0 ? colors.income : colors.expense;
}

/** Relative time since last successful cloud pull (sync_meta last_pull_at). */
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

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
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
  return d.toISOString().split('T')[0];
}

export function balanceColor(
  value: number,
  colors: { income: string; expense: string; textSecondary: string },
): string {
  if (value === 0) return colors.textSecondary;
  return value > 0 ? colors.income : colors.expense;
}

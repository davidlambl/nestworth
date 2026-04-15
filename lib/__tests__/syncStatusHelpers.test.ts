import {
  statusDotColor,
  statusLabel,
  PENDING_TINT,
  type SyncSnapshot,
  type StatusColors,
} from '../syncStatusHelpers';

const colors: StatusColors = {
  destructive: '#ef4444',
  textSecondary: '#6b7280',
  income: '#16a34a',
};

function makeSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    isSyncing: false,
    pendingCount: 0,
    lastError: null,
    isOnline: true,
    ...overrides,
  };
}

describe('statusDotColor', () => {
  it('returns destructive when there is an error', () => {
    const snap = makeSnapshot({ lastError: 'Network failed' });
    expect(statusDotColor(snap, colors)).toBe(colors.destructive);
  });

  it('returns textSecondary when offline', () => {
    const snap = makeSnapshot({ isOnline: false });
    expect(statusDotColor(snap, colors)).toBe(colors.textSecondary);
  });

  it('returns pending tint when pending count > 0', () => {
    const snap = makeSnapshot({ pendingCount: 5 });
    expect(statusDotColor(snap, colors)).toBe(PENDING_TINT);
  });

  it('returns income color when fully synced', () => {
    const snap = makeSnapshot();
    expect(statusDotColor(snap, colors)).toBe(colors.income);
  });

  it('prioritizes error over offline', () => {
    const snap = makeSnapshot({ lastError: 'err', isOnline: false });
    expect(statusDotColor(snap, colors)).toBe(colors.destructive);
  });

  it('prioritizes offline over pending', () => {
    const snap = makeSnapshot({ isOnline: false, pendingCount: 3 });
    expect(statusDotColor(snap, colors)).toBe(colors.textSecondary);
  });
});

describe('statusLabel', () => {
  it('returns "Syncing\u2026" when syncing', () => {
    const snap = makeSnapshot({ isSyncing: true });
    expect(statusLabel(snap)).toBe('Syncing\u2026');
  });

  it('returns "Sync error" when there is an error', () => {
    const snap = makeSnapshot({ lastError: 'fail' });
    expect(statusLabel(snap)).toBe('Sync error');
  });

  it('returns "Offline" when offline', () => {
    const snap = makeSnapshot({ isOnline: false });
    expect(statusLabel(snap)).toBe('Offline');
  });

  it('returns pending count when pending', () => {
    const snap = makeSnapshot({ pendingCount: 7 });
    expect(statusLabel(snap)).toBe('7 pending');
  });

  it('returns "Synced" when all clear', () => {
    const snap = makeSnapshot();
    expect(statusLabel(snap)).toBe('Synced');
  });

  it('prioritizes syncing over error', () => {
    const snap = makeSnapshot({ isSyncing: true, lastError: 'err' });
    expect(statusLabel(snap)).toBe('Syncing\u2026');
  });

  it('prioritizes error over offline', () => {
    const snap = makeSnapshot({ lastError: 'err', isOnline: false });
    expect(statusLabel(snap)).toBe('Sync error');
  });
});

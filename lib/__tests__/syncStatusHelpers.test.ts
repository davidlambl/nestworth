import {
  statusDotColor,
  statusLabel,
  syncButtonLabel,
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

  // Offline outranks a recorded error (#66). While NetInfo says offline the
  // error is almost always the offline itself (a foreground sync runs whatever
  // the connectivity, and every read fails), so "Offline" is the honest state;
  // the reconnection trigger's fullSync clears lastError on entry before its
  // next attempt, so a real error surfaces again once online. The error itself
  // stays recorded — only what the dot and label show changes.
  it('prioritizes offline over error', () => {
    const snap = makeSnapshot({ lastError: 'err', isOnline: false });
    expect(statusDotColor(snap, colors)).toBe(colors.textSecondary);
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

  // See statusDotColor above: offline outranks a recorded error (#66).
  it('prioritizes offline over error', () => {
    const snap = makeSnapshot({ lastError: 'err', isOnline: false });
    expect(statusLabel(snap)).toBe('Offline');
  });

  it('still prioritizes syncing over offline', () => {
    const snap = makeSnapshot({
      isSyncing: true,
      isOnline: false,
      lastError: 'err',
    });
    expect(statusLabel(snap)).toBe('Syncing\u2026');
  });
});

describe('syncButtonLabel', () => {
  // The header dot and a collapsed sidebar's sync row show only a dot (#38):
  // the label says what its colour shows, then what pressing it does.
  it('says the status, then what pressing does', () => {
    expect(syncButtonLabel(makeSnapshot())).toBe('Synced, sync now');
    expect(syncButtonLabel(makeSnapshot({ pendingCount: 2 }))).toBe(
      '2 pending, sync now'
    );
  });

  // While a sync runs both controls are disabled, so the label offers no
  // action then. Offline they stay enabled, and pressing starts a sync.
  it('says the status alone while a sync runs', () => {
    expect(syncButtonLabel(makeSnapshot({ isSyncing: true }))).toBe(
      'Syncing\u2026'
    );
    expect(syncButtonLabel(makeSnapshot({ isOnline: false }))).toBe(
      'Offline, sync now'
    );
  });
});

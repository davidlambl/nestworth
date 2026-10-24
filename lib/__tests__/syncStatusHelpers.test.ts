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

// The rows the push was refused for good (#115) are pending too, but no sync
// uploads them: the controls count them apart (#194), as Settings does. The
// counts are the signed-in user's, as useSyncStatus gives them; the store's
// pendingCount includes the refused rows AND the split lines waiting under
// them, so what a sync can upload is waitingTotal's (lib/syncRefusals.ts).
describe('the rows the cloud refused for good (#194)', () => {
  it('says how many changes can not be uploaded when nothing else waits', () => {
    // Two refused rows and one split line under one of them: nothing waits.
    const snap = makeSnapshot({
      pendingCount: 3,
      refusedCount: 2,
      refusedSplits: 1,
    });
    // The store's two reads are not one snapshot (lib/syncStatus.ts): the
    // label never says "Synced" beside the orange dot of a row it names.
    const late = makeSnapshot({
      pendingCount: 0,
      refusedCount: 1,
      refusedSplits: 0,
    });
    expect([
      statusLabel(snap),
      syncButtonLabel(snap),
      statusLabel(late),
    ]).toStrictEqual([
      "2\u00a0can't\u00a0upload",
      "2\u00a0can't\u00a0upload, sync now",
      "1\u00a0can't\u00a0upload",
    ]);
  });

  it('counts the changes a sync uploads first, then the ones it cannot', () => {
    // 6 unsynced: 2 refused rows, the split line under one, 3 waiting.
    const snap = makeSnapshot({
      pendingCount: 6,
      refusedCount: 2,
      refusedSplits: 1,
    });
    expect([statusLabel(snap), syncButtonLabel(snap)]).toStrictEqual([
      "3\u00a0pending, 2\u00a0can't\u00a0upload",
      "3\u00a0pending, 2\u00a0can't\u00a0upload, sync now",
    ]);
  });

  it('keeps the orange dot for them: they wait on the person, not on an error', () => {
    expect([
      statusDotColor(
        makeSnapshot({ pendingCount: 3, refusedCount: 2, refusedSplits: 1 }),
        colors
      ),
      // The store's two reads are not one snapshot (lib/syncStatus.ts): the
      // dot never says "synced" beside a label that names a row.
      statusDotColor(
        makeSnapshot({ pendingCount: 0, refusedCount: 1, refusedSplits: 0 }),
        colors
      ),
    ]).toStrictEqual([PENDING_TINT, PENDING_TINT]);
  });

  it('PIN: leaves every label as it was when nothing is refused', () => {
    const none = { refusedCount: 0, refusedSplits: 0 };
    expect([
      statusLabel(makeSnapshot({ ...none })),
      statusLabel(makeSnapshot({ ...none, pendingCount: 2 })),
      syncButtonLabel(makeSnapshot({ ...none, pendingCount: 2 })),
      statusDotColor(makeSnapshot({ ...none }), colors),
    ]).toStrictEqual([
      'Synced',
      '2 pending',
      '2 pending, sync now',
      colors.income,
    ]);
  });

  it('PIN: still says Syncing, Offline and Sync error first', () => {
    const refused = { pendingCount: 2, refusedCount: 1, refusedSplits: 0 };
    expect([
      statusLabel(makeSnapshot({ ...refused, isSyncing: true })),
      statusLabel(makeSnapshot({ ...refused, isOnline: false })),
      statusLabel(makeSnapshot({ ...refused, lastError: 'err' })),
      syncButtonLabel(makeSnapshot({ ...refused, isSyncing: true })),
    ]).toStrictEqual([
      'Syncing\u2026',
      'Offline',
      'Sync error',
      'Syncing\u2026',
    ]);
  });
});

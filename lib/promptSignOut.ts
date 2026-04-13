import { Alert, Platform } from 'react-native';
import { fullSync } from './sync';
import { getSyncSnapshot, refreshSyncState } from './syncStatus';

type SignOutCallbacks = {
  signOut: () => Promise<void>;
  onNavigateToSignIn: () => void;
};

/**
 * Confirms sign-out; warns when local DB has unsynced rows and offers sync-first.
 */
export async function promptSignOut(
  userId: string,
  { signOut, onNavigateToSignIn }: SignOutCallbacks,
) {
  await refreshSyncState(userId);
  let snapshot = getSyncSnapshot();

  const performSignOut = async () => {
    await signOut();
    onNavigateToSignIn();
  };

  const showSimpleConfirm = () => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm('Are you sure you want to sign out?')) {
        void performSignOut();
      }
      return;
    }
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void performSignOut() },
    ]);
  };

  if (snapshot.pendingCount === 0) {
    showSimpleConfirm();
    return;
  }

  const warnBody = `You have ${snapshot.pendingCount} unsynced change(s) that may not be saved to the cloud if you sign out before they sync.`;

  if (Platform.OS === 'web') {
    const syncFirst =
      typeof window !== 'undefined' &&
      window.confirm(
        `${warnBody}\n\nOK: sync then sign out\nCancel: choose whether to sign out without syncing`,
      );
    if (syncFirst) {
      await fullSync(userId);
      await refreshSyncState(userId);
      snapshot = getSyncSnapshot();
      if (snapshot.pendingCount > 0) {
        if (
          typeof window !== 'undefined' &&
          window.confirm(
            'Sync did not clear all pending changes. Sign out anyway? Unsynced data may be lost on this device.',
          )
        ) {
          void performSignOut();
        }
        return;
      }
      void performSignOut();
      return;
    }
    if (
      typeof window !== 'undefined' &&
      window.confirm('Sign out without syncing? Unsynced changes may be lost.')
    ) {
      void performSignOut();
    }
    return;
  }

  Alert.alert('Sign Out', warnBody, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Sync & Sign Out',
      onPress: async () => {
        await fullSync(userId);
        await refreshSyncState(userId);
        const after = getSyncSnapshot();
        if (after.pendingCount > 0) {
          Alert.alert(
            'Sync incomplete',
            'Some changes could not sync. Try Sync Now in Settings, or sign out anyway.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign Out Anyway',
                style: 'destructive',
                onPress: () => void performSignOut(),
              },
            ],
          );
          return;
        }
        await performSignOut();
      },
    },
    { text: 'Sign Out Anyway', style: 'destructive', onPress: () => void performSignOut() },
  ]);
}

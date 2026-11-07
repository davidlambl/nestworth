export type NativeAppTabsProps = {
  /** The account signed in: the tabs are keyed by it (#177). */
  userId: string;
};

/**
 * The system's tabs are iOS's alone (NativeAppTabs.ios.tsx, #248). On web,
 * in the desktop app and on Android, app/(tabs)/_layout.tsx draws the JS tab
 * bar and never renders this; it exists so that the import resolves there.
 */
export function NativeAppTabs(_props: NativeAppTabsProps) {
  return null;
}

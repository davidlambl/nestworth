import { TabStack } from '@/components/TabStack';

// The Settings tab's group (lib/tabs.ts): on iOS a Stack of its own, so the
// system draws the tab's header (#248); elsewhere the screen under the JS tab
// bar's header.
export default function SettingsTab() {
  return <TabStack tab="(settings)" />;
}

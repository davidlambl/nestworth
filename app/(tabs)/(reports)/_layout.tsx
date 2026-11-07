import { TabStack } from '@/components/TabStack';

// The Reports tab's group (lib/tabs.ts): on iOS a Stack of its own, so the
// system draws the tab's header (#248); elsewhere the screen under the JS tab
// bar's header.
export default function ReportsTab() {
  return <TabStack tab="(reports)" />;
}

import { AccountsHeaderTitle } from '@/components/AccountsHeaderTitle';
import { TabStack } from '@/components/TabStack';

// The Accounts tab's group (lib/tabs.ts): on iOS a Stack of its own, so the
// system draws the tab's header, the app's icon beside the title (#248);
// elsewhere the screen under the JS tab bar's header.
export default function AccountsTab() {
  return <TabStack tab="(home)" HeaderTitle={AccountsHeaderTitle} />;
}

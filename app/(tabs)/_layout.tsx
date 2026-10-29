import React, { useEffect, useState } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, router, usePathname } from 'expo-router';
import {
  ActivityIndicator,
  type ColorValue,
  Image,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useAuth } from '@/lib/auth';
import { Onboarding } from '@/components/Onboarding';
import { Sidebar } from '@/components/Sidebar';
import { exportTransactionsToCsv } from '@/lib/exportTransactions';
import { isWideLayout } from '@/lib/layout';
import { APP_TABS, tabForPath, type AppTab } from '@/lib/tabs';

const appIcon = require('@/assets/images/icon.png');

function TabIcon({
  color,
  ...props
}: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: ColorValue;
}) {
  // The tab bar passes the theme's tint, a string. React Native's types
  // (0.88) also allow a number or null there, which the icon does not take.
  return (
    <FontAwesome
      size={24}
      style={{ marginBottom: -3 }}
      color={color == null || typeof color === 'number' ? undefined : color}
      {...props}
    />
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user, loading } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  const { width } = useWindowDimensions();
  const isWide = isWideLayout(width);
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/(auth)/sign-in');
    }
  }, [loading, user]);

  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(
      ({ default: store }) => {
        store.getItem('onboarding_complete').then((val) => {
          setShowOnboarding(val !== 'true');
        });
      }
    );
  }, []);

  // The desktop app's Export menu item exports the account signed in now:
  // subscribed again for each account, so no ref is written during render
  // (#41). A layout effect, so the switch happens in the commit itself: a
  // passive effect would leave the previous account's listener in place
  // until a later task, and a click in between would export that account.
  const uid = user?.id;
  React.useLayoutEffect(() => {
    const api = (globalThis as any).electronAPI;
    if (typeof api?.onExportCsv !== 'function') return;
    return api.onExportCsv(() => {
      if (!uid) return;
      // Only the desktop app has this menu item, and Alert.alert is a no-op
      // there (#164); Electron shows window.alert as a native message box.
      exportTransactionsToCsv(uid).catch((e: any) =>
        window.alert(`Export failed: ${e?.message ?? 'Unknown error'}`)
      );
    });
  }, [uid]);

  if (loading || showOnboarding === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (!user) {
    return null;
  }

  if (showOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          import('@react-native-async-storage/async-storage').then(
            ({ default: store }) => {
              store.setItem('onboarding_complete', 'true');
            }
          );
          setShowOnboarding(false);
        }}
      />
    );
  }

  const activeRoute = tabForPath(pathname);

  const handleSidebarNav = (tab: AppTab) => {
    router.push(tab.path);
  };

  // The Accounts tab's header: the app's icon beside the tab's title.
  const accountsHeaderTitle = ({ children }: { children: string }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <Image
        source={appIcon}
        style={{ width: 22, height: 22, borderRadius: 5 }}
      />
      <Text
        style={{
          fontSize: 17,
          fontWeight: '600',
          color: colors.text,
        }}
      >
        {children}
      </Text>
    </View>
  );

  // Keyed by the account (#177): a change of account that never passes
  // through "signed out" (another tab of the app signing in over this one, or
  // a sign-in after a sign-out whose request failed) mounts the tabs afresh,
  // so no tab screen keeps the previous account's rows in its own state --
  // the Edit Account sheet open on one of its accounts, a half-made account.
  const tabs = (
    <Tabs
      key={user.id}
      screenOptions={{
        tabBarActiveTintColor: colors.tabIconSelected,
        tabBarInactiveTintColor: colors.tabIconDefault,
        tabBarStyle: isWide
          ? { display: 'none' }
          : { backgroundColor: colors.surface, borderTopColor: colors.border },
        headerStyle: { backgroundColor: colors.headerBackground },
        headerTintColor: colors.text,
      }}
    >
      {APP_TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarButtonTestID: tab.testID,
            tabBarIcon: ({ color }) => (
              <TabIcon name={tab.icon} color={color} />
            ),
            ...(tab.name === 'index'
              ? { headerTitle: accountsHeaderTitle }
              : {}),
          }}
        />
      ))}
    </Tabs>
  );

  if (!isWide) {
    return tabs;
  }

  return (
    <View
      style={{
        flex: 1,
        flexDirection: 'row',
        backgroundColor: colors.background,
      }}
    >
      <Sidebar activeRoute={activeRoute} onNavigate={handleSidebarNav} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <View style={{ flex: 1, width: '100%', maxWidth: 960 }}>{tabs}</View>
      </View>
    </View>
  );
}

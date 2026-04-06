import React, { useEffect, useState } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, router, usePathname } from 'expo-router';
import { ActivityIndicator, Image, Text, View, useWindowDimensions } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useAuth } from '@/lib/auth';
import { Onboarding } from '@/components/Onboarding';
import { Sidebar } from '@/components/Sidebar';

const appIcon = require('@/assets/images/icon.png');
const SIDEBAR_BREAKPOINT = 768;

function TabIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
}) {
  return <FontAwesome size={24} style={{ marginBottom: -3 }} {...props} />;
}

export default function TabLayout() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user, loading } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  const { width } = useWindowDimensions();
  const isWide = width >= SIDEBAR_BREAKPOINT;
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/(auth)/sign-in');
    }
  }, [loading, user]);

  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      store.getItem('onboarding_complete').then((val) => {
        setShowOnboarding(val !== 'true');
      });
    });
  }, []);

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
          import('@react-native-async-storage/async-storage').then(({ default: store }) => {
            store.setItem('onboarding_complete', 'true');
          });
          setShowOnboarding(false);
        }}
      />
    );
  }

  const activeRoute = pathname === '/reports'
    ? 'reports'
    : pathname === '/settings'
      ? 'settings'
      : 'index';

  const handleSidebarNav = (route: string) => {
    const path = route === 'index' ? '/' : `/${route}`;
    router.push(path as any);
  };

  const tabs = (
    <Tabs
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Accounts',
          tabBarIcon: ({ color }) => <TabIcon name="bank" color={color} />,
          headerTitle: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Image
                source={appIcon}
                style={{ width: 22, height: 22, borderRadius: 5 }}
              />
              <Text style={{
                fontSize: 17,
                fontWeight: '600',
                color: colors.text,
              }}>
                Accounts
              </Text>
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarIcon: ({ color }) => <TabIcon name="bar-chart" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon name="cog" color={color} />,
        }}
      />
    </Tabs>
  );

  if (!isWide) {
    return tabs;
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.background }}>
      <Sidebar activeRoute={activeRoute} onNavigate={handleSidebarNav} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <View style={{ flex: 1, width: '100%', maxWidth: 960 }}>{tabs}</View>
      </View>
    </View>
  );
}

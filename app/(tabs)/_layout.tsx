import React, { useEffect, useState } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, router } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useAuth } from '@/lib/auth';
import { Onboarding } from '@/components/Onboarding';

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

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tabIconSelected,
        tabBarInactiveTintColor: colors.tabIconDefault,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        headerStyle: { backgroundColor: colors.headerBackground },
        headerTintColor: colors.text,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Accounts',
          tabBarIcon: ({ color }) => <TabIcon name="bank" color={color} />,
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
}

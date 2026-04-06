import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAuth } from '@/lib/auth';

const appIcon = require('@/assets/images/icon.png');

type NavItem = {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof FontAwesome>['name'];
};

const NAV_ITEMS: NavItem[] = [
  { key: 'index', label: 'Accounts', icon: 'bank' },
  { key: 'reports', label: 'Reports', icon: 'bar-chart' },
  { key: 'settings', label: 'Settings', icon: 'cog' },
];

interface SidebarProps {
  activeRoute: string;
  onNavigate: (route: string) => void;
}

export function Sidebar({ activeRoute, onNavigate }: SidebarProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { user } = useAuth();

  return (
    <View style={[styles.container, {
      backgroundColor: colors.surface,
      borderRightColor: colors.border,
    }]}>
      <View style={styles.branding}>
        <Image source={appIcon} style={styles.appIcon} />
        <Text style={[styles.appName, { color: colors.text }]}>Nestworth</Text>
      </View>

      <View style={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const active = activeRoute === item.key;
          return (
            <TouchableOpacity
              key={item.key}
              style={[
                styles.navItem,
                active && { backgroundColor: colors.tintLight },
              ]}
              onPress={() => onNavigate(item.key)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={item.icon}
                size={18}
                color={active ? colors.tint : colors.tabIconDefault}
                style={styles.navIcon}
              />
              <Text style={[
                styles.navLabel,
                { color: active ? colors.tint : colors.text },
                active && styles.navLabelActive,
              ]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.footer}>
        <View style={[styles.userBadge, { backgroundColor: colors.tintLight }]}>
          <FontAwesome name="user" size={12} color={colors.tint} />
        </View>
        <Text
          style={[styles.email, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {user?.email ?? ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 220,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingTop: 20,
    paddingBottom: 16,
    justifyContent: 'flex-start',
  },
  branding: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  appIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
  },
  appName: {
    fontSize: 18,
    fontWeight: '700',
  },
  nav: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 10,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  navIcon: {
    width: 26,
    textAlign: 'center',
  },
  navLabel: {
    fontSize: 15,
    marginLeft: 10,
  },
  navLabelActive: {
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  userBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  email: {
    fontSize: 12,
    flex: 1,
  },
});

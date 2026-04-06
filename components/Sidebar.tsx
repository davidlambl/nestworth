import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  StyleSheet,
  Alert,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAuth } from '@/lib/auth';

const appIcon = require('@/assets/images/icon.png');

const EXPANDED_WIDTH = 220;
const COLLAPSED_WIDTH = 60;

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
  const { user, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      store.getItem('nestworth-sidebar-collapsed').then((val) => {
        if (val === 'true') {
          setCollapsed(true);
        }
      });
    });
  }, []);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      store.setItem('nestworth-sidebar-collapsed', String(next));
    });
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/sign-in');
        },
      },
    ]);
  };

  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  return (
    <View style={[styles.container, {
      width,
      backgroundColor: colors.surface,
      borderRightColor: colors.border,
    }]}>
      <View style={[styles.branding, collapsed && styles.brandingCollapsed]}>
        <Image source={appIcon} style={styles.appIcon} />
        {!collapsed && (
          <Text style={[styles.appName, { color: colors.text }]}>Nestworth</Text>
        )}
      </View>

      <View style={[styles.nav, collapsed && styles.navCollapsed]}>
        {NAV_ITEMS.map((item) => {
          const active = activeRoute === item.key;
          return (
            <TouchableOpacity
              key={item.key}
              style={[
                styles.navItem,
                collapsed && styles.navItemCollapsed,
                active && { backgroundColor: colors.tintLight },
              ]}
              onPress={() => onNavigate(item.key)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={item.icon}
                size={18}
                color={active ? colors.tint : colors.tabIconDefault}
                style={collapsed ? styles.navIconCollapsed : styles.navIcon}
              />
              {!collapsed && (
                <Text style={[
                  styles.navLabel,
                  { color: active ? colors.tint : colors.text },
                  active && styles.navLabelActive,
                ]}>
                  {item.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={[styles.collapseBtn, collapsed && styles.collapseBtnCollapsed]}
        onPress={toggleCollapse}
        activeOpacity={0.7}
      >
        <FontAwesome
          name={collapsed ? 'chevron-right' : 'chevron-left'}
          size={12}
          color={colors.textSecondary}
        />
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.footer, collapsed && styles.footerCollapsed]}
        onPress={handleSignOut}
        activeOpacity={0.7}
      >
        <View style={[styles.userBadge, { backgroundColor: colors.tintLight }]}>
          <FontAwesome name="user" size={12} color={colors.tint} />
        </View>
        {!collapsed && (
          <Text
            style={[styles.email, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {user?.email ?? ''}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
  brandingCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
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
  navCollapsed: {
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  navItemCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    width: 44,
    height: 44,
  },
  navIcon: {
    width: 26,
    textAlign: 'center',
  },
  navIconCollapsed: {
    textAlign: 'center',
  },
  navLabel: {
    fontSize: 15,
    marginLeft: 10,
  },
  navLabelActive: {
    fontWeight: '600',
  },
  collapseBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  collapseBtnCollapsed: {
    alignItems: 'center',
    paddingHorizontal: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  footerCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    gap: 0,
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

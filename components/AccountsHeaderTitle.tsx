import React from 'react';
import { Image, Text, View } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

const appIcon = require('@/assets/images/icon.png');

/**
 * The Accounts tab's header title: the app's icon beside the tab's title,
 * which the header passes as `children`. Drawn by the JS tab bar's header
 * (app/(tabs)/_layout.tsx) and, on iOS, by the Accounts tab's own Stack
 * (#248), where the system shows it as the bar's title view: in the
 * horizontal bar in every pose, iPhone Duo's folded one included (the rail
 * presents no custom view).
 */
export function AccountsHeaderTitle({ children }: { children: string }) {
  const colors = Colors[useColorScheme() ?? 'light'];
  return (
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
}

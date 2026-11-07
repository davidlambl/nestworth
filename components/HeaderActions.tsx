import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { NativeStackNavigationOptions } from 'expo-router';

import { SyncStatusHeaderButton } from '@/components/SyncStatusControls';

/**
 * A screen's header buttons, as the options it passes to
 * `navigation.setOptions` in its layout effect (#249).
 *
 * Here, on web, in the desktop app and on Android: views the app draws in
 * the header, with the testIDs the Playwright specs press
 * (`accounts-add-btn`, `register-add-btn`, `register-transfer-btn`) -- the
 * buttons as they were before #249. On iOS (HeaderActions.ios.tsx) the
 * system draws them as native items, an SF Symbol with an accessibility
 * label, so that iPhone Duo's rail can hold them when it is folded: the
 * system leaves a view an app draws in the horizontal bar.
 */
export type HeaderButtons = Pick<
  NativeStackNavigationOptions,
  | 'headerLeft'
  | 'headerRight'
  | 'unstable_headerLeftItems'
  | 'unstable_headerRightItems'
>;

/**
 * The colours the buttons take (constants/Colors.ts): the drawn buttons here,
 * each native item's tint on iOS.
 */
export type HeaderColors = { tint: string };

export type RegisterButtonsProps = {
  /**
   * Whether the register offers to add: not for an archived account, nor
   * one gone from this device, nor before the account is read (#76, #163).
   */
  canAdd: boolean;
  onTransfer: () => void;
  onAdd: () => void;
  colors: HeaderColors;
};

export type AccountsButtonsProps = {
  /** The sync dot beside "+": not where the drawn sidebar shows the status. */
  showSync: boolean;
  onAdd: () => void;
  colors: HeaderColors;
};

/** "Cancel" on the five sheets: the transaction, transfer, import and recurring forms. */
export function sheetCancel(
  onCancel: () => void,
  colors: HeaderColors
): HeaderButtons {
  return {
    headerLeft: () => (
      <TouchableOpacity
        onPress={onCancel}
        style={{ paddingLeft: 16, paddingRight: 12, paddingVertical: 8 }}
      >
        <Text style={{ color: colors.tint, fontSize: 16 }}>Cancel</Text>
      </TouchableOpacity>
    ),
  };
}

/** The register's transfer and "+" (app/account/[id].tsx). */
export function registerButtons({
  canAdd,
  onTransfer,
  onAdd,
  colors,
}: RegisterButtonsProps): HeaderButtons {
  return {
    headerRight: () =>
      !canAdd ? null : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            // Keep the row shrink-wrapped and against the right margin.
            // The header subview's parent is a default (column) flex, so
            // `alignSelf` is the horizontal axis and the default `stretch`
            // lets this row expand to the whole slot; its children then sit
            // at the slot's LEFT edge. That is invisible while the native
            // nav bar sizes the slot to its content, but on iOS 26 with
            // react-native-screens 4.16 a second push of this screen handed
            // the subview a full-width slot without re-measuring it (#77) —
            // the nav-bar breakage that also made the native back button go
            // deaf until 4.17 (#50, #51). Pinning the row's own width and
            // alignment makes the icons land on the right either way.
            // `justifyContent` is the backstop for anything that still
            // stretches the row.
            alignSelf: 'flex-end',
            justifyContent: 'flex-end',
            gap: 16,
            paddingRight: 8,
          }}
        >
          <TouchableOpacity
            testID="register-transfer-btn"
            onPress={onTransfer}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New transfer"
          >
            <FontAwesome name="exchange" size={16} color={colors.tint} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="register-add-btn"
            onPress={onAdd}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New transaction"
          >
            <FontAwesome name="plus" size={20} color={colors.tint} />
          </TouchableOpacity>
        </View>
      ),
  };
}

/** The Accounts tab's sync dot and "+" (app/(tabs)/(home)/index.tsx). */
export function accountsButtons({
  showSync,
  onAdd,
  colors,
}: AccountsButtonsProps): HeaderButtons {
  return {
    headerRight: () => (
      // `alignSelf` pins the row instead of letting it stretch across the
      // whole header slot, which would strand these controls at the slot's
      // left edge. See the comment in registerButtons above for why the slot
      // can end up wider than its content.
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-end',
          justifyContent: 'flex-end',
        }}
      >
        {showSync ? <SyncStatusHeaderButton /> : null}
        <TouchableOpacity
          testID="accounts-add-btn"
          onPress={onAdd}
          style={{ paddingRight: 16 }}
          accessibilityRole="button"
          accessibilityLabel="New account"
        >
          <FontAwesome name="plus" size={20} color={colors.tint} />
        </TouchableOpacity>
      </View>
    ),
  };
}

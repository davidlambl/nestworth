import React from 'react';
import type { NativeStackHeaderItemButton } from 'expo-router';

import { SyncStatusHeaderButton } from '@/components/SyncStatusControls';
// Types only: erased at build time, so Metro never resolves them here, where
// './HeaderActions' is this file.
import type * as Drawn from './HeaderActions';

/**
 * A screen's header buttons on iOS (#249): native items the system draws,
 * each an SF Symbol with a label, set with `navigation.setOptions` as the
 * drawn buttons are elsewhere (HeaderActions.tsx). On iPhone Duo folded the
 * system moves an item with an icon into the rail -- Back or Close first,
 * then the screen's actions -- and keeps a text-only item or a view the app
 * draws in the horizontal bar. On every other iPhone and on iPad they sit in
 * the header as the drawn buttons did.
 *
 * Each item takes the app's tint itself (`colors.tint`, light or dark as the
 * app's appearance): on iOS 26 the system draws a bar's items on their glass
 * in the label colour and does not pass them the bar's tint (the navigation
 * theme's primary, app/_layout.tsx) -- measured in the simulator, where the
 * items without a tint of their own were black in light mode and white in
 * dark, as is the system's Back button, which takes no tint of the app's.
 *
 * A native item takes no testID: the label is also its accessibility label,
 * which VoiceOver reads and the Maestro flows tap (`tapOn: 'New account'`).
 * Keep each label as it is; lib/__tests__/headerActions.test.ts holds them
 * to the flows.
 */

/**
 * An item: the label is its accessibility label and its overflow title; the
 * tint is the app's (above).
 */
function item(
  label: string,
  icon: NativeStackHeaderItemButton['icon'],
  onPress: () => void,
  colors: Drawn.HeaderColors
): NativeStackHeaderItemButton {
  return {
    type: 'button',
    label,
    accessibilityLabel: label,
    icon,
    tintColor: colors.tint,
    onPress,
  };
}

/**
 * "Cancel": the system's close symbol, as iOS draws a sheet's close button,
 * so that the rail can hold it (a text-only item stays horizontal).
 */
export const sheetCancel: typeof Drawn.sheetCancel = (onCancel, colors) => ({
  unstable_headerLeftItems: () => [
    item('Cancel', { type: 'sfSymbol', name: 'xmark' }, onCancel, colors),
  ],
});

/**
 * The register's transfer and "+", in that order (the system lays the items
 * out as listed); none where the register cannot add.
 */
export const registerButtons: typeof Drawn.registerButtons = ({
  canAdd,
  onTransfer,
  onAdd,
  colors,
}) => ({
  unstable_headerRightItems: () =>
    canAdd
      ? [
          item(
            'New transfer',
            { type: 'sfSymbol', name: 'arrow.left.arrow.right' },
            onTransfer,
            colors
          ),
          item(
            'New transaction',
            { type: 'sfSymbol', name: 'plus' },
            onAdd,
            colors
          ),
        ]
      : [],
});

/**
 * The Accounts tab's "+", after the sync dot. The dot stays the view the app
 * draws (components/SyncStatusControls.tsx): its colour is the sync's state
 * and a spinner shows a sync running, which an item's static symbol cannot
 * show -- so on iPhone Duo folded it stays in the horizontal bar while "+"
 * goes into the rail.
 */
export const accountsButtons: typeof Drawn.accountsButtons = ({
  showSync,
  onAdd,
  colors,
}) => ({
  unstable_headerRightItems: () => [
    ...(showSync
      ? [{ type: 'custom' as const, element: <SyncStatusHeaderButton /> }]
      : []),
    item('New account', { type: 'sfSymbol', name: 'plus' }, onAdd, colors),
  ],
});

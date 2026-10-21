import { Platform } from 'react-native';
import type { TransactionStatus } from './types';

/**
 * The accessibility label of a register row's cleared box (#38), a checkbox
 * whose `aria-checked` says whether the row is cleared.
 *
 * On web and in Electron the box is reached on its own and read as "<label>,
 * checkbox, checked" or "not checked", so its label is what checking it
 * means, "Cleared", in both states: a label that followed the state read a
 * pending row as "Pending, checkbox, not checked", which says the opposite.
 * Android's TalkBack reaches it on its own too (a focusable view is left out
 * of its parent's description).
 *
 * On iOS it is not reached on its own: the row is one VoiceOver element whose
 * label is its children's labels joined, without their checked state (React
 * Native's RCTRecursiveAccessibilityLabel), and activating the row opens the
 * transaction. There the label is the row's state, "Pending" or "Cleared",
 * the first word VoiceOver reads for the row. A reconciled row reads
 * "Cleared", as the Cleared filter counts it.
 */
export function clearedBoxLabel(
  status: TransactionStatus
): 'Pending' | 'Cleared' {
  return Platform.OS === 'ios' && status === 'pending' ? 'Pending' : 'Cleared';
}

import { useLayoutEffect, useRef } from 'react';
import { Platform, type ScrollViewInstance } from 'react-native';

/**
 * The ref of a form sheet's ScrollView, which on iOS is scrolled to the
 * form's end whenever the form's error line appears or changes. The line sits
 * directly above the form's button (components/FormError.tsx) and pushes it
 * down by its own height, and a ScrollView keeps its offset when its content
 * grows: on a form taller than its sheet the button just pressed went below
 * the sheet's edge (on the folded iPhone Duo simulator, New Recurring Rule's
 * Create cut by 21 pt until the next swipe; Transfer's two-line line left 18
 * of the button's 56 pt on screen). At the end, the last control is where the
 * form ends, with the room the form leaves under it. A layout effect, not a
 * passive one: the scroll is sent in the same task as the commit that adds
 * the line.
 *
 * So it scrolls whenever a line appears on a form taller than its sheet: on
 * most of the five on the folded Duo, and on any iPhone with the keyboard up
 * on any of the five sheets, with large text, on Edit Transaction with a
 * photo, in any pose where the sheet is short. Measured in the simulator on
 * the folded Duo (iOS 27.1) and, on an iPhone 17 (iOS 26.5), in two states
 * only -- Edit Transaction's line at the end of its scroll, with a photo, and
 * Import's line with the keyboard up -- where the line and the button end in
 * view, as on the Duo. Where the form fits its sheet, its end is its top and
 * nothing moves: on that iPhone 17 in portrait, with the keyboard down and at
 * the default text size, every sheet fits but Edit Transaction with a photo.
 *
 * Only on iOS, where the simulator measured it: on web and in the desktop
 * app the ref is attached and nothing is scrolled, so a form there that
 * overflows its window keeps its offset when the line appears, as before.
 */
export function useScrollToEndOnError(message: string | null) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  useLayoutEffect(() => {
    if (message && Platform.OS === 'ios') {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [message]);
  return scrollRef;
}

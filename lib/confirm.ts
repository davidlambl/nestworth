import { Alert, Platform, type AlertButton } from 'react-native';

/** What a confirmation asks: the same words on every platform (#37). */
export interface ConfirmOptions {
  /**
   * The native alert's title ("Delete Transaction"). The web dialog shows no
   * title: window.confirm shows the message alone, as every screen did.
   */
  title: string;
  /** The question: the native alert's message, and the whole web dialog. */
  message: string;
  /** The native button that confirms ("Delete"); on web, the browser's OK. */
  confirmText: string;
  /** The confirming button is red on iOS: the action destroys something. */
  destructive?: boolean;
  /**
   * A third native button, between Cancel and the confirming one: the
   * account delete's "Archive Instead". Pressing it runs `onPress`, and the
   * confirmation answers false. Web has no third button (window.confirm has
   * two), so the message there must say what the button would offer.
   */
  alternative?: { text: string; onPress: () => void };
}

/**
 * Asks the person to confirm an action; resolves true when they do (#37).
 *
 * On web and in Electron it is `window.confirm(message)`: react-native-web's
 * Alert.alert does nothing at all, and the e2e specs answer the browser's
 * own dialog (settings.spec.ts reads the reset's message). Elsewhere it is
 * `Alert.alert(title, message)` with Cancel first and the confirming button
 * last, as each screen wrote it; an Android dialog dismissed without a
 * button answers false. Every screen used to write both branches itself.
 */
export function confirm({
  title,
  message,
  confirmText,
  destructive = false,
  alternative,
}: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === 'web') {
    // window.confirm, never the bare name: in this module that is this
    // function. No window (a static render) is a refusal, as at the reset.
    return Promise.resolve(
      typeof window !== 'undefined' && window.confirm(message)
    );
  }
  return new Promise((resolve) => {
    const buttons: AlertButton[] = [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    ];
    if (alternative) {
      buttons.push({
        text: alternative.text,
        onPress: () => {
          alternative.onPress();
          resolve(false);
        },
      });
    }
    buttons.push(
      destructive
        ? {
            text: confirmText,
            style: 'destructive',
            onPress: () => resolve(true),
          }
        : { text: confirmText, onPress: () => resolve(true) }
    );
    Alert.alert(title, message, buttons, { onDismiss: () => resolve(false) });
  });
}

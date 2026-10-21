// confirm (#37): the one place a destructive action asks first. Every screen
// used to write `Platform.OS === 'web' ? window.confirm(...) : Alert.alert(...)`
// itself. A new module: these tests cannot load on the code before it, so
// their red proofs are the named mutants (the unit's mutant table).
//
// react-native is mocked down to the two things the module uses, as in
// promptSignOut.test.ts, so `Platform.OS` can be flipped per test and
// `Alert.alert` recorded. jest-expo's `window` is the global object, with no
// dialogs: each test that needs one installs a window.confirm.
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  Alert: { alert: jest.fn() },
}));

import { Alert, Platform } from 'react-native';
import { confirm } from '../confirm';

const mockedAlert = Alert.alert as jest.MockedFunction<typeof Alert.alert>;
type Button = { text?: string; style?: string; onPress?: () => void };

const DELETE = {
  title: 'Delete Transaction',
  message: 'Delete this transaction?',
  confirmText: 'Delete',
  destructive: true,
};

let answer: boolean;
let asked: string[];

function setOS(os: string) {
  (Platform as unknown as { OS: string }).OS = os;
}

/** The buttons of the one Alert.alert call, and its options. */
function shown(): { buttons: Button[]; options: { onDismiss?: () => void } } {
  expect(mockedAlert).toHaveBeenCalledTimes(1);
  const [, , buttons, options] = mockedAlert.mock.calls[0];
  return { buttons: buttons as Button[], options: options as any };
}

beforeEach(() => {
  jest.clearAllMocks();
  setOS('web');
  answer = true;
  asked = [];
  (window as unknown as { confirm: (m?: string) => boolean }).confirm = (m) => {
    asked.push(m ?? '');
    return answer;
  };
});

afterEach(() => {
  delete (window as unknown as { confirm?: unknown }).confirm;
});

describe('confirm on web and in Electron: window.confirm', () => {
  // The message alone, as every screen asked: settings.spec.ts reads the
  // reset's dialog message, and the e2e specs answer the browser's dialog.
  it('asks with the message alone and answers what the person chose', async () => {
    await expect(confirm(DELETE)).resolves.toBe(true);
    answer = false;
    await expect(confirm(DELETE)).resolves.toBe(false);

    expect(asked).toStrictEqual([
      'Delete this transaction?',
      'Delete this transaction?',
    ]);
    expect(mockedAlert).not.toHaveBeenCalled();
  });

  it('offers no third button: the alternative is never run', async () => {
    const archive = jest.fn();
    await expect(
      confirm({
        ...DELETE,
        alternative: { text: 'Archive Instead', onPress: archive },
      })
    ).resolves.toBe(true);

    expect(asked).toStrictEqual(['Delete this transaction?']);
    expect(archive).not.toHaveBeenCalled();
  });

  // The reset and the sign-out had this guard; a static render has no window.
  it('answers no when there is no window', async () => {
    const g = global as unknown as { window?: unknown };
    const saved = g.window;
    delete g.window;
    try {
      await expect(confirm(DELETE)).resolves.toBe(false);
    } finally {
      g.window = saved;
    }
    expect(asked).toStrictEqual([]);
  });
});

describe('confirm elsewhere: Alert.alert, Cancel first', () => {
  beforeEach(() => {
    setOS('ios');
  });

  it('shows the title, the message and the two buttons each screen wrote', () => {
    void confirm(DELETE);

    expect(mockedAlert.mock.calls).toStrictEqual([
      [
        'Delete Transaction',
        'Delete this transaction?',
        [
          { text: 'Cancel', style: 'cancel', onPress: expect.any(Function) },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: expect.any(Function),
          },
        ],
        { onDismiss: expect.any(Function) },
      ],
    ]);
    expect(asked).toStrictEqual([]);
  });

  it('answers yes from the confirming button', async () => {
    const answered = confirm(DELETE);
    shown().buttons[1].onPress?.();
    await expect(answered).resolves.toBe(true);
  });

  it('answers no from Cancel', async () => {
    const answered = confirm(DELETE);
    shown().buttons[0].onPress?.();
    await expect(answered).resolves.toBe(false);
  });

  // Android can dismiss a dialog without a button: it must not hang.
  it('answers no when the dialog is dismissed', async () => {
    const answered = confirm(DELETE);
    shown().options.onDismiss?.();
    await expect(answered).resolves.toBe(false);
  });

  // The recurring screen's Post is not destructive: no style at all, as it
  // was written.
  it('gives a button that destroys nothing no style', () => {
    void confirm({
      title: 'Post Transaction',
      message: 'Post Rent?',
      confirmText: 'Post',
    });

    expect(shown().buttons).toStrictEqual([
      { text: 'Cancel', style: 'cancel', onPress: expect.any(Function) },
      { text: 'Post', onPress: expect.any(Function) },
    ]);
  });

  // The account delete's "Archive Instead": between Cancel and Delete, as the
  // Accounts tab wrote it; it runs its own action and answers no.
  it('puts the alternative between Cancel and the confirming button', async () => {
    const archive = jest.fn();
    const answered = confirm({
      ...DELETE,
      alternative: { text: 'Archive Instead', onPress: archive },
    });

    const { buttons } = shown();
    expect(buttons.map((b) => [b.text, b.style])).toStrictEqual([
      ['Cancel', 'cancel'],
      ['Archive Instead', undefined],
      ['Delete', 'destructive'],
    ]);
    expect(buttons[1]).not.toHaveProperty('style');
    buttons[1].onPress?.();
    expect(archive).toHaveBeenCalledTimes(1);
    await expect(answered).resolves.toBe(false);
  });

  it('asks Android the same way', async () => {
    setOS('android');
    const answered = confirm(DELETE);
    expect(shown().buttons.map((b) => b.text)).toStrictEqual([
      'Cancel',
      'Delete',
    ]);
    shown().buttons[1].onPress?.();
    await expect(answered).resolves.toBe(true);
    expect(asked).toStrictEqual([]);
  });
});

// The receipt viewer's clock on iOS is light over the black on every opening
// (#251), and this pins the JavaScript order that makes it so. React Native's
// Modal notes, as it presents, the bar style on screen and the one JavaScript
// has set, and keeps the noted style while JavaScript's stays the same. A
// light style sent in the JavaScript task that first renders the Modal races
// the mount that presents it to the main thread: when it gets there first,
// the Modal notes 'light' as JavaScript's style and keeps the dark one on
// screen, a black clock on the black viewer for the whole opening -- on about
// half of the openings in the simulator. Sent from a later task, it always
// lands after that mount. No jest test can show that native race gone: the
// simulator showed it (the folded iPhone Duo and iPhone 17, light and dark,
// 29 openings of 29 white with this order), and a device shows it. What this
// pins is the order: the viewer opens with the rail off and the system's
// style, the light style comes only from a zero-delay setTimeout set by that
// first render -- never from the render, its effects or a microtask, which
// all run in the same task (in React Native, setImmediate is a microtask
// too) -- and a close that comes first clears it.
//
// The edit screen's receipt row is rendered with react-test-renderer as an
// iOS build renders it (jest-expo's preset is iOS), with fake timers standing
// for the tasks after the opening one. Three modules of the app are stubbed,
// none of React Native's: the Supabase client (receiptStorage creates it on
// import), the signed-URL hook (a photo picked on the screen reads none) and
// FormError (it waits for the app's theme provider). The outer
// SafeAreaProvider is the one expo-router's root gives the app: the viewer's
// own provider starts from its insets.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('../hooks/useReceiptUrl', () => ({
  useReceiptUrl: () => ({
    data: undefined,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));
jest.mock('../../components/FormError', () => ({
  __esModule: true,
  default: () => null,
}));

import { createElement } from 'react';
import { Platform, StatusBar as ReactNativeStatusBar } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ReceiptPreview } from '../../components/ReceiptPreview';
import Colors from '../../constants/Colors';

const THUMB = 'edit-txn-receipt-thumb';
const CLOSE = 'edit-txn-receipt-close';

/** The viewer's bar as it opens: the rail off, the system's style. */
const OPENING = {
  style: 'auto',
  animated: true,
  verticalBarBehaviorIOS: 'disabled',
};
const LIGHT = { ...OPENING, style: 'light' };

let renderer: ReactTestRenderer;
let setTimeoutSpy: jest.SpiedFunction<typeof setTimeout>;
let clearTimeoutSpy: jest.SpiedFunction<typeof clearTimeout>;

beforeEach(async () => {
  jest.useFakeTimers();
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        SafeAreaProvider,
        {
          // An iPhone 17 in portrait, as the app's root provider has it.
          initialMetrics: {
            frame: { x: 0, y: 0, width: 402, height: 874 },
            insets: { top: 62, left: 0, right: 0, bottom: 34 },
          },
        },
        createElement(ReceiptPreview, {
          localUri: 'file:///receipt.jpg',
          storedPath: null,
          testIDPrefix: 'edit-txn',
          colors: Colors.light,
          fontScale: 1,
        })
      )
    );
  });
  // From here on: the row has rendered, so these see the viewer's timers.
  setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  jest.useRealTimers();
});

/** A tap on the element with `testID`, in one task. */
async function press(testID: string) {
  const [target] = renderer.root.findAll(
    (node) =>
      node.props.testID === testID && typeof node.props.onPress === 'function'
  );
  expect(target).toBeDefined();
  await act(async () => target.props.onPress());
}

/** The tasks after this one: every timer set so far runs. */
async function laterTask() {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
}

/**
 * The props of the viewer's expo-status-bar element, and the bar style React
 * Native's StatusBar is given -- what it sends to the native side.
 */
function bars() {
  return {
    expo: renderer.root.findAllByType(StatusBar).map((bar) => bar.props),
    reactNative: renderer.root
      .findAllByType(ReactNativeStatusBar)
      .map((bar) => bar.props.barStyle),
  };
}

describe("the receipt viewer's clock on iOS (#251)", () => {
  it('opens with the rail off and the system style, and turns the clock light one task later', async () => {
    // jest-expo's preset renders as an iOS build does: the iOS viewer.
    expect(Platform.OS).toBe('ios');
    expect(bars().expo).toStrictEqual([]);

    await press(THUMB);
    // The opening task -- the render, its commit and effects, and their
    // microtasks: the rail off already, the style still the system's
    // (jest's appearance is light, so React Native is given dark text).
    // Mutants: useState(true); style="light"; 'light' : 'light';
    // setLight(true) in the effect's body or in a promise's callback -- each
    // the light style in the opening task, the race back; and the bar
    // mounted only once light, which turns the rail off a task late.
    expect(bars()).toStrictEqual({
      expo: [OPENING],
      reactNative: ['dark-content'],
    });
    // One timer, with no delay: an order, not a wait. Mutants: setImmediate
    // or queueMicrotask (both microtasks in React Native: the same task);
    // requestAnimationFrame; a delay; the effect removed.
    expect(setTimeoutSpy.mock.calls.map(([, ms]) => ms)).toStrictEqual([0]);

    await laterTask();
    // Mutant: the effect removed (the clock never light).
    expect(bars()).toStrictEqual({
      expo: [LIGHT],
      reactNative: ['light-content'],
    });
  });

  it('clears that timer when the photo closes before it runs, and every opening starts from the system style', async () => {
    await press(THUMB);
    await laterTask();
    expect(bars().expo).toStrictEqual([LIGHT]);
    await press(CLOSE);
    // Unmounted with the viewer, which gives back the style and the rail.
    expect(bars().expo).toStrictEqual([]);

    // The next opening starts from the system's style again. Mutant: the
    // light state kept outside the component mounted while the viewer is
    // visible, so a second opening is light in its opening task.
    setTimeoutSpy.mockClear();
    await press(THUMB);
    expect(bars().expo).toStrictEqual([OPENING]);
    const timers = setTimeoutSpy.mock.results.map((result) => result.value);
    expect(timers).toHaveLength(1);

    // Closed before that timer runs: the timer is cleared, and nothing is
    // left to set the style of a bar that is gone. Mutant: no cleanup.
    await press(CLOSE);
    expect(bars().expo).toStrictEqual([]);
    expect(clearTimeoutSpy.mock.calls.map(([timer]) => timer)).toContain(
      timers[0]
    );

    // The opening after that early close starts from it too.
    await laterTask();
    await press(THUMB);
    expect(bars().expo).toStrictEqual([OPENING]);
  });
});

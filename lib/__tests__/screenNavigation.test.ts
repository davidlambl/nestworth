// A press that lands twice before the first has been rendered (#242), and
// one copy of the tabs after a sign-in (found in #248's review).
//
// expo-router 58 queues router.push / router.back in React state and
// dispatches them a render later, so two presses inside one render opened a
// screen twice (one Back more to leave it, the lower copy hidden) and two
// presses of a sheet's Cancel -- or a Cancel and a save that finished after
// it -- closed the register under the sheet too; and the sign-in's
// router.replace left a second copy of the tabs over the first wherever the
// tabs were below it. lib/screenNavigation.ts opens a screen with
// the router's NAVIGATE, closes one with a back addressed from the screen to
// its own Stack, and returns to the tabs with a dismiss; these tests run them
// through expo-router's own root, routing queue, Stack and JS tabs
// (react-test-renderer, iOS -- the preset's platform), in a small app with
// the real app's shape: the tabs (the root Stack's anchor, as in
// app/_layout.tsx), the sign-in, a register, a sheet.
//
// Red proofs: on the tree before #242 this suite does not load (no
// lib/screenNavigation); its production expressions' mutants -- openScreen
// as router.push, closeScreen as router.back() or without its target,
// returnToTabs as router.replace('/') -- fail the RED tests below. The PINs
// are green with the old calls too and say what they pin. The source pins at
// the end hold every press under app/ to the module.

// expo-router's jest mocks (reanimated, worklets, expo-linking) before the
// router loads.
import 'expo-router/build/testing-library/mocks';

import fs from 'fs';
import path from 'path';
import { createElement, useEffect } from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ExpoRoot, Stack, router, useNavigation } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { getMockContext } from 'expo-router/build/testing-library/mock-config';
import { navigationRef } from 'expo-router/build/global-state/navigationRef';

import {
  closeScreen,
  openScreen,
  returnToTabs,
  type ClosingScreen,
} from '../screenNavigation';

// The sheet's own navigation, as its Cancel gets it (useNavigation()).
const screens: { sheet?: ClosingScreen } = {};

function Accounts() {
  return createElement(Text, null, 'Accounts');
}
function Register() {
  return createElement(Text, null, 'Register');
}
function Sheet() {
  const navigation = useNavigation();
  useEffect(() => {
    screens.sheet = navigation;
  }, [navigation]);
  return createElement(Text, null, 'New Transaction');
}

// The app's shape: the root Stack over the tabs and the sign-in screens, a
// register pushed from a card, a sheet presented from the register.
const app = {
  _layout: {
    default: () =>
      createElement(
        Stack,
        null,
        createElement(Stack.Screen, { name: '(tabs)' }),
        createElement(Stack.Screen, { name: '(auth)' }),
        createElement(Stack.Screen, {
          name: 'transaction/new',
          options: { presentation: 'modal' },
        })
      ),
    // app/_layout.tsx's: the tabs stay under a screen a launch opens first.
    unstable_settings: { anchor: '(tabs)' },
  },
  '(tabs)/_layout': () =>
    createElement(
      Tabs,
      null,
      createElement(Tabs.Screen, { name: 'index' }),
      createElement(Tabs.Screen, { name: 'reports' })
    ),
  '(tabs)/index': Accounts,
  '(tabs)/reports': () => createElement(Text, null, 'Reports'),
  '(auth)/_layout': () =>
    createElement(Stack, { screenOptions: { headerShown: false } }),
  '(auth)/sign-in': () => createElement(Text, null, 'Sign in'),
  'account/[id]': Register,
  'transaction/new': Sheet,
};

const mounted: ReactTestRenderer[] = [];

function unmountApp() {
  while (mounted.length) {
    const r = mounted.pop()!;
    act(() => r.unmount());
  }
}

/** Launches the app at `location` (a cold start: a link, a typed URL). */
function launchAt(location: string) {
  unmountApp();
  delete screens.sheet;
  act(() => {
    mounted.push(
      TestRenderer.create(
        createElement(ExpoRoot, {
          context: getMockContext(app as never),
          location,
        })
      )
    );
  });
  act(() => {
    jest.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_ROUTER_IMPORT_MODE = 'sync';
  launchAt('/');
});

afterEach(() => {
  unmountApp();
  jest.useRealTimers();
});

type StackState = {
  key: string;
  index: number;
  routes: { name: string; key: string; params?: object; state?: StackState }[];
};

/** The root Stack (expo-router 58 holds it under its own `__root` route). */
function rootStack(): StackState {
  let state = navigationRef.getRootState() as unknown as StackState;
  while (state.routes[state.index]?.name === '__root') {
    state = state.routes[state.index].state!;
  }
  return state;
}

/** The screens a Back walks through, bottom first: name and params. */
function screensShown(): string[] {
  const state = rootStack();
  return state.routes.slice(0, state.index + 1).map((route) =>
    route.name.startsWith('(')
      ? route.name // a group: its navigator's own state says where it is
      : [route.name, ...Object.values(route.params ?? {})].join(' ')
  );
}

/** The tab shown by the tabs on top of the root Stack. */
function tabShown(): string {
  const state = rootStack();
  const tabs = state.routes[state.index].state!;
  return tabs.routes[tabs.index].name;
}

function topKey(): string {
  const state = rootStack();
  return state.routes[state.index].key;
}

function openSheetOverRegister() {
  act(() => openScreen('/account/A'));
  act(() => openScreen('/transaction/new?accountId=A'));
  expect(screensShown()).toStrictEqual([
    '(tabs)',
    'account/[id] A',
    'transaction/new A',
  ]);
}

describe('the harness sees the mechanism #242 found (PINs: expo-router 58)', () => {
  // If one of these fails after an upgrade, expo-router has changed how it
  // queues navigations: re-measure before relying on the guard's reasons.
  it('two router.push inside one render open the register twice', () => {
    act(() => {
      router.push('/account/A');
      router.push('/account/A');
    });
    expect(screensShown()).toStrictEqual([
      '(tabs)',
      'account/[id] A',
      'account/[id] A',
    ]);
  });

  it('two router.back() inside one render close the register under the sheet too', () => {
    openSheetOverRegister();
    act(() => {
      router.back();
      router.back();
    });
    expect(screensShown()).toStrictEqual(['(tabs)']);
  });

  it('a router.back() after the sheet has closed closes the register under it', () => {
    // A save that finishes after its sheet's Cancel (New Transaction's photo
    // upload runs after the mutation has settled, its Save enabled again).
    openSheetOverRegister();
    act(() => closeScreen(screens.sheet!));
    act(() => router.back());
    expect(screensShown()).toStrictEqual(['(tabs)']);
  });
});

describe('openScreen (#242)', () => {
  it('a card pressed twice inside one render opens the register once: one Back returns to the Accounts tab', () => {
    act(() => {
      openScreen('/account/A');
      openScreen('/account/A');
    });
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
    act(() => router.back());
    expect(screensShown()).toStrictEqual(['(tabs)']);
  });

  it('a second press after the first has landed opens nothing more', () => {
    // On a device the card stays under the finger until the register covers
    // it, after the navigation has been rendered.
    act(() => openScreen('/account/A'));
    const register = topKey();
    act(() => openScreen('/account/A'));
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
    expect(topKey()).toBe(register);
  });

  it("the register's + pressed twice opens one New Transaction", () => {
    act(() => openScreen('/account/A'));
    act(() => {
      openScreen('/transaction/new?accountId=A');
      openScreen('/transaction/new?accountId=A');
    });
    expect(screensShown()).toStrictEqual([
      '(tabs)',
      'account/[id] A',
      'transaction/new A',
    ]);
  });

  it("another account's register is still opened on top (PIN: router.push too)", () => {
    // Kills a guard that would drop any press while a navigation is pending.
    act(() => {
      openScreen('/account/A');
      openScreen('/account/B');
    });
    expect(screensShown()).toStrictEqual([
      '(tabs)',
      'account/[id] A',
      'account/[id] B',
    ]);
  });

  it('a press after Back opens the screen afresh (PIN: router.push too)', () => {
    // Kills a guard that would remember a screen it has opened.
    act(() => openScreen('/account/A'));
    const first = topKey();
    act(() => {
      router.back();
      openScreen('/account/A');
    });
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
    expect(topKey()).not.toBe(first);
  });

  it('a screen lower in the stack is opened again on top, as router.push did (PIN)', () => {
    // Kills a dedupe across the whole stack (dangerouslySingular), which
    // would move the lower register up instead.
    act(() => openScreen('/account/A'));
    act(() => openScreen('/account/B'));
    act(() => openScreen('/account/A'));
    expect(screensShown()).toStrictEqual([
      '(tabs)',
      'account/[id] A',
      'account/[id] B',
      'account/[id] A',
    ]);
  });

  it('switches tabs from the sidebar as router.push did (PIN)', () => {
    act(() => openScreen('/reports'));
    expect(screensShown()).toStrictEqual(['(tabs)']);
    expect(tabShown()).toBe('reports');
  });
});

describe('closeScreen (#242)', () => {
  it('closes the sheet it is pressed on (PIN: router.back() too)', () => {
    openSheetOverRegister();
    act(() => closeScreen(screens.sheet!));
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
  });

  it('Cancel pressed twice inside one render closes the sheet, not the register under it', () => {
    openSheetOverRegister();
    const sheet = screens.sheet!;
    act(() => {
      closeScreen(sheet);
      closeScreen(sheet);
    });
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
  });

  it('Cancel pressed again while the sheet is going away closes nothing more', () => {
    // And a save that finishes after Cancel: every save closes its screen
    // with closeScreen too.
    openSheetOverRegister();
    const sheet = screens.sheet!;
    act(() => closeScreen(sheet));
    act(() => closeScreen(sheet));
    expect(screensShown()).toStrictEqual(['(tabs)', 'account/[id] A']);
  });

  it('Cancel pressed twice on a sheet over a tab other than the first keeps that tab', () => {
    // Import, opened from Settings: a second back that reached the tabs
    // switched them to the first.
    act(() => openScreen('/reports'));
    act(() => openScreen('/transaction/new?accountId=A'));
    expect(screensShown()).toStrictEqual(['(tabs)', 'transaction/new A']);
    const sheet = screens.sheet!;
    act(() => {
      closeScreen(sheet);
      closeScreen(sheet);
    });
    act(() => closeScreen(sheet));
    expect(screensShown()).toStrictEqual(['(tabs)']);
    expect(tabShown()).toBe('reports');
  });
});

describe("returnToTabs (#242; found in #248's review)", () => {
  it('a sign-in reached by a link over the tabs returns to them: one copy of the tabs', () => {
    act(() => openScreen('/account/A'));
    const tabs = rootStack().routes[0].key;
    // A link to the sign-in screen while signed in opens it over the tabs.
    act(() => router.navigate('/sign-in'));
    expect(screensShown()).toStrictEqual([
      '(tabs)',
      'account/[id] A',
      '(auth)',
    ]);
    act(() => returnToTabs());
    expect(screensShown()).toStrictEqual(['(tabs)']);
    expect(rootStack().routes[0].key).toBe(tabs);
  });

  it('a launch at the sign-in screen leaves one copy of the tabs', () => {
    // The root Stack's anchor puts the tabs under a screen a launch opens
    // first (a web load of /sign-in, a link to it).
    launchAt('/sign-in');
    expect(screensShown()).toStrictEqual(['(tabs)', '(auth)']);
    const tabs = rootStack().routes[0].key;
    act(() => returnToTabs());
    expect(screensShown()).toStrictEqual(['(tabs)']);
    expect(rootStack().routes[0].key).toBe(tabs);
  });

  it('the signed-out redirect over a register leaves one copy of the tabs', () => {
    act(() => openScreen('/account/A'));
    act(() => router.replace('/sign-in'));
    expect(screensShown()).toStrictEqual(['(tabs)', '(auth)']);
    act(() => returnToTabs());
    expect(screensShown()).toStrictEqual(['(tabs)']);
  });

  it("after the signed-out redirect from the tabs they take the sign-in screen's place (PIN: router.replace too)", () => {
    act(() => router.replace('/sign-in'));
    expect(screensShown()).toStrictEqual(['(auth)']);
    act(() => returnToTabs());
    expect(screensShown()).toStrictEqual(['(tabs)']);
  });

  it('lands on the Accounts tab (PIN: router.replace too)', () => {
    act(() => openScreen('/reports'));
    act(() => router.navigate('/sign-in'));
    act(() => returnToTabs());
    expect(tabShown()).toBe('index');
  });
});

describe('every press under app/ goes through lib/screenNavigation.ts (#242)', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const filesUnder = (dir: string): string[] =>
    fs
      .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(file) : [file];
      });
  const sources = ['app', 'components', 'lib']
    .flatMap((dir) => filesUnder(dir))
    .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'));
  const count = (pattern: RegExp) =>
    Object.fromEntries(
      sources
        .map((file) => [file, read(file).match(pattern)?.length ?? 0])
        .filter(([, n]) => n)
    );

  it('nothing opens a screen with push or navigate but openScreen', () => {
    // router.push / router.navigate, and react-navigation's own
    // navigation.push / navigation.navigate (a React state update too).
    expect(
      count(/\b(?:router|navigation)\.(?:push|navigate)\(/g)
    ).toStrictEqual({
      'lib/screenNavigation.ts': 1,
    });
  });

  it('every screen that opens another from a press calls openScreen', () => {
    expect(count(/\bopenScreen\(/g)).toStrictEqual({
      'app/(tabs)/(home)/index.tsx': 2, // an account card, All Accounts
      'app/(tabs)/(settings)/settings.tsx': 3, // Recurring, Import, Unsynced
      'app/(tabs)/_layout.tsx': 1, // the sidebar (web, desktop)
      'app/account/[id].tsx': 3, // transfer, +, a row
      'app/account/all.tsx': 1, // a row
      'app/recurring/index.tsx': 1, // +
      'app/unsynced.tsx': 1, // Edit
      'lib/screenNavigation.ts': 1, // its own definition
    });
  });

  it("a sheet's Cancel, Import's Done and every finished save close their screen with closeScreen", () => {
    expect(count(/\bcloseScreen\(navigation\)/g)).toStrictEqual({
      'app/import.tsx': 2, // Cancel, Done
      'app/recurring/new.tsx': 2, // Cancel, saved
      'app/transaction/[id].tsx': 3, // Cancel, saved, deleted
      'app/transaction/new.tsx': 2, // Cancel, saved
      'app/transaction/transfer.tsx': 2, // Cancel, saved
    });
  });

  it('the sign-in returns to the tabs with returnToTabs', () => {
    expect(count(/\breturnToTabs\(/g)).toStrictEqual({
      'app/(auth)/sign-in.tsx': 1,
      'lib/screenNavigation.ts': 1, // its own definition
    });
  });

  it('router.replace is left to the sign-out redirects and the accounts panel', () => {
    expect(count(/\brouter\.replace\(/g)).toStrictEqual({
      'app/(auth)/sign-up.tsx': 1, // "Go to Sign In"
      'app/(tabs)/(settings)/settings.tsx': 1, // after a sign-out
      'app/(tabs)/_layout.tsx': 1, // the signed-out redirect
      'components/AccountsPanel.tsx': 2, // another account's register in place
      'components/Sidebar.tsx': 1, // after a sign-out
    });
  });

  it('nothing calls router.back()', () => {
    // A save's close as well as a press's: New Transaction's Save is enabled
    // again while its photo uploads (the mutation has settled), so a second
    // save, or one that finishes after Cancel, closed the register under it.
    expect(count(/\brouter\.back\(\)/g)).toStrictEqual({});
  });
});

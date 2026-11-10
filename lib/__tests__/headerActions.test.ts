// The header buttons (#249): native items on iOS, so that iPhone Duo's rail
// can hold them when it is folded (the system leaves a view an app draws in
// the horizontal bar); on web, in the desktop app and on Android the views
// the app draws, with the testIDs the Playwright specs press.
//
// Jest resolves a module for iOS (the preset's default platform), as Metro
// does on an iPhone: '@/components/HeaderActions' here is
// HeaderActions.ios.tsx, what every screen gets on iOS. The items are data
// and are read as data; what the system draws with them -- the rail, the
// glass, the tint -- is checked in the simulator and on the device.
import fs from 'fs';
import path from 'path';

import {
  accountsButtons,
  registerButtons,
  sheetCancel,
} from '@/components/HeaderActions';
import { SyncStatusHeaderButton } from '@/components/SyncStatusControls';
import Colors from '@/constants/Colors';

// The sync dot reads the sync engine's state; here it is only an element.
jest.mock('@/components/SyncStatusControls', () => ({
  SyncStatusHeaderButton: function SyncStatusHeaderButton() {
    return null;
  },
}));

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(file) : [file];
    });
}

const colors = { tint: '#15803d' };
// What react-navigation passes the items' function (NativeStackHeaderItemProps).
const headerProps = { tintColor: '#15803d', canGoBack: false };

type Item = {
  type: string;
  label?: string;
  accessibilityLabel?: string;
  icon?: { type: string; name?: string };
  tintColor?: string;
  onPress?: () => void;
  element?: { type: unknown };
};

/** What VoiceOver reads, Maestro taps and the rail shows of each item. */
function shown(items: Item[]) {
  return items.map((item) =>
    item.type === 'button'
      ? {
          label: item.label,
          accessibilityLabel: item.accessibilityLabel,
          icon: item.icon,
        }
      : { type: item.type }
  );
}

const sf = (name: string) => ({ type: 'sfSymbol', name });

/** Every item of the three, built with the given colours. */
function allItems(colors: { tint: string }): Item[] {
  const noop = () => {};
  return [
    ...sheetCancel(noop, colors).unstable_headerLeftItems!(headerProps),
    ...registerButtons({
      canAdd: true,
      onTransfer: noop,
      onAdd: noop,
      colors,
    }).unstable_headerRightItems!(headerProps),
    ...accountsButtons({
      showSync: true,
      onAdd: noop,
      colors,
    }).unstable_headerRightItems!(headerProps),
  ] as Item[];
}

/** Every label an iOS item carries, from the items themselves. */
function itemLabels(): string[] {
  return allItems(colors).flatMap((item) =>
    item.type === 'button' ? [item.label!] : []
  );
}

describe('the header buttons on iOS are native items (#249)', () => {
  it("the sheets' Cancel is the close symbol, read and tapped as Cancel", () => {
    const onCancel = jest.fn();
    const options = sheetCancel(onCancel, colors);
    // Items, and no view of the app's own: the rail holds an item with an icon.
    expect(Object.keys(options)).toStrictEqual(['unstable_headerLeftItems']);
    const items = options.unstable_headerLeftItems!(headerProps) as Item[];
    expect(shown(items)).toStrictEqual([
      { label: 'Cancel', accessibilityLabel: 'Cancel', icon: sf('xmark') },
    ]);
    items[0].onPress!();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the register's transfer and + are New transfer and New transaction, in that order", () => {
    const onTransfer = jest.fn();
    const onAdd = jest.fn();
    const options = registerButtons({
      canAdd: true,
      onTransfer,
      onAdd,
      colors,
    });
    expect(Object.keys(options)).toStrictEqual(['unstable_headerRightItems']);
    const items = options.unstable_headerRightItems!(headerProps) as Item[];
    expect(shown(items)).toStrictEqual([
      {
        label: 'New transfer',
        accessibilityLabel: 'New transfer',
        icon: sf('arrow.left.arrow.right'),
      },
      {
        label: 'New transaction',
        accessibilityLabel: 'New transaction',
        icon: sf('plus'),
      },
    ]);
    items[0].onPress!();
    expect(onTransfer).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    items[1].onPress!();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('the register offers neither where it cannot add (archived, gone, not read yet)', () => {
    const options = registerButtons({
      canAdd: false,
      onTransfer: jest.fn(),
      onAdd: jest.fn(),
      colors,
    });
    expect(options.unstable_headerRightItems!(headerProps)).toStrictEqual([]);
  });

  it("the Accounts tab's + is New account, after the sync dot the app draws", () => {
    const onAdd = jest.fn();
    const items = accountsButtons({
      showSync: true,
      onAdd,
      colors,
    }).unstable_headerRightItems!(headerProps) as Item[];
    // The dot stays a view of the app's own: its colour is the sync's state,
    // a spinner shows a sync running, and its label says the state, then what
    // pressing does (lib/syncStatusHelpers.ts) -- an item's symbol cannot.
    expect(shown(items)).toStrictEqual([
      { type: 'custom' },
      {
        label: 'New account',
        accessibilityLabel: 'New account',
        icon: sf('plus'),
      },
    ]);
    expect(items[0].element?.type).toBe(SyncStatusHeaderButton);
    items[1].onPress!();
    expect(onAdd).toHaveBeenCalledTimes(1);
    // Where the drawn sidebar shows the status (web and the desktop app from
    // 768, never iOS: lib/layout.ts hasDrawnSidebar), "+" alone.
    expect(
      shown(
        accountsButtons({
          showSync: false,
          onAdd,
          colors,
        }).unstable_headerRightItems!(headerProps) as Item[]
      )
    ).toStrictEqual([
      {
        label: 'New account',
        accessibilityLabel: 'New account',
        icon: sf('plus'),
      },
    ]);
  });
});

describe("the items take the app's tint (#249)", () => {
  it("every item is drawn in the app's tint, light and dark", () => {
    // On iOS 26 the system draws a bar's items in the label colour (black in
    // light mode, white in dark) unless an item has a tint of its own: the
    // bar's tint, the navigation theme's primary, does not reach them
    // (measured in the simulator). So each item carries the app's tint,
    // which the screens pass as `colors` for the app's appearance.
    for (const scheme of ['light', 'dark'] as const) {
      const tint = Colors[scheme].tint;
      const buttons = allItems({ tint }).filter(
        (item) => item.type === 'button'
      );
      expect(buttons.map((item) => [item.label, item.tintColor])).toStrictEqual(
        [
          ['Cancel', tint],
          ['New transfer', tint],
          ['New transaction', tint],
          ['New account', tint],
        ]
      );
    }
    expect(Colors.light.tint).not.toBe(Colors.dark.tint);
  });
});

describe('the screens take their header buttons from components/HeaderActions (#249)', () => {
  it('no screen under app/ draws a header button of its own', () => {
    // A headerLeft or headerRight set in a screen would be a view the app
    // draws on iOS too, which the rail does not hold; the platform split is
    // components/HeaderActions(.ios).tsx. On iOS the views the system keeps
    // in the horizontal bar are named: the Accounts tab's title view
    // (components/TabStack.ios.tsx, #248) and the sync dot (below).
    const found = filesUnder('app')
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) =>
        [
          ...read(file).matchAll(
            /\b(?:headerLeft|headerRight|unstable_header(?:Left|Right)Items)\s*:|<Stack\.Toolbar\b/g
          ),
        ].map((match) => `${file}: ${match[0]}`)
      );
    expect(found).toStrictEqual([]);
  });

  it('every sheet shows Cancel, the register and the Accounts tab their buttons', () => {
    // The sheets are the root Stack's modal screens (app/_layout.tsx): one
    // added there without its Cancel fails here.
    const sheets = [
      ...read('app/_layout.tsx').matchAll(
        /name="([^"]+)"\s*options=\{\{[^}]*presentation: 'modal'/g
      ),
    ].map((match) => `app/${match[1]}.tsx`);
    expect(sheets.sort()).toStrictEqual([
      'app/import.tsx',
      'app/recurring/new.tsx',
      'app/transaction/[id].tsx',
      'app/transaction/new.tsx',
      'app/transaction/transfer.tsx',
    ]);
    for (const sheet of sheets) {
      // Cancel closes the sheet it is on, once (#242: lib/screenNavigation.ts).
      expect(read(sheet)).toContain(
        'navigation.setOptions(sheetCancel(() => closeScreen(navigation), colors));'
      );
    }
    // The screen's own colors reach the items (the dark tint in dark mode):
    // the call ends with the shorthand `colors`, inside the same call.
    expect(read('app/account/[id].tsx')).toMatch(
      /\.\.\.registerButtons\(\{\s*canAdd,(?:(?!\}\))[\s\S])*\scolors,\s*\}\)/
    );
    expect(read('app/(tabs)/(home)/index.tsx')).toMatch(
      /navigation\.setOptions\(\s*accountsButtons\(\{\s*showSync: showSyncInHeader,(?:(?!\}\))[\s\S])*\scolors,\s*\}\)/
    );
  });

  it('on iOS the only view of the header buttons the app draws is the sync dot', () => {
    // Named exceptions: the drawn buttons are web's, the desktop app's and
    // Android's (components/HeaderActions.tsx, which Metro never resolves on
    // iOS beside its .ios sibling); on iOS the one custom item is the dot.
    const drawnViews = ['app', 'components', 'lib']
      .flatMap((dir) => filesUnder(dir))
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'))
      .filter((file) => /\b(?:headerLeft|headerRight)\s*:/.test(read(file)));
    expect(drawnViews).toStrictEqual(['components/HeaderActions.tsx']);
    const ios = read('components/HeaderActions.ios.tsx');
    expect(ios.match(/type: 'custom'/g)).toHaveLength(1);
    expect(ios).toContain(
      "{ type: 'custom' as const, element: <SyncStatusHeaderButton /> }"
    );
  });
});

describe('web, the desktop app and Android keep the drawn buttons (#249)', () => {
  it('keeps the testIDs the Playwright specs press, once each, and the labels', () => {
    const drawn = read('components/HeaderActions.tsx');
    const pressed = new Set(
      filesUnder('e2e/web')
        .filter((file) => file.endsWith('.ts'))
        .flatMap((file) => [
          ...read(file).matchAll(
            /getByTestId\('((?:accounts-add|register-add|register-transfer)-btn)'\)/g
          ),
        ])
        .map((match) => match[1])
    );
    expect([...pressed].sort()).toStrictEqual([
      'accounts-add-btn',
      'register-add-btn',
      'register-transfer-btn',
    ]);
    for (const id of pressed) {
      expect(drawn.split(`testID="${id}"`)).toHaveLength(2);
    }
    for (const label of ['New account', 'New transaction', 'New transfer']) {
      expect(drawn).toContain(`accessibilityLabel="${label}"`);
    }
    // payee-suggestions.spec.ts presses the sheet's Cancel by its text.
    expect(drawn).toContain('>Cancel</Text>');
  });

  it('keeps the SF Symbols out of the web bundle', () => {
    // Metro resolves an .ios.tsx module on iOS alone; nothing else may carry
    // an item's symbol (measured: none reaches the web export).
    const carriers = ['app', 'components', 'lib']
      .flatMap((dir) => filesUnder(dir))
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'))
      .filter((file) =>
        /'sfSymbol'|'xmark'|'arrow\.left\.arrow\.right'/.test(read(file))
      )
      .sort();
    expect(carriers).toStrictEqual(['components/HeaderActions.ios.tsx']);
    // Reached through '@/components/HeaderActions' alone, which Metro
    // resolves per platform; an import of the .ios file by its own name
    // would put it in the web bundle.
    expect(
      ['app', 'components', 'lib']
        .flatMap((dir) => filesUnder(dir))
        .filter((file) => !file.includes('__tests__'))
        .filter((file) =>
          /(?:from|require\()\s*'[^']*HeaderActions\.ios/.test(read(file))
        )
    ).toStrictEqual([]);
  });
});

describe('Maestro taps the header buttons by their labels (#249)', () => {
  const flows = filesUnder('e2e/mobile')
    .filter((file) => file.endsWith('.yaml'))
    .map(read)
    .join('\n');

  it('taps none by the testIDs the native items do not carry', () => {
    expect(flows).not.toMatch(
      /accounts-add-btn|register-add-btn|register-transfer-btn/
    );
  });

  it('taps each by a label an iOS item carries', () => {
    // On iOS Maestro's `text` matches an element's accessibility label
    // (whole, ignoring case); a label changed here without the flows, or the
    // flows without the items, fails.
    const tapped = new Set(
      [...flows.matchAll(/(?:tapOn:|text:)\s*'(New [a-z]+)'/g)].map(
        (match) => match[1]
      )
    );
    expect([...tapped].sort()).toStrictEqual([
      'New account',
      'New transaction',
      'New transfer',
    ]);
    const labels = itemLabels();
    for (const label of [...tapped, 'Cancel']) {
      expect(labels).toContain(label);
    }
  });
});

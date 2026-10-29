import fs from 'fs';
import path from 'path';

import { APP_TABS, tabForPath } from '../tabs';

const ROOT = path.resolve(__dirname, '../..');

describe('APP_TABS (#210)', () => {
  it('names every route under app/(tabs)/, in the tab bar order', () => {
    // PIN: a tab added, renamed or dropped in app/(tabs)/ without this list
    // would leave the tab bar and the sidebar disagreeing with the routes.
    const routes = fs
      .readdirSync(path.join(ROOT, 'app/(tabs)'))
      .filter((file) => file.endsWith('.tsx') && !file.startsWith('_'))
      .map((file) => file.replace(/\.tsx$/, ''));
    expect(APP_TABS.map((tab) => tab.name)).toStrictEqual([
      'index',
      'reports',
      'settings',
    ]);
    expect([...routes].sort()).toStrictEqual(
      APP_TABS.map((tab) => tab.name).sort()
    );
  });

  it('keeps the labels and testIDs the end-to-end flows read', () => {
    // PIN: the web specs wait for the text "Accounts" and the Maestro flows
    // tap "Settings"; Maestro taps the tab bar buttons by these testIDs.
    expect(APP_TABS.map((tab) => tab.title)).toStrictEqual([
      'Accounts',
      'Reports',
      'Settings',
    ]);
    expect(APP_TABS.map((tab) => tab.testID)).toStrictEqual([
      'tab-accounts',
      'tab-reports',
      'tab-settings',
    ]);
  });

  it('has a tab for every tab button a Maestro flow taps', () => {
    // PIN: read from the flows themselves, so a renamed testID fails here
    // rather than on a device.
    const flowsDir = path.join(ROOT, 'e2e/mobile/flows');
    const tapped = new Set(
      fs
        .readdirSync(flowsDir)
        .filter((file) => file.endsWith('.yaml'))
        .flatMap((file) =>
          [
            ...fs
              .readFileSync(path.join(flowsDir, file), 'utf8')
              .matchAll(/id:\s*'(tab-[a-z-]+)'/g),
          ].map((match) => match[1])
        )
    );
    expect([...tapped].sort()).toStrictEqual(['tab-accounts', 'tab-settings']);
    for (const id of tapped) {
      expect(APP_TABS.map((tab) => tab.testID)).toContain(id);
    }
  });
});

describe('tabForPath (#210)', () => {
  it("finds each tab's own path", () => {
    expect(tabForPath('/')).toBe('index');
    expect(tabForPath('/reports')).toBe('reports');
    expect(tabForPath('/settings')).toBe('settings');
  });

  it('counts any other path as the Accounts tab', () => {
    expect(tabForPath('/account/all')).toBe('index');
    expect(tabForPath('/account/0b6f8a52-3c1d-4e2f-9a7b-5c4d3e2f1a0b')).toBe(
      'index'
    );
    expect(tabForPath('/recurring')).toBe('index');
    expect(tabForPath('/reports/anything')).toBe('index');
  });
});

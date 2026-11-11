// One save per accepted press (lib/saveOnce.ts): the latch every form that
// writes a new record from a press goes through. A second tap on Save made a
// second transaction -- while New Transaction's photo uploaded (the button
// was on again), and on every form when two taps reached the app in one beat
// (a button turned off on isPending or on a state flag is not yet rendered
// for the second). saveOnceForms.test.ts presses the forms themselves.
//
// Red proofs: on the tree before this suite does not load (no
// lib/saveOnce); each test names the mutant of saveOnce or reopenSave it
// fails, and the forms' suite is red on the code before. The source pins at
// the end hold the forms to the hook.

import fs from 'fs';
import path from 'path';

import {
  reopenSave,
  saveOnce,
  type SaveLatch,
  type SaveState,
} from '../saveOnce';

function latch(state: SaveState = 'idle'): SaveLatch {
  return { current: state };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('saveOnce', () => {
  it('a press while a save runs does nothing: the save runs once', async () => {
    // Mutants: no idle check; the latch set only once the save has answered.
    const form = latch();
    const stored = deferred<boolean>();
    const save = jest.fn(() => stored.promise);

    const first = saveOnce(form, save);
    const second = saveOnce(form, save); // the same beat: nothing awaited
    stored.resolve(true);
    await Promise.all([first, second]);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('the press sets the latch before the save starts', () => {
    // Mutant: the latch set after save() is called (a save that refuses at
    // once would otherwise be the only thing between two presses).
    const form = latch();
    let seen: SaveState | null = null;
    void saveOnce(form, async () => {
      seen = form.current;
      return true;
    });

    expect(seen).toBe('saving');
  });

  it('a save that stored its record keeps the latch: a later press does nothing', async () => {
    // Mutant: the latch freed whatever the save answered.
    const form = latch();
    const save = jest.fn(async () => true);

    await saveOnce(form, save);
    await saveOnce(form, save);

    expect(save).toHaveBeenCalledTimes(1);
    expect(form.current).toBe('saved');
  });

  it('a refused save frees the latch: the next press saves', async () => {
    // Mutant: the latch kept whatever the save answered (a form that said
    // "Please enter a valid amount." would never save again).
    const form = latch();
    const save = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await saveOnce(form, save);
    expect(form.current).toBe('idle');
    await saveOnce(form, save);

    expect(save).toHaveBeenCalledTimes(2);
    expect(form.current).toBe('saved');
  });

  it('a save that throws frees the latch, and the error goes on to its caller', async () => {
    // Mutants: the latch left set (the form dead), the error swallowed.
    const form = latch();
    const failure = new Error('disk I/O error');

    await expect(
      saveOnce(form, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(form.current).toBe('idle');
  });

  it('says every state the latch takes, and nothing for a press it refuses', async () => {
    // What the hook renders: busy from the press, off again after a refusal,
    // on for good after a save.
    const form = latch();
    const heard: SaveState[] = [];
    const listen = (state: SaveState) => heard.push(state);

    await saveOnce(form, async () => false, listen);
    await saveOnce(form, async () => true, listen);
    await saveOnce(form, async () => true, listen);

    expect(heard).toStrictEqual(['saving', 'idle', 'saving', 'saved']);
  });
});

describe('reopenSave', () => {
  it('frees a save that has finished: the form shown again saves', async () => {
    // Mutant: reopenSave doing nothing (New Account's second account in a
    // row could not be created).
    const form = latch();
    const save = jest.fn(async () => true);
    const heard: SaveState[] = [];

    await saveOnce(form, save);
    reopenSave(form, (state) => heard.push(state));
    await saveOnce(form, save);

    expect(save).toHaveBeenCalledTimes(2);
    expect(heard).toStrictEqual(['idle']);
  });

  it('keeps a save that still runs: a press while it waits does nothing', async () => {
    // Mutant: reopenSave freeing the latch whatever its state. A create made
    // offline waits for the network; New Account's sheet shown again meanwhile
    // must not create a second account beside it.
    const form = latch();
    const stored = deferred<boolean>();
    const save = jest.fn(() => stored.promise);
    const heard: SaveState[] = [];

    const first = saveOnce(form, save);
    reopenSave(form, (state) => heard.push(state));
    await saveOnce(form, save);
    stored.resolve(true);
    await first;

    expect(save).toHaveBeenCalledTimes(1);
    expect(heard).toStrictEqual([]);
    expect(form.current).toBe('saved');
  });
});

describe('every form that writes a new record from a press goes through useSaveOnce (source pins)', () => {
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
  const filesMatching = (pattern: RegExp) =>
    sources.filter((file) => pattern.test(read(file)));

  it('the five forms each hold one', () => {
    expect(
      Object.fromEntries(
        sources
          .map((file) => [file, read(file).match(/\buseSaveOnce\(/g)?.length])
          .filter(([, n]) => n)
      )
    ).toStrictEqual({
      'app/(tabs)/(home)/index.tsx': 1, // New Account
      'app/import.tsx': 1,
      'app/recurring/new.tsx': 1,
      'app/transaction/new.tsx': 1,
      'app/transaction/transfer.tsx': 1,
      'lib/hooks/useSaveOnce.ts': 1, // its own definition
    });
  });

  it('a screen that creates through a useCreate… hook holds useSaveOnce too', () => {
    // A new creating form fails here until its save goes through the hook.
    // The recurring post (usePost…) is not a form: its writer finds an
    // occurrence already posted and posts it once (#154).
    const creating = filesMatching(/\buseCreate\w*\(/).filter((file) =>
      file.startsWith('app/')
    );
    const holding = filesMatching(/\buseSaveOnce\(/);

    expect(creating.filter((file) => !holding.includes(file))).toStrictEqual(
      []
    );
    expect(creating).toHaveLength(4);
  });
});

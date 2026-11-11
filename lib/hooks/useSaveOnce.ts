import { useCallback, useRef, useState } from 'react';
import { reopenSave, saveOnce, type SaveState } from '../saveOnce';

/**
 * A form's save, once per accepted press (lib/saveOnce.ts), and what its
 * button shows.
 *
 * `run(save)` is the press: it does nothing while a save runs or after one
 * has stored its record, and otherwise runs `save`, which answers true once
 * the record is stored and the screen closed (or the sheet hidden), false
 * when it refused. `busy` is true from the accepted press until the save is
 * refused, or for good once it has saved: the button's `disabled` and its
 * spinner, which now cover the whole save -- New Transaction's photo upload
 * and its close included. `reopen()` frees a finished save when the form is
 * shown again for a new record (New Account's sheet).
 *
 * A `save` that throws frees the latch as well, but the error rejects `run`'s
 * promise, which a form's press does not await: an unhandled rejection. So
 * `save` says its own failures and answers false; it must not throw.
 *
 * The latch is a ref, set by the press before anything is awaited; `busy` is
 * its rendered copy, which a second press of the same beat would not see yet.
 */
export function useSaveOnce(): {
  busy: boolean;
  run: (save: () => Promise<boolean>) => Promise<void>;
  reopen: () => void;
} {
  const latch = useRef<SaveState>('idle');
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    (save: () => Promise<boolean>) =>
      saveOnce(latch, save, (state) => setBusy(state !== 'idle')),
    []
  );
  const reopen = useCallback(
    () => reopenSave(latch, (state) => setBusy(state !== 'idle')),
    []
  );
  return { busy, run, reopen };
}

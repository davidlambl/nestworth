// One save per accepted press, for every form that writes a new record from
// a press: New Transaction, New Account, New Recurring Rule, Transfer and the
// CSV import (useSaveOnce, lib/hooks/useSaveOnce.ts, is how a form holds it).
//
// A disabled button did not hold. A form turned its button off on the
// mutation's isPending, or on a state flag of its own, and a second press
// that comes before that has been rendered reaches the save again: TanStack
// Query tells React that a mutation has started from a setTimeout(0), and
// React Native dispatches the touches queued for one frame together, with no
// render between them (two taps while the JS thread is busy). New
// Transaction's Save was on again for the whole upload of its photo, too: a
// mutate()-level onSuccess runs once the mutation has settled, and nothing
// awaits it. Each extra press made a second transaction (or account, rule,
// transfer); a second import found its rows already stored and said none
// had been imported. The latch here is set by the press itself, before
// anything is awaited, and a save that has stored its record keeps it set
// until its screen has gone. lib/__tests__/saveOnce.test.ts measures the
// functions; lib/__tests__/saveOnceForms.test.ts presses the forms.

/**
 * Where a form's save is: none running, one running, or one done -- its
 * record stored and its screen closing, or its sheet hidden.
 */
export type SaveState = 'idle' | 'saving' | 'saved';

/**
 * A form's latch: a ref's `current` (useRef), written by a press, never read
 * during render.
 */
export type SaveLatch = { current: SaveState };

/**
 * Runs a form's save from a press, unless the form is saving or has saved:
 * then the press does nothing and `save` is not called. The latch is set
 * before `save` starts, so a second press of the same beat finds it set.
 *
 * `save` answers whether it stored the record: true once it has, and has
 * closed its screen (or hidden its sheet) -- the latch stays set, and no
 * press saves again until the form is shown afresh (reopenSave). False when
 * it refused (a validation, a refused write), each said on the form: the
 * latch is freed and the next press tries again. A save that throws frees it
 * as well, but the error rejects the promise returned here (`run`'s, in
 * useSaveOnce), which a form's press does not await: an unhandled rejection.
 * So a save says its own failures and answers false; it must not throw.
 *
 * `onChange` hears every state the latch takes (the hook renders it).
 */
export async function saveOnce(
  latch: SaveLatch,
  save: () => Promise<boolean>,
  onChange?: (state: SaveState) => void
): Promise<void> {
  if (latch.current !== 'idle') {
    return;
  }
  latch.current = 'saving';
  onChange?.('saving');
  let saved = false;
  try {
    saved = await save();
  } finally {
    latch.current = saved ? 'saved' : 'idle';
    onChange?.(latch.current);
  }
}

/**
 * The form is shown again for a new record (New Account's sheet, which stays
 * mounted with the Accounts tab): a save that has finished frees the latch.
 * One still running keeps it -- a create made offline waits for the network
 * (TanStack's networkMode 'online') and is still this sheet's: a second
 * create would land beside it when both resume.
 */
export function reopenSave(
  latch: SaveLatch,
  onChange?: (state: SaveState) => void
): void {
  if (latch.current === 'saved') {
    latch.current = 'idle';
    onChange?.('idle');
  }
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { describeRequestError } from '../requestError';
import { applyReceiptRemove } from '../receiptRemove';
import {
  forgetReceiptUrl,
  RECEIPTS_BUCKET,
  requireOwnSession,
} from '../receiptStorage';

export interface RemoveReceiptInput {
  transactionId: string;
  /** The receipt the screen showed: only that one is removed. */
  path: string;
}

/**
 * Removes a transaction's receipt (#23): its photo from Storage first, then
 * the transaction's `receipt_path`, which the push uploads as null like any
 * field edit.
 *
 * Storage first, because the photo is the user's data and the removal is
 * what they asked for. A removal that fails changes nothing, and says so: it
 * never leaves a photo in the bucket that no transaction names, where nothing
 * could find it again. The local write after it fails only when the
 * transaction is gone from this device or was deleted here meanwhile
 * (lib/receiptRemove.ts), in words that say whether Storage removed the photo
 * or found it already gone; a row the re-download brings back still naming
 * the photo then shows it as missing, and removing it again clears it:
 * Storage answers a removal of a photo that is already gone with an empty
 * list, not an error, and the row is cleared all the same.
 *
 * A session of the user's own is checked first: without one, supabase-js
 * signs the removal with the anon key, and Storage answers it with an empty
 * list too (lib/receiptStorage.ts). So is the key's folder: sign-out wipes no
 * rows, so a receipt of another account signed in on this device before is
 * still here, and Storage's answer to its removal, an empty list, would clear
 * that account's transaction here, for its next push to upload, and keep its
 * photo. No screen shows another account's transaction since #177 (every
 * read is the signed-in user's); this check holds whatever a screen shows.
 *
 * A mutation, so a failure reaches the sync indicator as "Save failed: …"
 * through the mutation cache (lib/query.tsx), and the screen shows it inline:
 * Alert.alert does nothing on web or in Electron. `networkMode: 'always'`: an
 * offline removal fails at once instead of waiting, paused, to remove a photo
 * long after the user has stopped looking. Unbounded, like the upload.
 */
export function useRemoveReceipt() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    networkMode: 'always',
    mutationFn: async ({
      transactionId,
      path,
    }: RemoveReceiptInput): Promise<boolean> => {
      const userId = user?.id ?? null;
      try {
        await requireOwnSession(userId);
      } catch (e) {
        throw new Error(
          `The receipt was not removed: ${describeRequestError(e)}`
        );
      }
      if (!path.startsWith(`${userId}/`)) {
        throw new Error(
          'The receipt was not removed: it belongs to a different account'
        );
      }
      const { data, error } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .remove([path]);
      if (error) {
        throw new Error(
          `The receipt was not removed: ${describeRequestError(error)}`
        );
      }
      if (!data?.length) {
        // Already gone: removed on another device, or never there. The
        // transaction still names it, so it is cleared all the same.
        console.warn('[receipt] already gone from Storage:', path);
      }
      forgetReceiptUrl(path);

      const db = await getDb();
      const cleared = await applyReceiptRemove(db, transactionId, path, {
        now: new Date().toISOString(),
        photoAlreadyGone: !data?.length,
      });
      if (cleared) {
        requestPush(userId!);
      }
      return cleared;
    },
    // Settled, not success: a refusal leaves a screen and a register row
    // showing a receipt this device no longer has to show.
    onSettled: (_data, _error, { transactionId }) => {
      qc.invalidateQueries({ queryKey: ['transaction', transactionId] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import {
  isForeignReceipt,
  isMissingReceipt,
  receiptUrl,
} from '../receiptStorage';

/**
 * The signed URL a screen shows a stored receipt through (#23), or nothing
 * while `path` is null. lib/receiptStorage.ts keeps the URL stable while it
 * has time left, so the refetch every sync ends with hands back the same one.
 *
 * `networkMode: 'always'`: the request is made offline too and fails at once
 * with "the network is unavailable", where TanStack would otherwise leave it
 * paused, a spinner with no end. A missing photo is never retried, nor
 * another account's receipt, refused before any request.
 */
export function useReceiptUrl(path: string | null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery({
    // The account in the key: a URL is its signer's (lib/receiptStorage.ts).
    queryKey: ['receipt-url', userId, path],
    queryFn: () => receiptUrl(userId!, path!),
    enabled: !!path && !!userId,
    networkMode: 'always',
    retry: (failures, error) =>
      failures < 1 && !isMissingReceipt(error) && !isForeignReceipt(error),
  });
}

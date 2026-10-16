import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type Colors from '@/constants/Colors';
import { useReceiptUrl } from '@/lib/hooks/useReceiptUrl';
import { describeRequestError } from '@/lib/requestError';
import {
  forgetReceiptUrl,
  isForeignReceipt,
  isMissingReceipt,
  RECEIPT_FOREIGN,
} from '@/lib/receiptStorage';

type ThemeColors = (typeof Colors)['light'];

export const RECEIPT_MISSING = "This receipt's photo is missing.";
export const RECEIPT_NOT_SHOWN = "Couldn't show the receipt here.";

interface ReceiptPreviewProps {
  /**
   * A photo picked on this screen and not uploaded yet, by its own URI: a
   * blob: URL on web and in Electron, a cached file:// copy on iOS. It is
   * shown as it is; the upload runs on Save.
   */
  localUri: string | null;
  /** The key of the receipt the transaction names, shown when none is picked. */
  storedPath: string | null;
  /** The screen's testID prefix: `edit-txn` or `new-txn`. */
  testIDPrefix: string;
  colors: ThemeColors;
  fontScale: number;
  /**
   * Removes the stored receipt; absent where there is none to remove. Told
   * whether Storage has said its photo is already gone, which the
   * confirmation then says instead of deleting it from the cloud.
   */
  onRemove?: (photoMissing: boolean) => void;
  removing?: boolean;
  /** Why the last removal failed, in its own words. */
  removeError?: string | null;
}

/**
 * A receipt on a transaction screen (#23): a thumbnail that opens the photo
 * full-screen, and for a stored receipt a Remove button.
 *
 * A stored receipt is shown through a signed URL (useReceiptUrl). Every way
 * it can fail ends in words on the screen, above the thumbnail, where the
 * keyboard does not reach once the user is down here: a photo that is gone
 * ("missing", never retried), another account's receipt (refused before any
 * request: its words, and neither Retry nor Remove), a URL that could not be
 * had (the request's own words, and Retry), or an image that would not load
 * or decode, such as a HEIC or a video picked on web, which Chrome and
 * Electron cannot show (Retry signs a new URL, for a token that expired). The
 * image component's own error text is never shown: on web and on iOS it
 * carries the URL, token and all.
 */
export function ReceiptPreview({
  localUri,
  storedPath,
  testIDPrefix,
  colors,
  fontScale,
  onRemove,
  removing,
  removeError,
}: ReceiptPreviewProps) {
  const remotePath = localUri ? null : storedPath;
  const remote = useReceiptUrl(remotePath);
  const uri = localUri ?? remote.data ?? null;
  // Per URI, so a new URL starts afresh without an effect resetting them.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  // Stable per URI: react-native-web's Image reloads whenever these change.
  // One failure for the thumbnail and the full-screen view: an image that
  // will not load closes the viewer, and the row says so and offers Retry.
  // On iOS the viewer loads the photo again at screen size, so a token that
  // expired while the screen stayed open fails there first.
  const onError = useCallback(() => {
    setViewing(false);
    setFailedUri(uri);
  }, [uri]);
  const onLoad = useCallback(() => setLoadedUri(uri), [uri]);

  if (!localUri && !storedPath) {
    return null;
  }

  const signError = remotePath && remote.isError ? remote.error : null;
  const missing = !!signError && isMissingReceipt(signError);
  // Another account's: nothing to retry, and not this account's to remove.
  const foreign = !!signError && isForeignReceipt(signError);
  const imageFailed = !!uri && failedUri === uri;
  const showImage = !!uri && !imageFailed && !signError;
  const loading = !signError && !imageFailed && (!uri || loadedUri !== uri);
  const canRetry =
    !!remotePath && !missing && !foreign && (!!signError || imageFailed);

  let message: string | null = null;
  if (removeError) {
    message = removeError;
  } else if (missing) {
    message = RECEIPT_MISSING;
  } else if (foreign) {
    message = RECEIPT_FOREIGN;
  } else if (signError) {
    message = `Couldn't load the receipt: ${describeRequestError(signError)}`;
  } else if (imageFailed) {
    message = RECEIPT_NOT_SHOWN;
  }

  const retry = () => {
    if (!remotePath) {
      return;
    }
    forgetReceiptUrl(remotePath);
    setFailedUri(null);
    void remote.refetch();
  };

  return (
    <View>
      {message ? (
        <Text
          testID={`${testIDPrefix}-receipt-message`}
          accessibilityRole="alert"
          style={[
            styles.message,
            {
              color:
                removeError || missing || foreign
                  ? colors.destructive
                  : colors.textSecondary,
              fontSize: 13 * fontScale,
            },
          ]}
        >
          {message}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Pressable
          testID={`${testIDPrefix}-receipt-thumb`}
          accessibilityRole="button"
          accessibilityLabel="View receipt"
          disabled={!showImage}
          onPress={() => {
            // A keyboard left up from the memo would cover the photo's foot.
            Keyboard.dismiss();
            setViewing(true);
          }}
          style={[
            styles.thumb,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          {showImage ? (
            <Image
              source={{ uri }}
              style={styles.thumbImage}
              resizeMode="cover"
              onError={onError}
              onLoad={onLoad}
            />
          ) : null}
          {loading ? (
            <ActivityIndicator
              style={StyleSheet.absoluteFill}
              color={colors.tint}
            />
          ) : null}
          {!showImage && !loading ? (
            <FontAwesome
              name={missing ? 'chain-broken' : 'image'}
              size={20}
              color={colors.placeholder}
            />
          ) : null}
        </Pressable>
        {canRetry ? (
          <TouchableOpacity
            testID={`${testIDPrefix}-receipt-retry`}
            accessibilityRole="button"
            accessibilityLabel="Load the receipt again"
            onPress={retry}
            style={[styles.action, { borderColor: colors.border }]}
          >
            <FontAwesome name="refresh" size={16} color={colors.tint} />
            <Text style={[styles.actionText, { color: colors.tint }]}>
              Retry
            </Text>
          </TouchableOpacity>
        ) : null}
        {onRemove && remotePath && !foreign ? (
          <TouchableOpacity
            testID={`${testIDPrefix}-receipt-remove`}
            accessibilityRole="button"
            accessibilityLabel="Remove receipt"
            onPress={() => onRemove(missing)}
            disabled={removing}
            style={[styles.action, { borderColor: colors.destructive }]}
          >
            {removing ? (
              <ActivityIndicator color={colors.destructive} />
            ) : (
              <>
                <FontAwesome
                  name="trash-o"
                  size={16}
                  color={colors.destructive}
                />
                <Text
                  style={[styles.actionText, { color: colors.destructive }]}
                >
                  Remove
                </Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
      <ReceiptViewer
        uri={showImage ? uri : null}
        visible={viewing && showImage}
        onClose={() => setViewing(false)}
        onError={onError}
        testIDPrefix={testIDPrefix}
      />
    </View>
  );
}

interface ReceiptViewerProps {
  uri: string | null;
  visible: boolean;
  onClose: () => void;
  /** The row's: a load that fails here is the row's failure too. */
  onError: () => void;
  testIDPrefix: string;
}

/**
 * The photo full-screen, over the transaction screen: an overlay, not a
 * route, so it loads the URL the thumbnail already loaded (no new token; on
 * web no second download either) and puts nothing in the web address bar.
 * Closed by its button on every platform, by Escape on web and in Electron
 * (react-native-web's Modal calls onRequestClose), and by the back button on
 * Android. It keeps no failure of its own: one that will not load closes it,
 * and the row behind it says so and offers Retry, which signs a new URL.
 */
function ReceiptViewer({
  uri,
  visible,
  onClose,
  onError,
  testIDPrefix,
}: ReceiptViewerProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewer}>
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.viewerImage}
            resizeMode="contain"
            accessibilityLabel="Receipt photo"
            onError={onError}
          />
        ) : (
          <Text style={styles.viewerText}>{RECEIPT_NOT_SHOWN}</Text>
        )}
        <TouchableOpacity
          testID={`${testIDPrefix}-receipt-close`}
          accessibilityRole="button"
          accessibilityLabel="Close receipt"
          onPress={onClose}
          hitSlop={12}
          style={[styles.close, { top: insets.top + 12 }]}
        >
          <FontAwesome name="times" size={20} color="#fff" />
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  message: { fontSize: 13, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: { width: '100%', height: '100%' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionText: { fontSize: 13, fontWeight: '500' },
  viewer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: { width: '100%', height: '100%' },
  viewerText: { color: '#fff', fontSize: 15 },
  close: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  closeText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

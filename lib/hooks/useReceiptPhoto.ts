import { useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { getDb } from '../db';
import { requestPush } from '../sync';
import { setLastError } from '../syncStatus';
import { describeRequestError } from '../requestError';
import { applyReceiptAttach } from '../receiptAttach';
import { receiptObject, type ReceiptPhoto } from '../receiptObject';

export function useReceiptPhoto() {
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  // The whole picked asset, not just its URI: the upload's key and type come
  // from its mimeType (#152).
  const [photo, setPhoto] = useState<ReceiptPhoto | null>(null);

  const pickPhoto = async (): Promise<ReceiptPhoto | null> => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission needed',
        'Please grant photo library access to attach receipts.'
      );
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
    });

    if (result.canceled || !result.assets[0]) {
      return null;
    }

    setPhoto(result.assets[0]);
    return result.assets[0];
  };

  const takePhoto = async (): Promise<ReceiptPhoto | null> => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission needed',
        'Please grant camera access to capture receipts.'
      );
      return null;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      allowsEditing: true,
    });

    if (result.canceled || !result.assets[0]) {
      return null;
    }

    setPhoto(result.assets[0]);
    return result.assets[0];
  };

  const uploadPhoto = async (
    picked: ReceiptPhoto,
    transactionId: string
  ): Promise<string | null> => {
    if (!user) {
      return null;
    }

    setUploading(true);
    try {
      // Key and type from what the picker says the file is: its mimeType,
      // else a known image extension of its file name or of the URI's last
      // path segment, never the raw text after the URI's last dot, which on
      // web is inside a blob: URL with no extension (#152).
      const { path, contentType } = receiptObject(
        user.id,
        transactionId,
        picked
      );

      // The bytes, not a Blob: storage-js sends a Blob inside FormData, and
      // React Native's FormData cannot carry a Blob's bytes (an empty file on
      // iOS). An ArrayBuffer goes up as the request body, with contentType
      // as its type, on every platform.
      const response = await fetch(picked.uri);
      const body = await response.arrayBuffer();

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, body, { contentType, upsert: true });

      if (uploadError) {
        // In the words every request error the user reads is given: an upload
        // that never reached Storage reads as the network being unavailable,
        // not "Failed to fetch". Here, not in the catch below: a failed read
        // of the picked file above fails with the same words on React Native,
        // and is no network failure.
        throw new Error(describeRequestError(uploadError));
      }

      // The upload can take as long as the network does, and the transaction
      // may be gone by now (a pulled tombstone, the reset's wipe) or marked
      // deleted here: then the attach is refused, and nothing is pushed (#138).
      const db = await getDb();
      try {
        await applyReceiptAttach(db, transactionId, path, {
          now: new Date().toISOString(),
        });
      } catch (refused) {
        // The row did not take the path: remove the upload, best effort. The
        // bucket's delete policy allows it for the user's own folder (009); a
        // removal Storage refuses answers an empty list, not an error, and is
        // only warned about. A failed removal leaves only the orphan every
        // refused attach used to leave, and must not replace the refusal the
        // user reads. Awaited: a removal still in flight could take a retry's
        // upload of the same path. The path is the transaction's id and the
        // extension, and the upload overwrote any earlier receipt there in
        // place, so after a reset during the upload the row the re-download
        // restores can name this path: removed, it names nothing. Nothing
        // displays receipts yet (#23).
        try {
          const { data, error } = await supabase.storage
            .from('receipts')
            .remove([path]);
          if (error || !data?.length) {
            console.warn(
              '[receipt] upload not removed:',
              path,
              error ?? 'nothing removed'
            );
          }
        } catch (e) {
          console.warn('[receipt] upload not removed:', path, e);
        }
        throw refused;
      }
      requestPush(user.id);

      return path;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      Alert.alert('Upload failed', message);
      // Alert.alert does nothing on web or in Electron, and this is not a
      // mutation, so the mutation cache never sees the failure: report it on
      // the sync indicator by hand, as the cache does for a mutation
      // (lib/query.tsx). The next sync to start clears it.
      setLastError(`Save failed: ${message}`);
      return null;
    } finally {
      setUploading(false);
    }
  };

  const clearPhoto = () => setPhoto(null);

  return { pickPhoto, takePhoto, uploadPhoto, uploading, photo, clearPhoto };
}

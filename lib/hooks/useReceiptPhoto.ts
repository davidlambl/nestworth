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

export function useReceiptPhoto() {
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  const pickPhoto = async (): Promise<string | null> => {
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

    setPhotoUri(result.assets[0].uri);
    return result.assets[0].uri;
  };

  const takePhoto = async (): Promise<string | null> => {
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

    setPhotoUri(result.assets[0].uri);
    return result.assets[0].uri;
  };

  const uploadPhoto = async (
    uri: string,
    transactionId: string
  ): Promise<string | null> => {
    if (!user) {
      return null;
    }

    setUploading(true);
    try {
      const ext = uri.split('.').pop() ?? 'jpg';
      const path = `${user.id}/${transactionId}.${ext}`;

      const response = await fetch(uri);
      const blob = await response.blob();

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, blob, {
          contentType: `image/${ext}`,
          upsert: true,
        });

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
        // The row did not take the path: remove the upload, best effort. That
        // needs the bucket's delete policy, which is not in this repo, and a
        // removal the policies refuse most likely answers an empty list, not
        // an error. A failed removal leaves only the orphan every refused
        // attach used to leave, and must not replace the refusal the user
        // reads. Awaited: a removal still in flight could take a retry's
        // upload of the same path. The path is the transaction's id and the
        // extension, overwritten in place, so after a reset during the upload
        // this can remove an earlier receipt the re-downloaded row still
        // names; nothing displays receipts yet (#23).
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

  const clearPhoto = () => setPhotoUri(null);

  return { pickPhoto, takePhoto, uploadPhoto, uploading, photoUri, clearPhoto };
}

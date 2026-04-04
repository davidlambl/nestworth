import { useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../supabase';
import { useAuth } from '../auth';

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
        throw uploadError;
      }

      await supabase
        .from('transactions')
        .update({ receipt_path: path })
        .eq('id', transactionId);

      return path;
    } catch (e: any) {
      Alert.alert('Upload failed', e.message);
      return null;
    } finally {
      setUploading(false);
    }
  };

  const clearPhoto = () => setPhotoUri(null);

  return { pickPhoto, takePhoto, uploadPhoto, uploading, photoUri, clearPhoto };
}

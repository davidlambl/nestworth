import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { sidePadding } from '@/lib/layout';
import { useScreenInsets } from '@/lib/hooks/useScreenInsets';

export default function NotFoundScreen() {
  const insets = useScreenInsets();
  return (
    <>
      <Stack.Screen options={{ title: 'Not Found' }} />
      <View style={[styles.container, sidePadding(insets, PADDING)]}>
        <Text style={styles.title}>This screen doesn&apos;t exist.</Text>
        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>Go to home screen</Text>
        </Link>
      </View>
    </>
  );
}

// The screen's own padding; the side insets are added to it.
const PADDING = 20;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: PADDING,
  },
  title: { fontSize: 20, fontWeight: '600' },
  link: { marginTop: 16, paddingVertical: 16 },
  linkText: { fontSize: 16, color: '#2563eb' },
});

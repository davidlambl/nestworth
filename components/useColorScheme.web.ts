import { useTheme } from '@/lib/theme';

export function useColorScheme() {
  try {
    const { colorScheme } = useTheme();
    return colorScheme;
  } catch {
    return 'light';
  }
}

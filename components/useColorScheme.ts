import { useTheme } from '@/lib/theme';

export function useColorScheme() {
  const { colorScheme } = useTheme();
  return colorScheme;
}

import { useOptionalTheme } from '@/lib/theme';

export function useColorScheme() {
  // Called unconditionally: useOptionalTheme returns undefined rather than
  // throwing when this renders outside AppThemeProvider.
  return useOptionalTheme()?.colorScheme ?? 'light';
}

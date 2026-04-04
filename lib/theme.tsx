import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

type ThemePref = 'system' | 'light' | 'dark';
type FontSizePref = 'small' | 'medium' | 'large';

const FONT_SCALES: Record<FontSizePref, number> = {
  small: 0.9,
  medium: 1.0,
  large: 1.15,
};

interface ThemeContextValue {
  colorScheme: 'light' | 'dark';
  themePref: ThemePref;
  setThemePref: (pref: ThemePref) => void;
  fontSizePref: FontSizePref;
  setFontSizePref: (pref: FontSizePref) => void;
  fontScale: number;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useRNColorScheme() ?? 'light';
  const [themePref, setThemePrefState] = useState<ThemePref>('system');
  const [fontSizePref, setFontSizePrefState] = useState<FontSizePref>('medium');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      Promise.all([
        store.getItem('nestworth-theme'),
        store.getItem('nestworth-font-size'),
      ]).then(([t, f]) => {
        if (t === 'light' || t === 'dark' || t === 'system') {
          setThemePrefState(t);
        }
        if (f === 'small' || f === 'medium' || f === 'large') {
          setFontSizePrefState(f);
        }
        setLoaded(true);
      });
    });
  }, []);

  const setThemePref = (pref: ThemePref) => {
    setThemePrefState(pref);
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      store.setItem('nestworth-theme', pref);
    });
  };

  const setFontSizePref = (pref: FontSizePref) => {
    setFontSizePrefState(pref);
    import('@react-native-async-storage/async-storage').then(({ default: store }) => {
      store.setItem('nestworth-font-size', pref);
    });
  };

  const colorScheme: 'light' | 'dark' =
    themePref === 'system' ? systemScheme : themePref;

  if (!loaded) {
    return null;
  }

  return (
    <ThemeContext.Provider
      value={{
        colorScheme,
        themePref,
        setThemePref,
        fontSizePref,
        setFontSizePref,
        fontScale: FONT_SCALES[fontSizePref],
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within AppThemeProvider');
  }
  return ctx;
}

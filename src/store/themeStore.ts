/**
 * themeStore — Light / Dark mode persistence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  resolvedTheme: 'light' | 'dark';

  setMode: (mode: ThemeMode) => void;
  applyTheme: () => void;
}

const STORAGE_KEY = 'ovolveAgent.theme';

function getSystemDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return getSystemDark() ? 'dark' : 'light';
  return mode;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'dark',
      isDark: true,
      resolvedTheme: 'dark',

      setMode: (mode) => {
        const resolved = resolveMode(mode);
        set({ mode, isDark: resolved === 'dark', resolvedTheme: resolved });
        get().applyTheme();
      },

      applyTheme: () => {
        const { mode } = get();
        const resolved = resolveMode(mode);
        const isDark = resolved === 'dark';
        set({ isDark, resolvedTheme: resolved });

        if (typeof document !== 'undefined') {
          if (isDark) {
            document.body.setAttribute('data-oa-dark-theme', '');
          } else {
            document.body.removeAttribute('data-oa-dark-theme');
          }
        }
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ mode: state.mode }),
    }
  )
);

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      const store = useThemeStore.getState();
      if (store.mode === 'system') {
        store.applyTheme();
      }
    });

  setTimeout(() => {
    useThemeStore.getState().applyTheme();
  }, 0);
}

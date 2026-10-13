import { create } from 'zustand'

type Theme = 'light' | 'dark' | 'auto'

interface ThemeState {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'auto') return getSystemTheme()
  return theme
}

export const useThemeStore = create<ThemeState>((set) => {
  // 'ovolve-theme' is canonical; pre-rename keys are still
  // read so existing users keep their chosen theme.
  const saved = (typeof localStorage !== 'undefined'
    && (localStorage.getItem('ovolve-theme'))) as Theme | null
  const initial: Theme = saved || 'dark'

  return {
    theme: initial,
    resolvedTheme: resolveTheme(initial),
    setTheme: (theme: Theme) => {
      const resolved = resolveTheme(theme)
      set({ theme, resolvedTheme: resolved })
      localStorage.setItem('ovolve-theme', theme)
    }
  }
})

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme, setTheme } = useThemeStore.getState()
    if (theme === 'auto') {
      setTheme('auto')
    }
  })
}

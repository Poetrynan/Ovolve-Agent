import { Moon, Sun, Monitor } from 'lucide-react'
import { useThemeStore } from '@store/themeStore'
import { cn } from '@/lib/utils'

type Theme = 'light' | 'dark' | 'auto'

export function ThemeToggle() {
  const { theme, setTheme } = useThemeStore()

  const themes: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: '白天模式' },
    { value: 'dark', icon: Moon, label: '黑夜模式' },
    { value: 'auto', icon: Monitor, label: '跟随系统' },
  ]

  return (
    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
      {themes.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            'relative flex items-center justify-center w-9 h-9 rounded-md',
            'transition-all duration-200 ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            theme === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          aria-label={label}
          title={label}
        >
          <Icon
            size={16}
            className={cn(
              'transition-all duration-200',
              theme === value ? 'scale-110' : 'scale-100'
            )}
          />
        </button>
      ))}
    </div>
  )
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useThemeStore()

  return (
    <div className="grid grid-cols-3 gap-3">
      {[
        { value: 'light' as const, label: '白天模式', icon: Sun },
        { value: 'dark' as const, label: '黑夜模式', icon: Moon },
        { value: 'auto' as const, label: '跟随系统', icon: Monitor },
      ].map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            'flex flex-col items-center gap-2 p-4 rounded-xl border-2',
            'transition-all duration-200 ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            theme === value
              ? 'border-primary bg-accent text-foreground'
              : 'border-border bg-background text-muted-foreground hover:border-border/60 hover:text-foreground'
          )}
        >
          <Icon
            size={24}
            className={cn(
              'transition-transform duration-200',
              theme === value ? 'scale-110' : 'scale-100'
            )}
          />
          <span className="text-xs font-medium">{label}</span>
        </button>
      ))}
    </div>
  )
}

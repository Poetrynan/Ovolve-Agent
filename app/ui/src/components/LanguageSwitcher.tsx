import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { SUPPORTED_LANGUAGES, type LanguageCode } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * Compact segmented switcher for interface language.
 * Sized/styled to match the existing settings-row controls (theme switcher etc.).
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation()
  const current: LanguageCode = i18n.language?.startsWith('en') ? 'en' : 'zh'

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 p-0.5 rounded-lg bg-muted/50 border border-border/40',
        className,
      )}
      role="group"
      aria-label="Language"
    >
      <Globe className="w-3.5 h-3.5 ml-1.5 mr-0.5 text-muted-foreground shrink-0" />
      {SUPPORTED_LANGUAGES.map((lang) => {
        const active = current === lang.code
        return (
          <button
            key={lang.code}
            type="button"
            onClick={() => i18n.changeLanguage(lang.code)}
            className={cn(
              'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={active}
          >
            {lang.label}
          </button>
        )
      })}
    </div>
  )
}

export default LanguageSwitcher

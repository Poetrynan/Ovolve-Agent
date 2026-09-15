// src/components/chat/DensitySelector.tsx
// Chat timeline density: full / compact / minimal. Lives in Settings → 通用
// (not the composer) because it's a standing display preference rather than a
// per-turn dial. No animation — motion would only add lag to a plain choice.
import { AlignJustify, Check, ChevronDown, List, ListTree } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'
import { useSessionConfigStore, type ChatDensity } from '@store/sessionConfigStore'
import { cn } from '@lib/utils'

const DENSITIES: Array<{
  id: ChatDensity
  labelKey: string
  descKey: string
  icon: typeof ListTree
}> = [
  { id: 'full', labelKey: 'density.full', descKey: 'density.fullDesc', icon: ListTree },
  { id: 'compact', labelKey: 'density.compact', descKey: 'density.compactDesc', icon: List },
  { id: 'minimal', labelKey: 'density.minimal', descKey: 'density.minimalDesc', icon: AlignJustify },
]

export function DensitySelector() {
  const { t } = useTranslation()
  const { chatDensity, setChatDensity } = useSessionConfigStore()
  const current = DENSITIES.find((d) => d.id === chatDensity) ?? DENSITIES[0]
  const Icon = current.icon

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('density.hint')}
          aria-label={t('density.header')}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-xl text-xs font-medium transition-colors press-feedback',
            'border border-border/50 bg-background/60 shadow-2xs',
            'hover:bg-accent text-foreground',
          )}
        >
          <Icon size={13} />
          <span>{t(current.labelKey)}</span>
          <ChevronDown size={11} className="opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-1">
        {DENSITIES.map((d) => {
          const DIcon = d.icon
          const active = chatDensity === d.id
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => setChatDensity(d.id)}
              className={cn(
                'w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors duration-150',
                active ? 'bg-accent text-foreground' : 'hover:bg-accent/60 text-foreground',
              )}
            >
              <DIcon size={14} className="mt-0.5 shrink-0 opacity-70" />
              <div className="min-w-0">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  {t(d.labelKey)}
                  {active && <Check size={12} className="text-primary" />}
                </span>
                <span className="text-[10px] text-muted-foreground leading-snug">{t(d.descKey)}</span>
              </div>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

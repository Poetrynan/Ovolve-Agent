import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverAnchor } from '@components/ui/popover'
import { ComposerCapsule } from './ComposerCapsule'
import { ThoughtDial } from './ThoughtDial'
import { useSessionConfigStore, type ThoughtLevel } from '@store/sessionConfigStore'
import { cn } from '@lib/utils'

const LEVELS: Array<{ id: ThoughtLevel; label: string; description: string }> = [
  { id: 'off', label: 'thought.off', description: 'thought.offDesc' },
  { id: 'low', label: 'thought.low', description: 'thought.lowDesc' },
  { id: 'high', label: 'thought.high', description: 'thought.highDesc' },
  { id: 'max', label: 'thought.max', description: 'thought.maxDesc' },
]

interface Props {
  supported?: boolean
  variants?: string[]
}

export function ThoughtLevelSelector({ supported = true, variants }: Props) {
  const { t } = useTranslation()
  const { thoughtLevel, setThoughtLevel } = useSessionConfigStore()
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [popping, setPopping] = useState(false)
  const wasAtMax = useRef(false)

  const allowed = useMemo(
    () => (variants?.length ? LEVELS.filter((l) => variants.includes(l.id)) : LEVELS),
    [variants],
  )
  const index = Math.max(allowed.findIndex((l) => l.id === thoughtLevel), 0)
  const current = allowed[index] ?? allowed[0]
  const atMax = !!current && index === allowed.length - 1 && current.id === 'max'

  const dialSteps = useMemo(
    () => allowed.map((l) => ({ id: l.id, label: t(l.label) })),
    [allowed, t],
  )

  useEffect(() => {
    if (!supported || !allowed.length) return undefined
    if (atMax && !wasAtMax.current) {
      setPopping(true)
      const timer = window.setTimeout(() => setPopping(false), 450)
      wasAtMax.current = true
      return () => window.clearTimeout(timer)
    }
    if (!atMax) wasAtMax.current = false
    return undefined
  }, [atMax, allowed.length, supported])

  if (!supported || !allowed.length || !current) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <ComposerCapsule
            testId="chat-thought-level-select-trigger"
            ariaLabel={t('thought.header')}
            icon={<Brain size={13} />}
            label={t(current.label)}
            gauge={{ steps: allowed.length, value: index }}
            tone={atMax ? 'primary' : 'neutral'}
            energized={atMax}
            dragging={dragging}
            pop={popping}
            dragIndex={index}
            dragMax={allowed.length - 1}
            onDragStart={() => setDragging(true)}
            onDragEnd={() => setDragging(false)}
            onDragValue={(next) => setThoughtLevel(allowed[next]?.id ?? current.id)}
            onClick={() => setOpen((v) => !v)}
          />
        </span>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        className={cn(
          'w-[264px] p-0 overflow-hidden rounded-2xl border border-border/80 bg-popover shadow-lg',
          atMax && 'thought-dial-panel--max',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="thought-dial-panel-head px-3.5 pt-3 pb-2.5 border-b border-border/40">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border transition-colors',
                atMax
                  ? 'bg-sky-500/15 text-sky-500 dark:text-sky-400 border-sky-500/30 font-semibold shadow-xs'
                  : 'bg-muted/60 text-muted-foreground border-border/40',
              )}
            >
              <Brain size={13} />
            </span>
            <div className="min-w-0 leading-tight flex-1">
              <div className="flex items-center justify-between gap-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('thought.header')}
                </p>
                {atMax && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-sky-500 text-white dark:bg-sky-400 dark:text-slate-950 text-[9px] font-mono font-bold tracking-wide shadow-xs">
                    MAX
                  </span>
                )}
              </div>
              <p
                className={cn(
                  'text-xs font-semibold truncate mt-0.5 transition-colors',
                  atMax ? 'text-sky-600 dark:text-sky-400' : 'text-foreground',
                )}
              >
                {t(current.label)}
              </p>
            </div>
          </div>
        </div>

        <div className="p-3">
          <div className="flex justify-between items-center text-[10px] text-muted-foreground/60 px-0.5 mb-1.5 font-medium select-none">
            <span>{t('thought.faster')}</span>
            <span>{t('thought.smarter')}</span>
          </div>
          <ThoughtDial
            testId="chat-thought-level-slider"
            ariaLabel={t('thought.header')}
            steps={dialSteps}
            index={index}
            atMax={atMax}
            onDragStart={() => setDragging(true)}
            onDragEnd={() => setDragging(false)}
            onChange={(i) => setThoughtLevel(allowed[i]?.id ?? current.id)}
          />
          <p className="mt-2.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
            {t(current.description)}
            {atMax && (
              <span className="block mt-0.5 text-sky-700/85 dark:text-sky-300/85 font-medium">{t('thought.maxWarn')}</span>
            )}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

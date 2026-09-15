// src/components/ui/SegmentedControl.tsx
// iOS-style segmented control with a single sliding pill.
//
// Why a pill instead of per-item backgrounds: only one element moves, so the
// transition can carry momentum. The pill rides a bouncy spring (overshoots,
// then settles) while the incoming label gets squashed and released — that's
// the "jelly pushed across" read.
//
// Segments are an equal-width grid, so nothing overflows and there is no
// horizontal scrollbar. Honors prefers-reduced-motion by snapping instead.
import { motion, useReducedMotion } from 'framer-motion'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/** Pill travel: smooth iOS spring transition without over-distorting text. */
const PILL_SPRING = {
  type: 'spring' as const,
  stiffness: 450,
  damping: 32,
  mass: 0.8,
}

export interface Segment<T extends string> {
  id: T
  label: string
  icon?: ComponentType<{ className?: string }>
}

interface SegmentedControlProps<T extends string> {
  segments: Array<Segment<T>>
  value: T
  onChange: (value: T) => void
  /** Must be unique per mounted control — scopes the shared-layout pill. */
  layoutId: string
  className?: string
  'data-testid'?: string
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  layoutId,
  className,
  'data-testid': testId,
}: SegmentedControlProps<T>) {
  const reduceMotion = useReducedMotion()

  return (
    <div
      role="tablist"
      data-testid={testId}
      className={cn(
        'grid gap-1 p-1 rounded-2xl bg-muted/50 border border-border/40 backdrop-blur-md',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
    >
      {segments.map((segment) => {
        const Icon = segment.icon
        const isActive = value === segment.id
        return (
          <button
            key={segment.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(segment.id)}
            className={cn(
              'relative flex items-center justify-center gap-2 px-3 py-2 rounded-xl',
              'text-xs font-medium min-w-0 transition-colors duration-150 select-none cursor-pointer',
              isActive ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-xl bg-background border border-border/40 shadow-xs"
                transition={reduceMotion ? { duration: 0 } : PILL_SPRING}
              />
            )}

            {/* Stable content sitting above the pill — no letter scaling or distortion */}
            <span className="relative z-10 flex items-center justify-center gap-2 min-w-0">
              {Icon && (
                <Icon
                  className={cn(
                    'w-4 h-4 shrink-0 transition-colors duration-150',
                    isActive ? 'text-foreground' : 'text-muted-foreground',
                  )}
                />
              )}
              <span className="truncate">{segment.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

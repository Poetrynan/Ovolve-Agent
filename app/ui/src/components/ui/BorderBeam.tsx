// src/components/ui/BorderBeam.tsx
// High-performance, GPU-accelerated Border Beam and Ray Scan effects for AI generation states
import React from 'react'
import { cn } from '@/lib/utils'

interface BorderBeamProps {
  className?: string
  size?: number
  duration?: number
  borderWidth?: number
  anchor?: number
  colorFrom?: string
  colorTo?: string
  delay?: number
}

/**
 * BorderBeam:
 * Casts a smooth, flowing luminous aura beam tracing the border of a card or container.
 * Requires the parent container to have `relative overflow-hidden`.
 */
export function BorderBeam({
  className,
  size = 200,
  duration = 5,
  anchor = 90,
  borderWidth = 1.5,
  colorFrom = '#38bdf8',
  colorTo = '#a855f7',
  delay = 0,
}: BorderBeamProps) {
  return (
    <div
      style={
        {
          '--size': `${size}px`,
          '--duration': `${duration}s`,
          '--anchor': `${anchor}%`,
          '--border-width': `${borderWidth}px`,
          '--color-from': colorFrom,
          '--color-to': colorTo,
          '--delay': `-${delay}s`,
        } as React.CSSProperties
      }
      className={cn(
        'pointer-events-none absolute inset-0 rounded-[inherit]',
        '[border:calc(var(--border-width))_solid_transparent]',
        '![mask-clip:padding-box,border-box]',
        '![mask-composite:intersect]',
        '[mask:linear-gradient(transparent,transparent),linear-gradient(white,white)]',
        'after:absolute after:aspect-square after:w-[calc(var(--size))]',
        'after:animate-border-beam after:[animation-delay:var(--delay)]',
        'after:[background:linear-gradient(to_left,var(--color-from),var(--color-to),transparent)]',
        'after:[offset-anchor:calc(var(--anchor))_50%]',
        'after:[offset-path:rect(0_auto_auto_0_round_calc(var(--size)))]',
        className,
      )}
    />
  )
}

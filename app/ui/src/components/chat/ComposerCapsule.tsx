// ComposerCapsule — per-turn dial pill with spring-based horizontal drag.
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { motion, useSpring, animate } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { cn } from '@lib/utils'

export type ComposerCapsuleTone = 'neutral' | 'primary' | 'warning'

export interface ComposerCapsuleGauge {
  steps: number
  value: number
}

interface ComposerCapsuleProps {
  icon: ReactNode
  label: ReactNode
  gauge?: ComposerCapsuleGauge
  tone?: ComposerCapsuleTone
  energized?: boolean
  dragging?: boolean
  pop?: boolean
  testId?: string
  ariaLabel?: string
  onClick?: () => void
  onDragValue?: (nextIndex: number) => void
  dragIndex?: number
  dragMax?: number
  onDragStart?: () => void
  onDragEnd?: () => void
}

const PX_PER_STEP = 22
const FOLLOW = 0.55

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export function ComposerCapsule({
  icon,
  label,
  gauge,
  tone = 'neutral',
  energized = false,
  dragging = false,
  pop = false,
  testId,
  ariaLabel,
  onClick,
  onDragValue,
  dragIndex = 0,
  dragMax = 0,
  onDragStart,
  onDragEnd,
}: ComposerCapsuleProps) {
  const dragX = useSpring(0, { stiffness: 620, damping: 42, mass: 0.55 })
  const dragRef = useRef({ active: false, moved: false, startX: 0, startIdx: 0 })
  const [liveIndex, setLiveIndex] = useState(dragIndex)
  const lastHaptic = useRef(dragIndex)

  useEffect(() => {
    if (!dragging) setLiveIndex(dragIndex)
  }, [dragIndex, dragging])

  const finishDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    onDragEnd?.()
    void animate(dragX, 0, { type: 'spring', stiffness: 640, damping: 38, mass: 0.5 })
    if (!dragRef.current.moved) onClick?.()
    dragRef.current.moved = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onDragValue) {
      onClick?.()
      return
    }
    dragRef.current = { active: true, moved: false, startX: e.clientX, startIdx: dragIndex }
    lastHaptic.current = dragIndex
    setLiveIndex(dragIndex)
    onDragStart?.()
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active || !onDragValue) return
    const dx = e.clientX - dragRef.current.startX
    if (Math.abs(dx) > 5) dragRef.current.moved = true

    const maxTravel = dragMax * PX_PER_STEP
    const clampedDx = clamp(dx, -maxTravel, maxTravel)
    const rawSteps = clampedDx / PX_PER_STEP
    const next = clamp(Math.round(dragRef.current.startIdx + rawSteps), 0, dragMax)
    const snappedOffset = (next - dragRef.current.startIdx) * PX_PER_STEP
    const rubber = (clampedDx - snappedOffset) * FOLLOW

    dragX.set(rubber)

    if (next !== liveIndex) {
      setLiveIndex(next)
      if (next !== lastHaptic.current) {
        lastHaptic.current = next
        onDragValue(next)
      }
    }
  }

  const gaugeValue = dragging ? liveIndex : dragIndex

  return (
    <motion.button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finishDrag(e)}
      onPointerCancel={(e) => finishDrag(e)}
      style={{ x: dragX }}
      animate={{
        scale: dragging ? 1.04 : pop ? [1, 1.06, 1] : 1,
      }}
      transition={{
        scale: pop
          ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] }
          : { type: 'spring', stiffness: 520, damping: 34 },
      }}
      className={cn(
        'relative inline-flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-full text-xs font-medium',
        'border transition-[color,background-color,border-color,box-shadow] duration-200',
        'select-none touch-none cursor-pointer active:cursor-pointer',
        tone === 'primary' && 'text-primary border-primary/35 bg-primary/8',
        tone === 'warning' && 'text-warning border-warning/35 bg-warning/8',
        tone === 'neutral' && 'text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5',
        energized && tone === 'primary' && 'composer-capsule-energized composer-capsule-energized--primary',
        energized && tone === 'warning' && 'composer-capsule-energized composer-capsule-energized--warning',
        dragging && 'shadow-sm z-10',
      )}
    >
      <span className={cn('shrink-0', energized && 'composer-capsule-icon-pulse')}>{icon}</span>
      <span className="truncate max-w-[5.5rem] sm:max-w-none">{label}</span>
      {gauge && gauge.steps > 1 ? (
        <span className="flex items-end gap-[2px] h-3 mx-0.5" aria-hidden>
          {Array.from({ length: gauge.steps }, (_, i) => {
            const filled = i <= gaugeValue
            const activeBar = filled && i === gaugeValue && dragging
            return (
              <motion.span
                key={i}
                initial={false}
                className={cn(
                  'w-[3px] rounded-sm origin-bottom',
                  filled
                    ? energized
                      ? 'bg-primary composer-capsule-gauge-bar'
                      : 'bg-foreground/50'
                    : 'bg-foreground/15',
                )}
                animate={{
                  height: `${(filled ? 40 : 28) + i * 20}%`,
                  opacity: filled ? 1 : 0.45,
                  scaleY: activeBar ? 1.22 : 1,
                }}
                transition={{ type: 'spring', stiffness: 480, damping: 32 }}
              />
            )
          })}
        </span>
      ) : null}
      <ChevronDown size={11} className="opacity-45 shrink-0" />
    </motion.button>
  )
}

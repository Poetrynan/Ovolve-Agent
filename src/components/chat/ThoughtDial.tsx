// ThoughtDial — Clean White Track with Rhythmic Quantum Energy Burst at MAX.
// 60FPS Zero-GC Canvas Particle Surge Recipe for Max-Tier Controls.
import React, { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { motion } from 'framer-motion'
import { cn } from '../ui/button'

export interface ThoughtDialStep {
  id: string
  label: string
}

interface ThoughtDialProps {
  steps?: ThoughtDialStep[]
  index: number
  atMax?: boolean
  ariaLabel?: string
  onChange: (index: number) => void
  onDragStart?: () => void
  onDragEnd?: () => void
}

const DEFAULT_STEPS: ThoughtDialStep[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'MAX' },
]

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function indexFromX(clientX: number, rect: DOMRect, n: number): number {
  if (n <= 1) return 0
  const t = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
  return clamp(Math.round(t * (n - 1)), 0, n - 1)
}

function fillClass(id: string): string {
  if (id === 'max') return 'thought-dial-fill--max'
  if (id === 'high') return 'thought-dial-fill--high'
  return 'thought-dial-fill--low'
}

// Pre-allocated static color palettes for zero-allocation 60fps rendering (0 byte GC pressure)
const PALETTE_SPARKLE = 'rgba(255, 255, 255, 0.98)'
const PALETTE_CREST = Array.from({ length: 32 }, (_, i) => `rgba(240, 249, 255, ${(0.92 + 0.08 * (i / 31)).toFixed(3)})`)
const PALETTE_BODY = Array.from({ length: 32 }, (_, i) => `rgba(56, 189, 248, ${(0.85 + 0.15 * (i / 31)).toFixed(3)})`)
const PALETTE_MID = Array.from({ length: 32 }, (_, i) => `rgba(96, 165, 250, ${(0.75 + 0.15 * (i / 31)).toFixed(3)})`)
const PALETTE_DEEP = Array.from({ length: 32 }, (_, i) => `rgba(37, 99, 235, ${(0.65 + 0.2 * (i / 31)).toFixed(3)})`)

function getPaletteColor(energy: number): string {
  if (energy > 0.74) {
    const idx = Math.min(31, Math.max(0, Math.floor(((energy - 0.74) / 0.26) * 31)))
    return PALETTE_CREST[idx]
  }
  if (energy > 0.46) {
    const idx = Math.min(31, Math.max(0, Math.floor(((energy - 0.46) / 0.28) * 31)))
    return PALETTE_BODY[idx]
  }
  if (energy > 0.25) {
    const idx = Math.min(31, Math.max(0, Math.floor(((energy - 0.25) / 0.21) * 31)))
    return PALETTE_MID[idx]
  }
  const idx = Math.min(31, Math.max(0, Math.floor((energy / 0.25) * 31)))
  return PALETTE_DEEP[idx]
}

function ThoughtMaxBlockMatrix({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) return

    if (!active) {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      startTimeRef.current = 0
      return
    }

    startTimeRef.current = performance.now()
    const OPEN_DURATION = 1.1

    const updateSize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height, dpr }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    updateSize()

    const pixelSize = 2.4
    const gap = 1.3
    const step = pixelSize + gap

    const render = (now: number) => {
      const { w: width, h: height, dpr } = sizeRef.current
      if (width <= 0 || height <= 0) {
        animRef.current = requestAnimationFrame(render)
        return
      }

      const t = (now - startTimeRef.current) * 0.001

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)

      const cols = Math.floor((width - 4) / step)
      const rows = Math.floor((height - 4) / step)
      const startX = (width - (cols * step - gap)) / 2
      const startY = (height - (rows * step - gap)) / 2

      const openRatio = Math.min(1, t / OPEN_DURATION)
      const openFront = 1 - Math.pow(1 - openRatio, 2.6)
      const windSpeed = 3.0

      for (let c = 0; c < cols; c++) {
        const x = startX + c * step
        const u = c / Math.max(cols - 1, 1)

        if (u > openFront) continue

        const distBehind = openFront - u
        const colAlpha = openRatio < 1 ? Math.min(1.0, distBehind / 0.12) : 1.0

        const wind1 = Math.sin(u * 11.0 - t * windSpeed)
        const wind2 = Math.sin(u * 22.0 - t * (windSpeed * 1.35) + 0.9)
        const wind3 = Math.cos(u * 5.5 - t * (windSpeed * 0.7))

        for (let r = 0; r < rows; r++) {
          const y = startY + r * step
          const v = r / Math.max(rows - 1, 1)

          const ripple = Math.sin(u * 14.0 - t * (windSpeed * 1.1) + v * 1.2)
          const windEnergy = (wind1 * 0.42 + wind2 * 0.28 + wind3 * 0.3 + ripple * 0.2 + 1.2) / 2.4

          const flutter = Math.sin(c * 13.7 + r * 29.3 - t * 8.5)
          const isSparkle = flutter > 0.88 && windEnergy > 0.45

          if (colAlpha < 1.0) ctx.globalAlpha = colAlpha

          if (isSparkle) {
            ctx.fillStyle = PALETTE_SPARKLE
          } else {
            ctx.fillStyle = getPaletteColor(windEnergy)
          }

          ctx.fillRect(x, y, pixelSize, pixelSize)

          if (colAlpha < 1.0) ctx.globalAlpha = 1.0
        }
      }

      ctx.restore()
      animRef.current = requestAnimationFrame(render)
    }

    animRef.current = requestAnimationFrame(render)
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        transform: 'translateZ(0)',
        willChange: 'opacity, transform',
        contain: 'strict',
      }}
      className={cn(
        'absolute inset-0 w-full h-full pointer-events-none rounded-[inherit] z-10 transition-opacity duration-300',
        active ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}

export function ThoughtDial({
  steps = DEFAULT_STEPS,
  index,
  atMax = false,
  ariaLabel = 'Thought / Reasoning Depth',
  onChange,
  onDragStart,
  onDragEnd,
}: ThoughtDialProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef(false)
  const n = steps.length
  const last = n - 1
  const pos = last > 0 ? (index / last) * 100 : 0
  const hasFill = index > 0 || steps[0]?.id !== 'off'
  const active = steps[index]
  const isCurrentlyMax = atMax || active?.id === 'max'

  const setIndex = useCallback(
    (next: number) => {
      const clamped = clamp(next, 0, last)
      if (clamped !== index) onChange(clamped)
    },
    [index, last, onChange],
  )

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!trackRef.current) return
    dragRef.current = true
    onDragStart?.()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIndex(indexFromX(e.clientX, trackRef.current.getBoundingClientRect(), n))
  }

  const onTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !trackRef.current) return
    setIndex(indexFromX(e.clientX, trackRef.current.getBoundingClientRect(), n))
  }

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = false
    onDragEnd?.()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }

  const spring = { type: 'spring' as const, stiffness: 500, damping: 35, mass: 0.5 }

  return (
    <div className="w-full">
      <div className="relative">
        <div
          ref={trackRef}
          role="slider"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={index}
          aria-valuetext={active?.label}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex(index + 1)
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex(index - 1)
            }
          }}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          className={cn(
            'thought-dial-track relative h-7 w-full rounded-full cursor-grab active:cursor-grabbing touch-none select-none overflow-hidden transition-all duration-300',
            isCurrentlyMax && 'thought-dial-track--max',
          )}
        >
          {hasFill && (
            <motion.div
              aria-hidden
              initial={false}
              animate={{ width: `${pos}%` }}
              transition={spring}
              className={cn('thought-dial-fill', fillClass(active?.id ?? ''))}
            >
              <ThoughtMaxBlockMatrix active={isCurrentlyMax} />
            </motion.div>
          )}

          <motion.div
            aria-hidden
            initial={false}
            animate={{
              left: `calc(${pos}% - ${(pos / 100) * 16}px)`,
            }}
            transition={spring}
            className={cn(
              'thought-dial-thumb',
              isCurrentlyMax && 'thought-dial-thumb--max',
            )}
          >
            <span
              className={cn(
                'w-0.5 h-2 rounded-full transition-colors',
                isCurrentlyMax ? 'bg-sky-400' : 'bg-slate-300',
              )}
            />
          </motion.div>
        </div>
      </div>

      <div className="flex justify-between mt-1.5 px-1">
        {steps.map((step, i) => {
          const isActive = i === index
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => setIndex(i)}
              className={cn(
                'text-[10.5px] leading-none py-0.5 transition-colors duration-150 select-none font-medium cursor-pointer',
                isActive
                  ? 'text-sky-600 dark:text-sky-400 font-semibold'
                  : 'text-muted-foreground/70 hover:text-foreground',
              )}
            >
              {step.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default ThoughtDial

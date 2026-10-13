// src/components/ui/OvolveLoader.tsx
/**
 * OvolveLoader (OvolveFlowLoader) — Ovolve Official "Ovolve O" Seamless Fluid Loader
 *
 * Design coordinates 180×180:
 * Three 120° equidistant points expand into a seamless conic gradient ring
 * (Neon Cyan #00e1ff -> Violet #9d4edd -> Coral Pink #ff5e7e -> Cobalt Blue #0055ff -> Neon Cyan #00e1ff)
 * and contract back to three points with momentum, completing in 2.6s.
 */
import React, { useId } from 'react'
import { cn } from '@/lib/utils'

const DESIGN = 180

const CONIC_GRADIENT =
  'conic-gradient(from 0deg, #00e1ff 0%, #9d4edd 33.3%, #ff5e7e 55%, #0055ff 66.6%, #00e1ff 100%)'

export interface OvolveLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Size in pixels (applies to width & height). Default is 32. */
  size?: number | string
  /** Stroke width in SVG coordinate space (default is auto pixel-fitted). */
  strokeWidth?: number
  /** Animation duration in seconds. Default is 2.6s. */
  duration?: number
  className?: string
  style?: React.CSSProperties
}

export const OvolveLoader: React.FC<OvolveLoaderProps> = ({
  size = 32,
  strokeWidth,
  duration = 2.6,
  className = '',
  style,
  ...rest
}) => {
  const numericSize = typeof size === 'number' ? size : parseInt(size, 10) || 32
  const pixelSize = typeof size === 'number' ? `${size}px` : size
  const rawId = useId()
  const maskId = `ov-flow-mask-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const scale = numericSize / DESIGN

  // Adapt stroke-width for small viewports (< 20px) to prevent subpixel interpolation blur
  const effectiveStroke = strokeWidth ?? (numericSize < 20 ? 22 : 16)

  const css = `
    @keyframes ov-arc-flow-${maskId} {
      0%, 10% { stroke-dasharray: 0.1 352; stroke-dashoffset: 0; }
      40%, 70% { stroke-dasharray: 122 230; stroke-dashoffset: -61; }
      96%, 100% { stroke-dasharray: 0.1 352; stroke-dashoffset: 0; }
    }
    @keyframes ov-spin-momentum-${maskId} {
      0%, 35% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .${maskId}-arc {
      fill: none;
      stroke: #ffffff;
      stroke-width: ${effectiveStroke};
      stroke-linecap: round;
      transform-origin: ${DESIGN / 2}px ${DESIGN / 2}px;
      animation: ov-arc-flow-${maskId} ${duration}s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .${maskId}-arc-1 { transform: rotate(-90deg); }
    .${maskId}-arc-2 { transform: rotate(30deg); }
    .${maskId}-arc-3 { transform: rotate(150deg); }
    .${maskId}-rotator {
      width: 100%;
      height: 100%;
      animation: ov-spin-momentum-${maskId} ${duration}s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .${maskId}-rotator, .${maskId}-arc { animation: none !important; }
    }
  `

  return (
    <div
      className={cn('inline-flex items-center justify-center relative select-none shrink-0', className)}
      style={{ width: pixelSize, height: pixelSize, overflow: 'visible', ...style }}
      role="status"
      aria-label="Loading"
      {...rest}
    >
      <style>{css}</style>
      <div
        style={{
          width: DESIGN,
          height: DESIGN,
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center',
        }}
      >
        <div className={`${maskId}-rotator`}>
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: '50%',
              background: CONIC_GRADIENT,
              WebkitMask: `url(#${maskId})`,
              mask: `url(#${maskId})`,
            }}
          />
        </div>
      </div>
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={DESIGN} height={DESIGN}>
            <circle className={`${maskId}-arc ${maskId}-arc-1`} cx={DESIGN / 2} cy={DESIGN / 2} r={56} />
            <circle className={`${maskId}-arc ${maskId}-arc-2`} cx={DESIGN / 2} cy={DESIGN / 2} r={56} />
            <circle className={`${maskId}-arc ${maskId}-arc-3`} cx={DESIGN / 2} cy={DESIGN / 2} r={56} />
          </mask>
        </defs>
      </svg>
    </div>
  )
}

export const OvolveFlowLoader = OvolveLoader
export default OvolveLoader

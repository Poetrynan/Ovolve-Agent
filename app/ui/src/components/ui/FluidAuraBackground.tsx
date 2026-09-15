// src/components/ui/FluidAuraBackground.tsx
// Ambient low-saturation fluid aura / mesh glow background.
// Sits behind the entire application, shining softly through all frosted glass panels.
import React from 'react'

export const FluidAuraBackground: React.FC = () => {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
      aria-hidden="true"
    >
      {/* Aurora Orb 1: Cyan / Sky Blue (Top Center / Left) */}
      <div
        className="absolute -top-[15%] left-[10%] w-[55vw] h-[55vh] rounded-full opacity-35 dark:opacity-20 blur-[100px] animate-aura-slow-1 mix-blend-multiply dark:mix-blend-screen"
        style={{
          background: 'radial-gradient(circle, rgba(56, 189, 248, 0.45) 0%, rgba(14, 165, 233, 0.15) 50%, transparent 75%)',
        }}
      />

      {/* Aurora Orb 2: Royal Blue / Indigo (Center Right) */}
      <div
        className="absolute top-[20%] -right-[10%] w-[50vw] h-[60vh] rounded-full opacity-30 dark:opacity-22 blur-[120px] animate-aura-slow-2 mix-blend-multiply dark:mix-blend-screen"
        style={{
          background: 'radial-gradient(circle, rgba(99, 102, 241, 0.40) 0%, rgba(79, 70, 229, 0.15) 50%, transparent 75%)',
        }}
      />

      {/* Aurora Orb 3: Violet / Purple / Magenta (Bottom Center / Left) */}
      <div
        className="absolute -bottom-[20%] left-[25%] w-[60vw] h-[60vh] rounded-full opacity-25 dark:opacity-18 blur-[110px] animate-aura-slow-3 mix-blend-multiply dark:mix-blend-screen"
        style={{
          background: 'radial-gradient(circle, rgba(168, 85, 247, 0.35) 0%, rgba(147, 51, 234, 0.12) 50%, transparent 75%)',
        }}
      />

      {/* Aurora Orb 4: Subtle Warm Amber / Rose highlight (Top Right) */}
      <div
        className="absolute top-[5%] right-[25%] w-[35vw] h-[35vh] rounded-full opacity-20 dark:opacity-12 blur-[90px] animate-aura-slow-4 mix-blend-multiply dark:mix-blend-screen"
        style={{
          background: 'radial-gradient(circle, rgba(244, 114, 182, 0.30) 0%, rgba(251, 146, 60, 0.10) 60%, transparent 80%)',
        }}
      />

      {/* Micro Subtle Noise / Texture overlay for realistic physical glass diffraction */}
      <div className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] bg-repeat bg-[radial-gradient(#000_1px,transparent_1px)] [background-size:16px_16px]" />
    </div>
  )
}

export default FluidAuraBackground

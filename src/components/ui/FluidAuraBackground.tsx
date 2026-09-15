import React from 'react'

export const FluidAuraBackground: React.FC = () => {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10 select-none">
      {/* Top Left: Indigo Glow */}
      <div
        className="absolute -top-[20%] -left-[10%] w-[55vw] h-[55vw] rounded-full bg-indigo-500/8 dark:bg-indigo-600/10 blur-[130px] animate-pulse"
        style={{ animationDuration: '12s' }}
      />

      {/* Top Right: Sky Cyan Glow */}
      <div
        className="absolute top-[5%] -right-[15%] w-[50vw] h-[50vw] rounded-full bg-sky-400/8 dark:bg-sky-500/10 blur-[140px] animate-pulse"
        style={{ animationDuration: '16s' }}
      />

      {/* Bottom Center: Amber & Fuchsia Accents */}
      <div
        className="absolute -bottom-[15%] left-[20%] w-[60vw] h-[45vw] rounded-full bg-fuchsia-500/6 dark:bg-fuchsia-600/8 blur-[150px] animate-pulse"
        style={{ animationDuration: '14s' }}
      />
      <div className="absolute top-[40%] left-[30%] w-[35vw] h-[35vw] rounded-full bg-amber-400/4 dark:bg-amber-500/6 blur-[120px]" />
    </div>
  )
}

export default FluidAuraBackground

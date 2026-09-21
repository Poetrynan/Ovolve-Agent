// src/components/settings/SettingRow.tsx
// The row primitive every setting uses: label + description on the left, one
// control on the right.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SettingRow({
  title, description, control, icon: Icon, htmlFor, className,
}: {
  title: string
  description?: string
  control: ReactNode
  icon?: any
  /** When set the whole row becomes a <label>, so clicking the text hits the control. */
  htmlFor?: string
  className?: string
}) {
  const body = (
    <>
      {Icon && (
        <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 text-muted-foreground mt-0.5 border border-border/40">
          <Icon className="w-4 h-4" />
        </div>
      )}
      <div className="flex-1 min-w-0 space-y-0.5">
        <span className="text-xs sm:text-sm font-semibold text-foreground block">{title}</span>
        {description && (
          <span className="text-[11px] sm:text-xs text-muted-foreground/80 block leading-relaxed">
            {description}
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center">{control}</div>
    </>
  )

  const shell = cn(
    'flex items-start sm:items-center gap-3.5 px-4 sm:px-5 py-3.5 sm:py-4 transition-colors',
    htmlFor && 'cursor-pointer hover:bg-muted/30',
    className,
  )

  return htmlFor
    ? <label htmlFor={htmlFor} className={shell}>{body}</label>
    : <div className={shell}>{body}</div>
}

/**
 * Groups rows into one bordered block with hairline dividers.
 */
export function SettingGroup({
  title, description, children, className,
}: {
  title?: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-2.5', className)}>
      {(title || description) && (
        <div className="px-1 space-y-0.5">
          {title && <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h3>}
          {description && <p className="text-xs text-muted-foreground/70 leading-relaxed">{description}</p>}
        </div>
      )}
      <div className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md divide-y divide-border/30 overflow-hidden shadow-xs">
        {children}
      </div>
    </div>
  )
}

/**
 * Section header for the content pane.
 */
export function SettingSection({
  title, description, action, children,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <h2 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">{title}</h2>
          {description && <p className="text-xs sm:text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-6">
        {children}
      </div>
    </div>
  )
}

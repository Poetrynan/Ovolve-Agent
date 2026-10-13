// src/components/chat/PermissionSelector.tsx
// The ONE per-turn control: how much rope does the agent get?
// Mirrors backend `risk_control.PermissionMode` (plan / confirm / auto / full).
//
// This used to be two dropdowns — a Mode picker (Ask/Plan/Edit/Agent) next to a
// Permission picker — which made the user reason about a 12-cell matrix before
// typing anything. The product IS an agent, so the only real question is how much
// it may do without asking. Plan survived the merge because it carries intent
// ("investigate, then write a plan and stop"), not just a write ban.
//
// `readonly` exists in the backend enum for sub-agents but is deliberately NOT
// offered here: plan covers the same write ban and gives the user something back.
import { useState } from 'react'
import { Hand, ShieldCheck, ClipboardList, AlertCircle, ChevronDown, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'
import { useSessionConfigStore, type PermissionLevel } from '@store/sessionConfigStore'
import { cn } from '@lib/utils'

interface PermDef {
  id: PermissionLevel
  labelKey: string
  descKey: string
  icon: typeof ShieldCheck
  color: string
  bg: string
  /** Hairline outline on the selected row. Without it the two neutral levels
      (plan / confirm)只有 bg-accent，而 bg-accent 同时也是 hover 色——选中态
      就跟“鼠标刚好停在上面”长得一样，看着像没上色。 */
  ring: string
}

/**
 * Ordered least → most autonomous, so the list reads as a single dial: each step
 * down hands the agent more rope. That monotonicity is the whole point of having
 * merged the two axes — it makes "further down = less asking" a rule the user
 * learns once. It also leaves 完全访问 at the bottom, the hardest slot to hit by
 * accident.
 *
 * `plan` leads because it is the only level where NO write happens at all;
 * `confirm` still writes, it just asks first. Same order as the backend enum
 * declaration in `risk_control.PermissionMode` (minus `readonly`, see above).
 */
export const PERMISSIONS: PermDef[] = [
  {
    id: 'plan',
    labelKey: 'permission.plan',
    descKey: 'permission.planDesc',
    icon: ClipboardList,
    color: 'text-foreground',
    bg: 'bg-primary/8',
    ring: 'ring-1 ring-inset ring-primary/20',
  },
  {
    id: 'confirm',
    labelKey: 'permission.confirm',
    descKey: 'permission.confirmDesc',
    icon: Hand,
    color: 'text-foreground',
    bg: 'bg-primary/8',
    ring: 'ring-1 ring-inset ring-primary/20',
  },
  {
    id: 'auto',
    labelKey: 'permission.auto',
    descKey: 'permission.autoDesc',
    icon: ShieldCheck,
    color: 'text-success',
    bg: 'bg-success/10',
    ring: 'ring-1 ring-inset ring-success/25',
  },
  {
    id: 'full',
    labelKey: 'permission.full',
    descKey: 'permission.fullDesc',
    icon: AlertCircle,
    color: 'text-warning',
    bg: 'bg-warning/10',
    ring: 'ring-1 ring-inset ring-warning/25',
  },
]

export function PermissionSelector() {
  const { t } = useTranslation()
  const { permission, setPermission } = useSessionConfigStore()
  const [open, setOpen] = useState(false)
  // Fall back by id, not by index — `readonly` (sub-agent only) and any future
  // level would otherwise land on whichever entry happens to sit at [0].
  const current =
    PERMISSIONS.find((p) => p.id === permission) ?? PERMISSIONS.find((p) => p.id === 'auto')!
  const CurrentIcon = current.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid="chat-permission-select-trigger"
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-xl text-xs font-medium transition-all press-feedback',
            'hover:bg-foreground/5',
            current.color,
          )}
        >
          <CurrentIcon size={13} />
          <span>{t(current.labelKey)}</span>
          <ChevronDown size={11} className="opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[270px] p-1.5 rounded-2xl border border-border/60 bg-popover/90 backdrop-blur-2xl shadow-xl" data-testid="chat-permission-select-group">
        <div className="space-y-0.5">
          {PERMISSIONS.map((p) => {
            const Icon = p.icon
            const active = permission === p.id
            return (
              <button
                key={p.id}
                data-testid="chat-permission-select-item"
                onClick={() => {
                  setPermission(p.id)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-start gap-2 px-2.5 py-2 rounded-xl text-left',
                  'transition-all duration-150',
                  active
                    ? `${p.bg} ${p.color} ${p.ring} shadow-2xs`
                    : 'hover:bg-accent/60 text-foreground',
                )}
              >
                {/* Optical alignment: the glyph's visual centre sits slightly below
                    its box top, so 2px lines it up with the cap-height of the label
                    rather than with the label's box. */}
                <Icon
                  size={13}
                  className={cn('mt-[2px] shrink-0', active ? p.color : 'text-muted-foreground')}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium leading-none">{t(p.labelKey)}</div>
                  {/* 1.45 leading on 10.5px CJK: tight enough that the two lines read
                      as one block under the label, loose enough not to smear. */}
                  <div className="mt-1 text-[10.5px] leading-[1.45] text-muted-foreground/85">
                    {t(p.descKey)}
                  </div>
                </div>
                {/* Reserve the tick column on every row so the label block does not
                    shift horizontally when the selection moves. */}
                <span className="w-3 shrink-0 mt-[2px]">
                  {active && <Check size={11} className="opacity-70" />}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

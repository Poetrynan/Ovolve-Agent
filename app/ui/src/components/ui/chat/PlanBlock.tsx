// src/components/ui/chat/PlanBlock.tsx
// Renders a GFM task list (`- [ ] step` / `- [x] step`) as an interactive-looking
// plan card with a progress bar, instead of raw markdown checkboxes.
//
// The model emits plans as task lists all the time ("here's my plan: - [ ] …").
// remark-gfm turns those into <ul class="contains-task-list"> with <li> children
// whose first child is a disabled <input type="checkbox">. MarkdownContent routes
// such a <ul> here so the user gets a glanceable "3/7 done" header and checked
// steps visually struck through — the same affordance a real todo panel gives.
//
// Checkboxes stay READ-ONLY: this is the model's plan, not a user todo store.
// Letting the user tick a box would imply persistence we don't have, and would
// desync the moment the model re-emits the plan. Progress is derived, not stored.
import { type ReactNode } from 'react'
import { CheckCircle2, Circle, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// A minimal shape of the hast node react-markdown hands to component overrides.
interface HastNode {
  children?: Array<{
    type?: string
    tagName?: string
    properties?: Record<string, unknown>
    children?: Array<{
      tagName?: string
      properties?: Record<string, unknown>
    }>
  }>
}

interface PlanItem {
  checked: boolean
}

/** Walk the <ul> hast node and pull out one {checked} per task-list <li>. */
function extractItems(node: HastNode | undefined): PlanItem[] {
  const items: PlanItem[] = []
  for (const li of node?.children ?? []) {
    if (li.tagName !== 'li') continue
    // A task-list <li>'s first element child is <input type=checkbox [checked]>.
    const input = (li.children ?? []).find((c) => c.tagName === 'input')
    if (!input) continue // not a checkbox item — skip, keeps mixed lists honest
    items.push({ checked: Boolean(input.properties?.checked) })
  }
  return items
}

interface Props {
  node?: HastNode
  children?: ReactNode
}

export function PlanBlock({ node, children }: Props) {
  const { t } = useTranslation()
  const items = extractItems(node)
  const total = items.length
  const done = items.filter((i) => i.checked).length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const allDone = total > 0 && done === total

  return (
    <div className="my-2 rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 bg-muted/30">
        <ListChecks size={13} className="text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('plan.title')}
        </span>
        <div className="flex-1" />
        <span className={cn('text-[11px] font-semibold tabular-nums',
          allDone ? 'text-success' : 'text-muted-foreground')}>
          {done}/{total}
        </span>
      </div>
      {/* Progress bar. Width is the only thing that animates as the model streams
          more checked items in. */}
      <div className="h-1 bg-muted/50">
        <div
          className={cn('h-full transition-all duration-300',
            allDone ? 'bg-success' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="px-3 py-2 space-y-1">{children}</ul>
    </div>
  )
}

/**
 * A single task-list <li>. Replaces the raw disabled checkbox with a lucide icon
 * and strikes through completed steps. Non-task list items (no checkbox) fall
 * back to a plain bullet so a mixed list still reads correctly.
 */
export function PlanItemRow({ node, children }: {
  node?: { children?: Array<{ tagName?: string; properties?: Record<string, unknown> }> }
  children?: ReactNode
}) {
  const input = (node?.children ?? []).find((c) => c.tagName === 'input')
  const isTask = Boolean(input)
  const checked = Boolean(input?.properties?.checked)

  if (!isTask) {
    return <li className="list-disc ml-4 leading-relaxed text-sm">{children}</li>
  }
  return (
    <li className="flex items-start gap-2 leading-relaxed">
      {checked
        ? <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />
        : <Circle size={14} className="text-muted-foreground/50 shrink-0 mt-0.5" />}
      <span className={cn('text-sm', checked && 'line-through text-muted-foreground')}>
        {children}
      </span>
    </li>
  )
}

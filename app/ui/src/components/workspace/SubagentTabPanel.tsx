/**
 * SubagentTabPanel — the workspace SidePanel's Sub-agents tab.
 *
 * Master-detail, stacked vertically because the side panel is narrow: the
 * roster on top, the selected child's full transcript below. This is the
 * "keep an eye on the fan-out while reading something else" surface — the chat
 * panel's inline expansion is for when you're already looking at the batch.
 *
 * Selection lives in `agentStore.selectedSubagentId` rather than local state, so
 * the choice survives tab switches within the panel.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Loader2, StopCircle, Users, XCircle } from 'lucide-react'
import { cn } from '@lib/utils'
import { useAgentStore } from '@store/agentStore'
import { killSubagent } from '@components/chat/SubagentPanel'
import { SubagentActivityView } from '../chat/SubagentActivityView'
import type { SubagentStatus } from '@apptypes/index'

const TERMINAL: SubagentStatus[] = ['completed', 'error', 'killed', 'timeout', 'stale']

function StatusGlyph({ status }: { status: SubagentStatus }) {
 const cls = 'h-3.5 w-3.5 shrink-0'
 switch (status) {
 case 'spawning': return <Clock className={cn(cls, 'text-muted-foreground')} />
 case 'running': return <Loader2 className={cn(cls, 'text-foreground animate-spin')} />
 case 'completed': return <CheckCircle2 className={cn(cls, 'text-success')} />
 case 'killed': return <StopCircle className={cn(cls, 'text-warning')} />
 case 'timeout': return <XCircle className={cn(cls, 'text-warning')} />
 // Ran out of steps without declaring done — the result exists but is partial.
 case 'stale': return <AlertTriangle className={cn(cls, 'text-warning')} />
 default: return <XCircle className={cn(cls, 'text-destructive')} />
 }
}

function formatElapsed(ms: number): string {
 if (!ms || ms < 0) return ''
 if (ms < 1000) return `${ms}ms`
 const s = ms / 1000
 if (s < 60) return `${s.toFixed(1)}s`
 const m = Math.floor(s / 60)
 return `${m}m ${Math.floor(s - m * 60)}s`
}

export function SubagentTabPanel() {
 const { t } = useTranslation()
 const subagents = useAgentStore((s) => s.subagents)
 const selectedId = useAgentStore((s) => s.selectedSubagentId)
 const selectSubagent = useAgentStore((s) => s.selectSubagent)
 // 正在停止中的子代理 id 集合：按钮转圈防连点
 const [killing, setKilling] = useState<Set<string>>(new Set())

 const handleStop = (subagentId: string) => {
 setKilling((prev) => new Set(prev).add(subagentId))
 void killSubagent(subagentId).finally(() => {
 setKilling((prev) => {
 const next = new Set(prev)
 next.delete(subagentId)
 return next
 })
 })
 }

 if (subagents.length === 0) {
 return (
 <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6">
 <Users size={28} strokeWidth={1.5} className="text-muted-foreground/40" />
 <div className="text-[13px] font-medium text-foreground/80">
 {t('sidePanel.tabs.subagents')}
 </div>
 <div className="text-xs text-muted-foreground/80 max-w-[230px] leading-relaxed">
 {t('subagentActivity.tabEmpty')}
 </div>
 </div>
 )
 }

 // Fall back to the first row rather than showing an empty detail pane: with a
 // roster on screen, "nothing selected" is a dead end the user has to click out
 // of for no reason.
 const current = subagents.find((s) => s.subagentId === selectedId) ?? subagents[0]
 const active = subagents.filter((s) => !TERMINAL.includes(s.status)).length

 return (
 <div className="flex flex-col h-full">
 <div
 className={cn(
 // Give the roster room to breathe without a nagging inner scrollbar:
 // 40% of the panel height is enough to see ~6-8 rows on a normal
 // window, and the detail pane below always fills whatever is left.
 'shrink-0 overflow-y-auto p-1.5 space-y-0.5',
 'border-b border-border/50 bg-muted/20',
 )}
 style={{ maxHeight: '40%' }}
 >
 <div className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1.5">
 <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
 {t('subagentPanel.title')}
 </span>
 <span className="text-[10px] text-muted-foreground/60 tabular-nums">
 {active}/{subagents.length}
 </span>
 </div>
 {subagents.map((s) => {
 const selected = s.subagentId === current.subagentId
 return (
 <button
 key={s.subagentId}
 type="button"
 onClick={() => selectSubagent(s.subagentId)}
 className={cn(
 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left',
 'transition-[background-color] duration-150 ease-out',
 selected
 ? 'bg-accent shadow-sm ring-1 ring-border/60'
 : 'hover:bg-accent/50',
 )}
 >
 <StatusGlyph status={s.status} />
 <div className="min-w-0 flex-1">
 <div className="flex items-center gap-1.5">
 <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
 {s.subagentType}
 </span>
 <span className="text-xs text-foreground truncate">
 {s.label || s.subagentType}
 </span>
 </div>
 {(s.elapsedMs > 0 || s.error) && (
 <div className="text-[10px] text-muted-foreground/70 truncate" title={s.error || undefined}>
 {formatElapsed(s.elapsedMs)}
 {s.error && <span className="text-destructive"> · {s.error}</span>}
 </div>
 )}
 </div>
 {!TERMINAL.includes(s.status) && (
 <>
 {killing.has(s.subagentId) ? (
 <Loader2 size={13} className="animate-spin text-muted-foreground shrink-0" />
 ) : (
 <button
 type="button"
 title={t('subagentPanel.kill', '终止')}
 aria-label={t('subagentPanel.kill', '终止')}
 onClick={(e) => {
 e.stopPropagation()
 handleStop(s.subagentId)
 }}
 className="shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
 >
 <StopCircle size={13} />
 </button>
 )}
 <span className="text-[10px] text-foreground shrink-0">
 {t(`subagentPanel.status.${s.status}`)}
 </span>
 </>
 )}
 </button>
 )
 })}
 </div>
 <div className="flex-1 overflow-y-auto">
 <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-background/60">
 <StatusGlyph status={current.status} />
 <div className="min-w-0 flex-1">
 <div className="text-xs font-medium truncate">
 {current.label || current.subagentType}
 </div>
 <div className="text-[10px] text-muted-foreground truncate">
 {current.subagentType}
 {current.elapsedMs > 0 && <span> · {formatElapsed(current.elapsedMs)}</span>}
 </div>
 </div>
 </div>
 <SubagentActivityView subagentId={current.subagentId} />
 </div>
 </div>
 )
}

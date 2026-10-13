// src/components/workspace/SidePanel.tsx
// The right-hand workspace column: one strip of tabs holding *what the user
// opened*, plus a picker for opening more.
//
// This column used to carry two stacked tab rows. `ChatPage` chose between
// Git / Files / Browser, and only after picking "Files" did this component
// reveal a second row of five. Both rows competed for a ~300px column, and the
// inner one gave every tab `flex-1`, so each Chinese label got a fifth of the
// width and `truncate` cut it to a single character (文 / 产 / 自 / 子). The
// guard meant to prevent that — `hidden sm:inline-block` — never fired, because
// `sm` is a *viewport* breakpoint and the viewport was never the narrow thing.
//
// Flattening to a single strip whose length the user chooses removes the cause
// instead of restyling the symptom: the full inventory lives in the picker (the
// empty state, and the `+` menu), so the strip only ever holds as many tabs as
// were asked for. The Git panel's own contents are untouched — it is simply one
// of the things the strip can hold.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
 FolderTree, Workflow, Users, Package, GitBranch, Globe, Plus, X, Sparkles, FileCode, TerminalSquare, AlertTriangle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { FileTreePanel } from './FileTreePanel'
import { CodeEditorPanel } from './CodeEditorPanel'
import { ArtifactPanel } from './ArtifactPanel'
import { SubagentTabPanel } from './SubagentTabPanel'
import { SessionLearningPanel } from './SessionLearningPanel'
import { AgentDirectoryPanel } from '@components/agents/AgentDirectoryPanel'
import { BrowserPanel } from '@components/browser/BrowserPanel'
import { TerminalPanel } from './TerminalPanel'
import { useAgentStore } from '@store/agentStore'
import { useCronStore } from '@store/cronStore'
import { useSidePanelStore, type SidePanelTabId, type StaticSidePanelTabId, isTerminalTabId, terminalSessionId } from '@store/sidePanelStore'
import {
 DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@components/ui/tooltip'
import { cn } from '@lib/utils'

interface TabDef {
 id: StaticSidePanelTabId
 /** i18n key under `sidePanel.tabs`; the picker blurb is `sidePanel.picker.desc.<id>`. */
 labelKey: string
 icon: typeof FolderTree
 color: string
 bgGlow: string
 /** `onCollapse` hides the whole column — only the Git rail asks for it. */
 render: (ctx: { onCollapse: () => void }) => ReactNode
}

const TABS: TabDef[] = [
 { id: 'session_learning', labelKey: 'session_learning', icon: Sparkles, color: 'text-amber-500', bgGlow: 'bg-amber-500/10 border-amber-500/25', render: () => <SessionLearningPanel /> },
 { id: 'editor', labelKey: 'editor', icon: FileCode, color: 'text-blue-500', bgGlow: 'bg-blue-500/10 border-blue-500/25', render: () => <CodeEditorPanel /> },
 {
 id: 'git',
 labelKey: 'git',
 icon: GitBranch,
 color: 'text-emerald-500',
 bgGlow: 'bg-emerald-500/10 border-emerald-500/25',
 render: ({ onCollapse }) => <AgentDirectoryPanel open onToggle={onCollapse} />,
 },
 { id: 'files', labelKey: 'files', icon: FolderTree, color: 'text-sky-500', bgGlow: 'bg-sky-500/10 border-sky-500/25', render: ({ onCollapse }) => <FileTreePanel onCollapse={onCollapse} /> },
 { id: 'artifacts', labelKey: 'artifacts', icon: Package, color: 'text-indigo-500', bgGlow: 'bg-indigo-500/10 border-indigo-500/25', render: () => <ArtifactPanel /> },
 { id: 'automations', labelKey: 'automations', icon: Workflow, color: 'text-purple-500', bgGlow: 'bg-purple-500/10 border-purple-500/25', render: () => <AutomationsTab /> },
 { id: 'subagents', labelKey: 'subagents', icon: Users, color: 'text-rose-500', bgGlow: 'bg-rose-500/10 border-rose-500/25', render: () => <SubagentTabPanel /> },
 { id: 'browser', labelKey: 'browser', icon: Globe, color: 'text-cyan-500', bgGlow: 'bg-cyan-500/10 border-cyan-500/25', render: () => <BrowserPanel /> },
]

/**
 * Empty / not-yet-built state.
 */
function PlaceholderPanel({
 icon: Icon, title, hint,
}: { icon: typeof FolderTree; title: string; hint: string }) {
 return (
 <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6 select-none">
 <Icon size={28} strokeWidth={1.5} className="text-muted-foreground/40" />
 <div className="text-[13px] font-medium text-foreground/80">{title}</div>
 <div className="text-xs text-muted-foreground/80 max-w-[230px] leading-relaxed">{hint}</div>
 </div>
 )
}

/** Poll interval while the Automations tab is on screen. */
const CRON_REFRESH_MS = 30_000

function terminalTabLabel(tabId: string, names: Record<string, string>, t: (key: string, options?: any) => string): string {
  // 名字在 openTerminalTab 里创建时定死并持久化（sidePanelStore）。
  // 旧渲染按"当前第几个终端 tab"推导序号，关掉中间一个会让其余全部改名。
  return names[tabId] || t('sidePanel.tabs.terminal', { defaultValue: '终端' })
}

function renderPanel(tabId: SidePanelTabId, onCollapse: () => void, active: boolean): ReactNode {
 if (isTerminalTabId(tabId)) {
 return <TerminalPanel sessionId={terminalSessionId(tabId)} active={active} />
 }
 const def = TABS.find((x) => x.id === tabId)
 return def ? def.render({ onCollapse }) : null
}

function formatRelative(rtf: Intl.RelativeTimeFormat, epochSec: number, nowMs: number): string {
 const diff = epochSec * 1000 - nowMs
 const abs = Math.abs(diff)
 if (abs < 60_000) return rtf.format(Math.round(diff / 1_000), 'second')
 if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
 if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
 return rtf.format(Math.round(diff / 86_400_000), 'day')
}

function AutomationsTab() {
 const { t, i18n } = useTranslation()
 const navigate = useNavigate()
 const crons = useCronStore((s) => s.crons)
 const loading = useCronStore((s) => s.loading)
 const fetchFailed = useCronStore((s) => s.lastFetchFailed)
 const fetchCrons = useCronStore((s) => s.fetchCrons)
 const [now, setNow] = useState(() => Date.now())

 useEffect(() => {
 void fetchCrons()
 const id = window.setInterval(() => {
 setNow(Date.now())
 void fetchCrons()
 }, CRON_REFRESH_MS)
 return () => window.clearInterval(id)
 }, [fetchCrons])

 const rtf = useMemo(
 () => new Intl.RelativeTimeFormat(i18n.language || 'zh', { numeric: 'auto' }),
 // eslint-disable-next-line react-hooks/exhaustive-deps
 [i18n.language],
 )

 // 读取失败与"没有任务"此前显示成同一个空态，用户分不清是没数据还是坏了。
 if (fetchFailed && crons.length === 0) {
 return (
 <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6 select-none">
 <AlertTriangle size={28} strokeWidth={1.5} className="text-destructive/60" />
 <div className="text-[13px] font-medium text-foreground/80">{t('sidePanel.automations.fetchFailedTitle', '自动化状态读取失败')}</div>
 <button
 type="button"
 onClick={() => { void fetchCrons() }}
 className="text-xs text-primary hover:underline"
 >
 {t('sidePanel.automations.fetchFailedRetry', '点击重试')}
 </button>
 </div>
 )
 }

 if (crons.length === 0) {
 return (
 <PlaceholderPanel
 icon={Workflow}
 title={t('sidePanel.automations.title')}
 hint={loading ? t('sidePanel.automations.loading') : t('sidePanel.automations.hint')}
 />
 )
 }

 return (
 <div className="h-full overflow-y-auto px-2 py-2 space-y-1 select-none">
 {crons.map((cron) => {
 const active = cron.status === 'active'
 return (
 <div
 key={cron.id}
 role="button"
 tabIndex={0}
 title={t('sidePanel.automations.openManager', '打开定时任务管理')}
 onClick={() => navigate('/cron')}
 onKeyDown={(e) => {
 if (e.key === 'Enter' || e.key === ' ') {
 e.preventDefault()
 navigate('/cron')
 }
 }}
 className="rounded-xl px-2.5 py-2 hover:bg-card/50 transition-colors duration-150 border border-transparent hover:border-border/40 cursor-pointer"
 >
 <div className="flex items-center gap-1.5">
 <span
 className={cn(
 'size-1.5 rounded-full shrink-0',
 active ? 'bg-emerald-500' : 'bg-muted-foreground/35',
 )}
 />
 <span className="text-xs font-medium text-foreground/90 truncate">
 {cron.task_name || cron.id}
 </span>
 <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
 {t(`sidePanel.automations.status.${cron.status}`, cron.status)}
 </span>
 </div>
 <div className="mt-0.5 pl-3 flex items-center gap-2 text-[10px] text-muted-foreground/80">
 <code className="font-mono truncate">{cron.expression}</code>
 {cron.run_count > 0 && (
 <span className="shrink-0 tabular-nums">
 {t('sidePanel.automations.runCount', { n: cron.run_count })}
 </span>
 )}
 </div>
 {active && cron.next_run > 0 && (
 <div className="mt-0.5 pl-3 text-[10px] text-muted-foreground/80">
 {t('sidePanel.automations.nextRun', {
 when: formatRelative(rtf, cron.next_run, now),
 })}
 </div>
 )}
 </div>
 )
 })}
 </div>
 )
}

/**
 * The column's empty state: IDE-style Centered Tool Card Grid.
 */
function PanelPicker({
 openTabs, onPick, onNewTerminal,
}: {
 openTabs: SidePanelTabId[]
 onPick: (id: SidePanelTabId) => void
 onNewTerminal: () => void
}) {
 const { t } = useTranslation()

 // IDE-style tool definitions in order
 const TOOLS: Array<{
 id: SidePanelTabId | 'terminal'
 label: string
 icon: typeof FolderTree
 color: string
 action: () => void
 isTerminal?: boolean
 }> = [
 {
 id: 'editor',
 label: t('sidePanel.tabs.editor'),
 icon: FileCode,
 color: 'text-emerald-400',
 action: () => onPick('editor'),
 },
 {
 id: 'files',
 label: t('sidePanel.tabs.files'),
 icon: FolderTree,
 color: 'text-sky-400',
 action: () => onPick('files'),
 },
 {
 id: 'terminal',
 label: t('sidePanel.tabs.terminal'),
 icon: TerminalSquare,
 color: 'text-zinc-300',
 action: onNewTerminal,
 isTerminal: true,
 },
 {
 id: 'browser',
 label: t('sidePanel.tabs.browser'),
 icon: Globe,
 color: 'text-cyan-400',
 action: () => onPick('browser'),
 },
 {
 id: 'git',
 label: t('sidePanel.tabs.git'),
 icon: GitBranch,
 color: 'text-emerald-400',
 action: () => onPick('git'),
 },
 {
 id: 'session_learning',
 label: t('sidePanel.tabs.session_learning'),
 icon: Sparkles,
 color: 'text-amber-400',
 action: () => onPick('session_learning'),
 },
 {
 id: 'artifacts',
 label: t('sidePanel.tabs.artifacts'),
 icon: Package,
 color: 'text-indigo-400',
 action: () => onPick('artifacts'),
 },
 {
 id: 'subagents',
 label: t('sidePanel.tabs.subagents'),
 icon: Users,
 color: 'text-rose-400',
 action: () => onPick('subagents'),
 },
 {
 id: 'automations',
 label: t('sidePanel.tabs.automations'),
 icon: Workflow,
 color: 'text-purple-400',
 action: () => onPick('automations'),
 },
 ]

 return (
 <div className="h-full flex flex-col items-center justify-center p-6 select-none overflow-y-auto">
 <div className="w-full max-w-[340px] flex flex-col items-center">
 <h2 className="text-xl font-bold text-foreground/95 tracking-tight">
 {t('sidePanel.picker.title')}
 </h2>
 <p className="mt-1.5 text-xs text-muted-foreground/75 text-center">
 {t('sidePanel.picker.hint')}
 </p>

 <div className="mt-8 grid grid-cols-3 gap-3 w-full">
 {TOOLS.map((tool) => {
 const Icon = tool.icon
 const isOpen = !tool.isTerminal && openTabs.includes(tool.id as SidePanelTabId)
 const desc = t(`sidePanel.picker.desc.${tool.id}`)

 return (
 <Tooltip key={tool.id}>
 <TooltipTrigger asChild>
 <button
 type="button"
 onClick={tool.action}
 className={cn(
 'group relative flex flex-col items-center justify-center h-24 rounded-2xl p-2 text-center transition-all duration-200 cursor-pointer',
 'bg-card/40 hover:bg-card/85 border border-border/40 hover:border-border/80 hover:shadow-lg hover:-translate-y-0.5 press-feedback',
 isOpen && 'ring-1 ring-primary/40 bg-card/60'
 )}
 >
 {isOpen && (
 <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
 )}
 <div className="flex items-center justify-center w-8 h-8 rounded-xl transition-transform duration-200 group-hover:scale-110">
 <Icon size={22} strokeWidth={1.75} className={tool.color} />
 </div>
 <span className="mt-2 text-[12px] font-medium text-foreground/80 group-hover:text-foreground transition-colors truncate max-w-full px-1">
 {tool.label}
 </span>
 </button>
 </TooltipTrigger>
 <TooltipContent side="bottom" sideOffset={6} className="max-w-[200px] text-center text-[11px] leading-relaxed">
 {desc}
 </TooltipContent>
 </Tooltip>
 )
 })}
 </div>
 </div>
 </div>
 )
}

/**
 * The single tab strip.
 */
function TabStrip({ onCollapse }: { onCollapse: () => void }) {
 const { t } = useTranslation()
 const openTabs = useSidePanelStore((s) => s.openTabs)
 const activeTab = useSidePanelStore((s) => s.activeTab)
 const terminalNames = useSidePanelStore((s) => s.terminalNames)
 const setActive = useSidePanelStore((s) => s.setActive)
 const closeTab = useSidePanelStore((s) => s.closeTab)
 const openTab = useSidePanelStore((s) => s.openTab)
 const openTerminalTab = useSidePanelStore((s) => s.openTerminalTab)
 const activeSubagents = useAgentStore(
 (s) => s.subagents.filter((x) => x.status === 'spawning' || x.status === 'running').length,
 )
 const unopened = TABS.filter((x) => !openTabs.includes(x.id))

 // 溢出指示：tab 带可横向滚动但滚动条是隐藏的，多开几个终端后用户
 // 根本不知道右侧还有 tab。两端渐隐是 Cursor 的做法（32px 遮罩）。
 const scrollRef = useRef<HTMLDivElement | null>(null)
 const [canScrollLeft, setCanScrollLeft] = useState(false)
 const [canScrollRight, setCanScrollRight] = useState(false)
 const updateOverflow = useCallback(() => {
 const el = scrollRef.current
 if (!el) return
 setCanScrollLeft(el.scrollLeft > 4)
 setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
 }, [])
 useEffect(() => {
 updateOverflow()
 const el = scrollRef.current
 if (!el) return
 const ro = new ResizeObserver(updateOverflow)
 ro.observe(el)
 return () => ro.disconnect()
 }, [updateOverflow, openTabs])

 return (
 <div className="flex items-center gap-0.5 h-9 px-1.5 border-b border-border/30 bg-muted/5 backdrop-blur-md shrink-0 select-none">
 <div className="relative min-w-0 flex-1">
 <div
 ref={scrollRef}
 onScroll={updateOverflow}
 role="tablist"
 className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
 >
 {openTabs.map((id) => {
 const isTerminal = isTerminalTabId(id)
 const def = isTerminal ? null : TABS.find((x) => x.id === id)
 if (!isTerminal && !def) return null
 const Icon = isTerminal ? TerminalSquare : def!.icon
 const active = activeTab === id
 const label = isTerminal
 ? terminalTabLabel(id, terminalNames, t)
 : t(`sidePanel.tabs.${def!.labelKey}`)
 const color = isTerminal ? 'text-lime-500' : def!.color
 const badge = id === 'subagents' ? activeSubagents : 0
 return (
 <div
 key={id}
 role="tab"
 tabIndex={0}
 aria-selected={active}
 title={label}
 onClick={() => setActive(id)}
 onAuxClick={(e) => {
 if (e.button !== 1) return
 e.preventDefault()
 e.stopPropagation()
 closeTab(id)
 }}
 onKeyDown={(e) => {
 if (e.key === 'Enter' || e.key === ' ') {
 e.preventDefault()
 setActive(id)
 }
 }}
 className={cn(
 'group flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-xl shrink-0 cursor-default border text-[12px] font-medium transition-all duration-150',
 active
 ? 'bg-card/75 text-foreground border-border/60 shadow-2xs backdrop-blur-md'
 : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/40',
 )}
 >
 <Icon size={13} strokeWidth={1.75} className={cn('shrink-0', active ? color : 'text-muted-foreground')} />
 <span className="max-w-[96px] truncate whitespace-nowrap">{label}</span>
 {badge > 0 && (
 <span className="size-4 rounded-full bg-primary/20 text-primary text-[9px] font-mono flex items-center justify-center shrink-0 font-semibold">
 {badge}
 </span>
 )}
 <button
 type="button"
 aria-label={t('sidePanel.closeTab', { name: label })}
 onClick={(e) => {
 e.stopPropagation()
 closeTab(id)
 }}
 className={cn(
 'grid place-items-center size-4 rounded-md shrink-0 text-muted-foreground/70 transition-opacity duration-150 hover:text-foreground hover:bg-foreground/10',
 active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
 )}
 >
 <X size={11} />
 </button>
 </div>
 )
 })}
 </div>
 {canScrollLeft && (
 <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background via-background/70 to-transparent" />
 )}
 {canScrollRight && (
 <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background via-background/70 to-transparent" />
 )}
 </div>

 <DropdownMenu>
 <DropdownMenuTrigger asChild>
 <button
 type="button"
 aria-label={t('sidePanel.openPanel')}
 className="grid place-items-center size-7 rounded-lg shrink-0 text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors duration-150"
 >
 <Plus size={14} />
 </button>
 </DropdownMenuTrigger>
 <DropdownMenuContent align="end" className="w-56 p-1 rounded-2xl border border-border/60 bg-popover/90 backdrop-blur-2xl shadow-xl">
 <DropdownMenuItem
 onSelect={() => openTerminalTab()}
 className="gap-2.5 text-[12px] rounded-xl cursor-pointer"
 >
 <TerminalSquare size={14} strokeWidth={1.75} className="shrink-0 text-lime-500" />
 <span>{t('sidePanel.newTerminal', '新建终端')}</span>
 </DropdownMenuItem>
 {unopened.length > 0 && <div className="my-1 h-px bg-border/50" />}
 {unopened.map((x) => {
 const Icon = x.icon
 return (
 <DropdownMenuItem
 key={x.id}
 onSelect={() => openTab(x.id)}
 className="gap-2.5 text-[12px] rounded-xl cursor-pointer"
 >
 <Icon size={14} strokeWidth={1.75} className={cn('shrink-0', x.color)} />
 <span>{t(`sidePanel.tabs.${x.labelKey}`)}</span>
 </DropdownMenuItem>
 )
 })}
 </DropdownMenuContent>
 </DropdownMenu>

 <button
 type="button"
 aria-label={t('sidePanel.collapse', '收起面板')}
 onClick={onCollapse}
 className="grid place-items-center size-7 rounded-lg shrink-0 text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors duration-150 ml-0.5"
 title={t('sidePanel.collapse', '收起右侧栏')}
 >
 <X size={14} />
 </button>
 </div>
 )
}

export interface SidePanelProps {
 /** Collapses the whole right column. Rendered as the strip's rightmost button. */
 onCollapse?: () => void
}

export function SidePanel({ onCollapse }: SidePanelProps) {
 const openTabs = useSidePanelStore((s) => s.openTabs)
 const activeTab = useSidePanelStore((s) => s.activeTab)
 const openTab = useSidePanelStore((s) => s.openTab)
 const openTerminalTab = useSidePanelStore((s) => s.openTerminalTab)
 const collapse = onCollapse ?? (() => {})

 // 常驻挂载：已打开的面板全部保持挂载，用 display 切换可见性。
 // 此前只渲染激活面板，切 tab 即 unmount——终端 PTY 被杀、浏览器页面重载、
 // 各面板滚动位置丢失（Cursor 的右栏是常驻 AuxiliaryBar，竞品无一这样做）。
 return (
 <TooltipProvider delayDuration={300}>
 <div className="flex flex-col h-full bg-transparent select-none">
 <TabStrip onCollapse={collapse} />
 <div className="relative flex-1 min-h-0 overflow-hidden">
 {!activeTab && (
 <PanelPicker openTabs={openTabs} onPick={openTab} onNewTerminal={openTerminalTab} />
 )}
 {openTabs.map((id) => (
 <div
 key={id}
 className="h-full w-full"
 style={{ display: activeTab === id ? undefined : 'none' }}
 aria-hidden={activeTab !== id}
 >
 {renderPanel(id, collapse, activeTab === id)}
 </div>
 ))}
 </div>
 </div>
 </TooltipProvider>
 )
}

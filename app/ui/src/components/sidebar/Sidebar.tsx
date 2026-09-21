import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  Target, Settings,
  Plus, Search, Pin, PinOff, Pencil, Trash2, Check, X, MoreHorizontal,
  Folder, FolderOpen, ChevronRight, FolderPlus, GitBranch, Copy,
  ExternalLink, EyeOff, Timer, Bot, Blocks, BarChart3, Sparkles, Inbox,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useGitStore } from '@store/gitStore'
import { useAgentStore } from '@store/agentStore'
import { useEvolutionStore } from '@store/evolutionStore'
import { useApprovalsStore } from '@store/approvalsStore'
import {
  useSessionListStore,
  groupByWorkspace,
  relativeTime,
  type SessionSummary,
  type SessionActivity,
} from '@store/sessionListStore'

/** Page nav. `/chat` is deliberately absent — "新对话" IS the way into a
 *  conversation, and clicking any history row already navigates there, so a
 *  separate tab was a redundant third door to the same room.
 *
 *  历史上这批标签曾经被收进"设置"里了；后来觉得该露的还是要露——目标、定时、机器人、
 *  能力、用量，每一项都是用户会**反复回来看**的东西，不是设一次就走的配置。
 *  现在它们各自就是一级页面（`/cron`、`/bot`、`/capabilities`、`/usage`），不再是设置页
 *  的子章节别名——点「机器人」不该把人丢进设置的框架里，设置就只管设置。
 *
 *  「能力」是一扇门后面四类东西：插件 / 技能 / MCP / 子 Agent。它们回答的是同一个问题
 *  （这玩意儿会啥），而且需要互相比较，所以合成一页带标签，而不是在侧边栏摊开四行。 */
const NAV_GROUPS = [
  {
    title: 'Agent 能力',
    items: [
      { path: '/capabilities', key: 'capabilities', icon: Blocks },
      { path: '/goals', key: 'goals', icon: Target },
      { path: '/evolution', key: 'evolution', icon: Sparkles },
    ],
  },
  {
    title: '自动化与通讯',
    items: [
      { path: '/cron', key: 'cron', icon: Timer },
      { path: '/bot', key: 'bot', icon: Bot },
    ],
  },
  {
    title: '数据与统计',
    items: [
      { path: '/usage', key: 'usage', icon: BarChart3 },
    ],
  },
]


export default function Sidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const {
    sessions, activeId, activeWorkspace, workspaces, collapsed, query,
    setQuery, toggleCollapsed, newSession, switchTo, remove, rename, togglePin, switchWorkspace,
    renameWorkspace, pinWorkspace, hideWorkspace, openWorkspaceWindow,
  } = useSessionListStore()

  // 「新对话」跟其他导航项共用同一套激活态：只有当当前真的停在一个空的 /chat 上
  // （没有活动会话，或活动会话还没有任何消息）时才点亮它。
  const isNewChatActive =
    location.pathname === '/chat' &&
    (!activeId || !sessions.some((s) => s.id === activeId && (s.message_count || 0) > 0))

  const { status: gitStatus } = useGitStore()
  // Pending self-improvement proposals. Read as a slice so the sidebar only
  // re-renders when the count actually changes.
  const evolutionCount = useEvolutionStore((s) => s.openCount)
  // 演化裁决投影的总数（staged 候选 + 待审演化提案），30s 轮询在 App 启动时
  // 开始。提案同时计入上面的 Evolution 徽标——两页都能就地处置它，所以两处
  // 报数不是重复计数，而是同一件待办的两个入口。问题卡不进投影（归聊天流）。
  const approvalsCount = useApprovalsStore((s) => s.data.counts.total)

  const groups = groupByWorkspace(sessions, query, workspaces)
  const hasElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI?.invoke)

  // New conversation / picking a history row must land on the chat view — the
  // user might be on Settings or Usage when they click. The WS round-trip
  // updates the timeline; this just moves the route there to see it.
  const handleNewSession = () => { newSession(); navigate('/chat') }
  const handleSwitchTo = (id: string) => { switchTo(id); navigate('/chat') }

  /**
   * "+" on a workspace row: start a conversation that belongs to THAT folder.
   *
   * The backend's `session_new` always creates in whatever workspace is
   * currently active, so a switch has to go first when the target differs.
   * Both frames land on the same ordered WS connection, so the switch is
   * guaranteed to be processed before the create.
   */
  const handleNewInWorkspace = (workspace: string) => {
    if (workspace && workspace !== activeWorkspace) switchWorkspace(workspace)
    newSession()
    navigate('/chat')
  }

  // ⌘N / Ctrl+N → new conversation.
  //
  // Two paths on purpose. In Electron, Chromium swallows Ctrl+N before it ever
  // reaches the renderer as a keydown, so the main process intercepts it in
  // `before-input-event` and forwards `app:new-session`. In the browser preview
  // there is no main process, so we fall back to a window listener. Whichever
  // environment we're in, exactly one of the two fires.
  const newSessionRef = useRef(handleNewSession)
  newSessionRef.current = handleNewSession
  // Same ref trick for the notification-click handler so the listener below
  // is registered once but always calls the latest closure.
  const switchToRef = useRef(handleSwitchTo)
  switchToRef.current = handleSwitchTo
  // And for `navigate`: react-router hands back a fresh function whenever the
  // location changes, so depending on it directly would tear down and re-register
  // the IPC listeners on every route change.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate


  useEffect(() => {
    const api = (window as any).electronAPI
    const unsubs: Array<() => void> = []
    if (api?.on) {
      unsubs.push(api.on('app:new-session', () => newSessionRef.current()))
      // Clicking a native toast for a background session jumps straight to it.
      unsubs.push(
        api.on('app:notify-click', (payload: any) => {
          const sid = payload?.sessionId
          if (sid) switchToRef.current(sid)
        }),
      )
      // Tray menu "Settings" item → open the settings surface.
      unsubs.push(api.on('app:open-settings', () => navigateRef.current('/settings')))
      return () => unsubs.forEach((fn) => fn())
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newSessionRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Ask Electron for a folder, then send it to the backend. Falls back to a
   *  prompt() on the web preview where there's no Electron bridge. */
  const openFolder = async () => {
    let path: string | null = null
    const api = (window as any).electronAPI
    if (api?.invoke) {
      try { path = await api.invoke('file:pickDirectory') } catch { path = null }
    } else {
      path = window.prompt(t('sidebar.enterFolderPath'))
    }
    if (path) switchWorkspace(path)
  }

  return (
    <aside
      className="h-full w-full flex flex-col overflow-hidden shrink-0 bg-transparent text-sidebar-foreground select-none"
    >
      {/* Navigation links & tabs */}
      <nav className="px-3 pt-3 space-y-2.5">
        {/* 新对话：与其他导航项完全同一套样式，区别只在于它触发的是新建而不是跳转 */}
        <div className="space-y-0.5">
          <button
            onClick={handleNewSession}
            className={cn(
              'w-full group flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 text-left cursor-pointer',
              isNewChatActive
                ? 'bg-muted text-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <Plus
              size={14}
              className={isNewChatActive ? 'text-foreground' : 'text-muted-foreground/70 group-hover:text-foreground/80 transition-colors'}
            />
            <span className="truncate">{t('sidebar.newChat')}</span>
            <span className="ml-auto text-[10px] font-mono text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors">
              Ctrl+N
            </span>
          </button>
        </div>

        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 inset-y-0 my-auto pointer-events-none text-muted-foreground/60"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-background border border-border/80 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-foreground/20 transition-all shadow-none"
          />
        </div>

        {/* 导航项按类别分组 */}
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-0.5">
            <div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground/70 tracking-wide select-none">
              {group.title}
            </div>
            {group.items.map(({ path, key, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
                    isActive
                      ? 'bg-muted text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={14} className={isActive ? 'text-foreground' : 'text-muted-foreground/70 group-hover:text-foreground/80 transition-colors'} />
                    <span>{t(`sidebar.nav.${key}`)}</span>
                    {key === 'evolution' && Math.max(evolutionCount, approvalsCount) > 0 && (
                      <span className="ml-auto min-w-[18px] px-1.5 h-[18px] inline-flex items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 text-[10px] font-semibold tabular-nums">
                        {Math.max(evolutionCount, approvalsCount)}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Divider */}
      <div className="mx-3 my-2.5 h-px bg-border/30" />

      {/* Workspaces header + open-folder action */}
      <div className="flex items-center gap-1 px-4 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {t('sidebar.workspaces')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={openFolder}
              aria-label={t('sidebar.openFolder')}
              className="ml-auto inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-foreground/10 transition-colors"
            >
              <FolderPlus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right"><p>{t('sidebar.openFolder')}</p></TooltipContent>
        </Tooltip>
      </div>

      {/* Session history grouped by workspace — scrollable, takes remaining space */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {groups.map(({ workspace, label, pinned: isPinned, sessions: items }) => {
          const isCollapsed = collapsed.has(workspace)
          const isActiveWs = workspace === activeWorkspace
          return (
            <div key={workspace || '__default__'}>
              <WorkspaceRow
                workspace={workspace}
                label={label}
                count={items.length}
                collapsed={isCollapsed}
                isActive={isActiveWs}
                isPinned={isPinned}
                hasElectron={hasElectron}
                // Branch is only known for the folder the backend currently has
                // open — gitStore holds one status, not a per-workspace map. So
                // show it on the active row and omit it elsewhere rather than
                // labelling every folder with the active folder's branch.
                branch={isActiveWs && gitStatus?.isGitRepository ? gitStatus.branch || '' : ''}
                onToggle={() => toggleCollapsed(workspace)}
                onNewSession={() => handleNewInWorkspace(workspace)}
                onSwitchWorkspace={() => workspace && switchWorkspace(workspace)}
                onRename={(name) => renameWorkspace(workspace, name)}
                onPin={() => pinWorkspace(workspace, !isPinned)}
                onHide={() => hideWorkspace(workspace)}
                onOpenNewWindow={() => openWorkspaceWindow(workspace)}
              />
              {/* Smooth expand/collapse.
                  Animating grid-template-rows between 0fr and 1fr is what makes
                  this glide without hardcoding a pixel height — the row count is
                  dynamic, so `height: auto` can't be transitioned and a fixed
                  max-height would either clip long lists or coast through empty
                  space on short ones. The inner overflow-hidden wrapper is what
                  actually clips during the tween. */}
              <div
                className={cn(
                  'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
                  isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
                )}
              >
                <div className="overflow-hidden">
                  <div className="space-y-px pl-1 pt-px">
                    {items.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        active={s.id === activeId}
                        onSwitch={handleSwitchTo}
                        onRename={rename}
                        onDelete={remove}
                        onTogglePin={togglePin}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        {sessions.length === 0 && (
          <p className="text-center text-xs text-muted-foreground/50 py-8">
            {t('sidebar.noHistory')}
          </p>
        )}
      </div>

      {/* Footer — settings only */}
      <div className="p-2 border-t border-border/40 mt-auto">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
              isActive
                ? 'bg-muted text-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )
          }
        >
          <Settings size={14} />
          <span>{t('sidebar.nav.settings')}</span>
        </NavLink>
      </div>
    </aside>
  )
}

/**
 * One workspace header row in the sidebar tree.
 *
 * Mirrors the affordances a SessionRow already has, applied at folder level:
 * hover reveals a "+" (new conversation in this folder) and a "⋯" menu, and a
 * rich tooltip surfaces the folder's name, git branch, and full path. Both the
 * named workspaces AND the default workspace render through here, so they look
 * and behave identically — the default one just has no path to copy.
 *
 * The whole thing is a `group` div rather than a `<button>` so the hover
 * actions can be real buttons that stop propagation without nesting buttons
 * (invalid HTML). Clicking the label area toggles expand; there is deliberately
 * NO press/scale feedback here — a folder that bounces on every click reads as
 * a control that did something destructive, when all it did was expand.
 */
interface WorkspaceRowProps {
  workspace: string
  label: string
  count: number
  collapsed: boolean
  isActive: boolean
  isPinned: boolean
  hasElectron: boolean
  branch: string
  onToggle: () => void
  onNewSession: () => void
  onSwitchWorkspace: () => void
  onRename: (name: string) => void
  onPin: () => void
  onHide: () => void
  onOpenNewWindow: () => void
}

function WorkspaceRow({
  workspace, label, count, collapsed, isActive, isPinned, hasElectron, branch,
  onToggle, onNewSession, onSwitchWorkspace, onRename, onPin, onHide, onOpenNewWindow,
}: WorkspaceRowProps) {
  const { t } = useTranslation()
  const isDefault = !workspace
  const displayName = isDefault ? t('sidebar.defaultWorkspace') : label

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [editing])

  const startRename = () => { setDraft(label); setEditing(true) }
  const commitRename = () => {
    const next = draft.trim()
    if (next !== label) onRename(next)
    setEditing(false)
  }
  const cancelRename = () => { setDraft(label); setEditing(false) }

  const copyPath = () => {
    if (!workspace) return
    // writeText REJECTS rather than throws when the document has lost focus or the
    // permission is denied, so the sync guard alone never saw those failures.
    try { navigator.clipboard?.writeText(workspace).catch(() => {}) } catch { /* clipboard blocked */ }
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 pl-2 pr-1 py-1 rounded-md text-[11px]',
        'text-muted-foreground/80 hover:bg-sidebar-foreground/5 transition-colors',
      )}
    >
      {/* Toggle region — the label + icons. A plain div (not a button) so the
          trailing action buttons below aren't nested inside it. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={editing ? undefined : onToggle}
            onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle() } }}
            className={cn('flex items-center gap-1 flex-1 min-w-0 select-none', editing ? '' : 'cursor-pointer')}
          >
            <ChevronRight
              size={11}
              className={cn('shrink-0 transition-transform duration-200', !collapsed && 'rotate-90')}
            />
            {isActive
              ? <FolderOpen size={12} className="shrink-0 text-foreground" />
              : <Folder size={12} className="shrink-0" />}
            {isPinned && <Pin size={9} className="shrink-0 text-warning" />}
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 bg-transparent px-1 -mx-1 rounded outline-none ring-1 ring-primary/40 text-[11px]"
              />
            ) : (
              <span className={cn('truncate', isActive && 'text-foreground font-medium')}>{displayName}</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-medium">{displayName}</p>
            {branch && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <GitBranch size={11} /> {branch}
              </p>
            )}
            {workspace
              ? <p className="text-[11px] text-muted-foreground break-all">{workspace}</p>
              : <p className="text-[11px] text-muted-foreground">{t('sidebar.defaultWorkspaceHint')}</p>}
          </div>
        </TooltipContent>
      </Tooltip>

      {/* Trailing slot — count when idle, actions on hover. Fixed layout so the
          row width never shifts between rest and hover. */}
      <div className="relative shrink-0 flex items-center justify-end gap-0.5">
        <span className="text-[10px] text-muted-foreground/40 group-hover:opacity-0 transition-opacity pointer-events-none pr-1">
          {count}
        </span>
        <div className="absolute right-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => { e.stopPropagation(); onNewSession() }}
                aria-label={t('sidebar.newInWorkspace')}
                className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-sidebar-foreground/10 text-muted-foreground hover:text-foreground"
              >
                <Plus size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>{t('sidebar.newInWorkspace')}</p></TooltipContent>
          </Tooltip>

          <Popover>
            <PopoverTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                aria-label={t('sidebar.workspaceMenu')}
                className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-sidebar-foreground/10 text-muted-foreground hover:text-foreground data-[state=open]:opacity-100"
              >
                <MoreHorizontal size={12} />
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" sideOffset={4} collisionPadding={8} className="w-48 p-1" onClick={(e) => e.stopPropagation()}>
              <button onClick={onNewSession} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                <Plus size={12} />
                {t('sidebar.newInWorkspace')}
              </button>
              {!isActive && workspace && (
                <button onClick={onSwitchWorkspace} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                  <FolderOpen size={12} />
                  {t('sidebar.switchToWorkspace')}
                </button>
              )}
              {workspace && hasElectron && (
                <button onClick={onOpenNewWindow} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                  <ExternalLink size={12} />
                  {t('sidebar.openInNewWindow')}
                </button>
              )}
              {workspace && (
                <>
                  <div className="my-1 h-px bg-border/40" />
                  <button onClick={startRename} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                    <Pencil size={12} />
                    {t('sidebar.renameWorkspace')}
                  </button>
                  <button onClick={onPin} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                    {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
                    {isPinned ? t('sidebar.unpinWorkspace') : t('sidebar.pinWorkspace')}
                  </button>
                  <button onClick={copyPath} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
                    <Copy size={12} />
                    {t('sidebar.copyPath')}
                  </button>
                  <div className="my-1 h-px bg-border/40" />
                  <button onClick={onHide} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-destructive hover:bg-destructive/10">
                    <EyeOff size={12} />
                    {t('sidebar.hideWorkspace')}
                  </button>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}

/**
 * A single history row. The bulk of the interaction complexity lives here:
 * click to switch, hover to reveal ⋯, right-click / ⋯-menu for rename / pin /
 * delete, double-click title to rename inline.
 *
 * Kept as its own component (not inlined into the map) so each row owns its own
 * editing state — renaming one row cannot leak state onto another, and the
 * hover reveal has cheap per-row conditional rendering rather than one big
 * "which row is hovered" atom.
 */
interface SessionRowProps {
  session: SessionSummary
  active: boolean
  onSwitch: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
}

/**
 * Per-row liveness dot.
 *
 * The three states map onto the only three things a user cares about at a
 * glance: it's still thinking, it finished and wants a look, or it broke.
 * `working` gets a ping ring (motion draws the eye without a spinner's visual
 * weight); `done` is a solid green dot that stays put until the row is opened,
 * which is what makes it an inbox rather than a transient toast.
 *
 * Renders nothing when there is no activity, so idle rows keep their exact
 * original layout — no reserved gutter, no shift when a dot appears, because
 * the leading `gap-2` already absorbs it the same way the pin icon does.
 */
function ActivityDot({ state }: { state?: SessionActivity }) {
  if (!state) return null

  if (state === 'working') {
    return (
      <span className="relative shrink-0 flex h-2 w-2" title="AI 正在处理…" aria-label="AI 正在处理">
        <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
    )
  }

  const done = state === 'done'
  return (
    <span
      className={cn(
        'shrink-0 h-2 w-2 rounded-full',
        done ? 'bg-success' : 'bg-destructive',
      )}
      title={done ? '已完成，等待验收' : '执行失败'}
      aria-label={done ? '已完成，等待验收' : '执行失败'}
    />
  )
}

function SessionRow({ session, active, onSwitch, onRename, onDelete, onTogglePin }: SessionRowProps) {
  const { t } = useTranslation()
  const rawActivity = useSessionListStore((s) => s.activity[session.id])
  const isAgentWorking = useAgentStore((s) => s.sessionId === session.id && s.isWorking)
  // For the active session, only show working dot if a turn is actively generating right now; never leave stale unread dots
  const activity = active ? (isAgentWorking ? 'working' : undefined) : rawActivity
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title || '')
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus + select when entering rename mode so ⌘A isn't required first.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startRename = () => {
    setDraft(session.title || '')
    setEditing(true)
  }

  const commitRename = () => {
    const next = draft.trim()
    if (next && next !== session.title) onRename(session.id, next)
    setEditing(false)
  }

  const cancelRename = () => {
    setDraft(session.title || '')
    setEditing(false)
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs border',
        'transition-colors duration-150 cursor-pointer',
        active
          ? 'bg-muted text-foreground font-semibold border-transparent'
          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      onClick={() => !editing && onSwitch(session.id)}
      onDoubleClick={(e) => { e.stopPropagation(); startRename() }}
      // 中键关闭：侧栏会话行 ≈ 浏览器标签页，中键 = 关闭。
      // 复用既有的 onDelete 通道（带后端确认的删除），与 ⋯ 菜单里的删除行为一致。
      onAuxClick={(e) => {
        if (e.button !== 1 || editing) return
        e.preventDefault()
        e.stopPropagation()
        onDelete(session.id)
      }}
    >
      {session.pinned ? <Pin size={11} className="shrink-0 text-warning" /> : null}
      {session.parent_id ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <GitBranch size={11} className="shrink-0 text-primary/70" />
          </TooltipTrigger>
          <TooltipContent side="right"><p>{t('sidebar.forkedSession')}</p></TooltipContent>
        </Tooltip>
      ) : null}
      <ActivityDot state={activity} />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
          }}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent px-1 -mx-1 rounded outline-none ring-1 ring-primary/40 text-[13px]"
        />
      ) : (
        <span className="flex-1 min-w-0 truncate">
          {session.title || '未命名对话'}
        </span>
      )}

      {/* Trailing slot — fixed width so the row layout NEVER changes between
          rest and hover. The timestamp and the ⋯ button are stacked in the SAME
          box (one fades out, the other fades in); nothing is added to or removed
          from flow, so the popover's anchor rect stays put and the menu can't
          jump around. */}
      {!editing && (
        <div className="relative shrink-0 w-9 h-5 flex items-center justify-end">
          <span className="absolute inset-0 flex items-center justify-end text-[10px] text-muted-foreground/50 group-hover:opacity-0 transition-opacity pointer-events-none">
            {relativeTime(session.updated_at)}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                aria-label="更多"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity inline-flex items-center justify-center w-5 h-5 rounded hover:bg-sidebar-foreground/10 text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal size={13} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              className="w-40 p-1"
              onClick={(e) => e.stopPropagation()}
            >
            <button onClick={() => onTogglePin(session.id, !session.pinned)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
              {session.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {session.pinned ? '取消置顶' : '置顶'}
            </button>
            <button onClick={startRename} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent">
              <Pencil size={12} />
              重命名
            </button>
            <div className="my-1 h-px bg-border/40" />
            <button onClick={() => onDelete(session.id)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-destructive hover:bg-destructive/10">
              <Trash2 size={12} />
              删除
            </button>
          </PopoverContent>
        </Popover>
        </div>
      )}

      {/* Inline confirm/cancel while editing — clearer on desktop than pure "press Enter". */}
      {editing && (
        <div className="flex gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onMouseDown={(e) => { e.preventDefault(); commitRename() }}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-success hover:bg-success/10"
            aria-label="确定"
          >
            <Check size={12} />
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); cancelRename() }}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:bg-sidebar-foreground/10"
            aria-label="取消"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

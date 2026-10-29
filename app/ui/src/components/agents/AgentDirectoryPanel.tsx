import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  GitBranch,
  GitFork,
  GitMerge,
  ListTodo,
  Bot,
  Upload,
  Layers,
  Network,
  X,
} from 'lucide-react'
import { OvolveLoader } from '@/components/ui/OvolveLoader'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '@store/agentStore'
import { useGitStore } from '@store/gitStore'
import { useSessionListStore } from '@store/sessionListStore'
import {
  AGENT_LABELS,
  DOMAIN_SUBTITLES,
  ROLE_THEME_COLORS,
  SUBAGENT_METADATA,
  toolToAgent,
} from '@lib/toolAgentMap'
import { BranchPicker } from '@components/git/BranchPicker'
import type { AgentRole, SubagentInfo, ToolCall } from '@apptypes/index'
import { cn } from '@lib/utils'
import { PanelHeader } from '@components/workspace/PanelHeader'

interface AgentDirectoryPanelProps {
  open: boolean
  onToggle: () => void
}

function elapsedLabel(startedAt: number): string {
  const startMs = startedAt > 1e12 ? startedAt : startedAt * 1000
  const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000))
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m} 分 ${s} 秒`
}

function ProcessRow({ tc }: { tc: ToolCall }) {
  const running = tc.status === 'running' || tc.status === 'pending'
  const done = tc.status === 'completed'
  return (
    <div className="flex items-start gap-2 py-1.5">
      {running ? (
        <span className="h-3.5 w-3.5 mt-0.5 shrink-0 inline-flex items-center justify-center">
          <OvolveLoader size={14} strokeWidth={24} />
        </span>
      ) : done ? (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/50 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-xs leading-snug truncate',
            done && 'text-muted-foreground line-through decoration-muted-foreground/50',
            !done && !running && 'text-muted-foreground',
            running && 'text-foreground/90',
          )}
        >
          {tc.toolName}
        </p>
        {tc.args && Object.keys(tc.args).length > 0 && (
          <p className="text-[10px] text-muted-foreground/70 truncate font-mono mt-0.5">
            {Object.entries(tc.args).slice(0, 2).map(([k, v]) =>
              `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
            ).join(' · ')}
          </p>
        )}
      </div>
    </div>
  )
}

function SubagentCard({ info }: { info: SubagentInfo }) {
  const meta = SUBAGENT_METADATA[info.subagentType] || {
    label: info.subagentType,
    desc: info.label || '任务子代理',
    color: '#3B82F6',
  }
  const running = info.status === 'running' || info.status === 'spawning'
  const done = info.status === 'completed'
  const failed = info.status === 'error' || info.status === 'killed' || info.status === 'timeout'

  return (
    <div className="rounded-xl border border-border/40 bg-card/60 px-3 py-2.5 space-y-1.5 transition-all duration-200 hover:bg-card/80">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold truncate text-foreground">{meta.label}</span>
            {running && (
              <span className="text-[10px] text-foreground flex items-center gap-1.5 font-medium">
                <OvolveLoader size={12} strokeWidth={24} />
                运行中
              </span>
            )}
            {done && (
              <span className="text-[10px] text-success flex items-center gap-1 font-medium">
                <CheckCircle2 className="h-3 w-3" />
                已完成
              </span>
            )}
            {failed && (
              <span className="text-[10px] text-destructive flex items-center gap-1 font-medium">
                异常
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">{info.label || meta.desc}</p>
        </div>
      </div>
      {info.elapsedMs > 0 && (
        <div className="text-[10px] text-muted-foreground/70 pl-4 font-mono">
          耗时 {(info.elapsedMs / 1000).toFixed(1)}s · 产物 {info.resultChars} 字符
        </div>
      )}
    </div>
  )
}

function AgentCard({
  role,
  tools,
}: {
  role: AgentRole
  tools: ToolCall[]
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const running = tools.some(t => t.status === 'running' || t.status === 'pending')
  const done = tools.length > 0 && tools.every(t =>
    t.status === 'completed' || t.status === 'failed' || t.status === 'denied',
  )
  const last = tools[tools.length - 1]
  const color = ROLE_THEME_COLORS[role]

  // "已工作 X" 需要一个跳动的时钟。此前只在渲染时算一次，
  // 数值永远冻结在卡片首帧的值。
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  return (
    <div
      className={cn(
        "rounded-xl border border-border/30 bg-card/40 px-3 py-2.5 space-y-1.5 transition-all duration-200",
        tools.length > 0 && "hover:bg-card/60"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2",
          tools.length > 0 && "cursor-pointer select-none"
        )}
        onClick={() => tools.length > 0 && setExpanded(!expanded)}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold truncate text-foreground">{AGENT_LABELS[role]}</span>
            <span className="text-[10px] text-muted-foreground/60 truncate font-normal">
              {DOMAIN_SUBTITLES[role]}
            </span>
          </div>
        </div>
        {running && (
          <span className="text-[10px] text-foreground flex items-center gap-1.5">
            <OvolveLoader size={13} strokeWidth={24} />
            {t('agentDir.running', '运行中')}
          </span>
        )}
        {!running && done && (
          <span className="text-[10px] text-success flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {t('agentDir.done', '已完成')}
          </span>
        )}
        {!running && !done && tools.length === 0 && (
          <span className="text-[10px] text-muted-foreground/50">{t('agentDir.idle', '待命')}</span>
        )}
      </div>

      {!expanded && last && (
        <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2 pl-4">
          {last.toolName}
          {last.status === 'running' && t('agentDir.workedFor', { time: elapsedLabel(last.timestamp), defaultValue: ` · 已工作 ${elapsedLabel(last.timestamp)}` })}
        </p>
      )}

      {tools.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-muted-foreground/70 hover:text-foreground pl-4 flex items-center gap-0.5 transition-colors cursor-pointer w-full text-left pt-0.5"
        >
          <span>{t('agentDir.toolCalls', { n: tools.length, defaultValue: `${tools.length} 次调用` })}</span>
          <ChevronRight className={cn("h-3 w-3 transition-transform duration-200", expanded && "rotate-90 text-foreground")} />
        </button>
      )}

      {expanded && tools.length > 0 && (
        <div className="pl-4 pt-1.5 space-y-1 border-t border-border/20 mt-1.5 divide-y divide-border/10">
          {tools.map((tc, idx) => (
            <ProcessRow key={tc.id || `${tc.toolName}-${idx}`} tc={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

const ALL_ROLES: AgentRole[] = [
  'pilot', 'file_agent', 'computer_agent', 'app_agent', 'browser_agent', 'search_agent',
]

/**
 * IDE-shaped right rail: Git 工具 (changes / branch / commit) → 进程 → 能力分身与子代理.
 */
export function AgentDirectoryPanel({ open, onToggle: _onToggle }: AgentDirectoryPanelProps) {
  const { t } = useTranslation()
  const { toolCalls: liveToolCalls, isWorking, reasoning: liveReasoning, messages, sendMessage, subagents = [] } = useAgentStore()
  const { status, refresh } = useGitStore()
  const worktree = useSessionListStore((s) => s.worktree)
  const worktreeBusy = useSessionListStore((s) => s.worktreeBusy)
  const requestWorktreeStatus = useSessionListStore((s) => s.requestWorktreeStatus)
  const mergeWorktree = useSessionListStore((s) => s.mergeWorktree)
  const removeWorktree = useSessionListStore((s) => s.removeWorktree)
  const [processExpanded, setProcessExpanded] = useState(true)
  const [worktreeMsg, setWorktreeMsg] = useState<
    { kind: 'ok' | 'err'; text: string; files?: string[] } | null
  >(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Agent 改文件期间 git 状态一直在变，只在打开时刷一次的话，
  // "更改 N" 这个数字会冻结在打开那一刻。10s 轮询 + 窗口回焦即刷。
  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => { void refresh() }, 10_000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // The isolation card is a live view of another directory; re-read it whenever
  // the rail is opened instead of trusting whatever was on screen last time.
  useEffect(() => {
    if (open) requestWorktreeStatus()
  }, [open, requestWorktreeStatus])

  const latestAssistantWithActivity = useMemo(() => {
    return [...messages].reverse().find(
      (m) => m.role === 'assistant' && (Boolean(m.toolCalls?.length) || Boolean(m.reasoning?.length)),
    )
  }, [messages])

  const toolCalls = useMemo(() => {
    if (isWorking || liveToolCalls.length > 0) return liveToolCalls
    return latestAssistantWithActivity?.toolCalls || []
  }, [isWorking, liveToolCalls, latestAssistantWithActivity])

  const byAgent = useMemo(() => {
    const map = new Map<AgentRole, ToolCall[]>()
    for (const role of ALL_ROLES) map.set(role, [])
    for (const tc of toolCalls) {
      const role = toolToAgent(tc.toolName)
      const list = map.get(role) || []
      list.push(tc)
      map.set(role, list)
    }
    return map
  }, [toolCalls])

  const runningAgents = [...byAgent.entries()].filter(([, tools]) =>
    tools.some(t => t.status === 'running' || t.status === 'pending'),
  )
  const finishedAgents = [...byAgent.entries()].filter(([, tools]) =>
    tools.length > 0 && tools.every(t =>
      t.status === 'completed' || t.status === 'failed' || t.status === 'denied' || t.status === 'needs_confirmation',
    ),
  )

  const completedCount = toolCalls.filter(t => t.status === 'completed').length
  const totalCount = toolCalls.length
  const changeCount = status?.changes?.length ?? 0
  const additions = status?.additions ?? 0
  const deletions = status?.deletions ?? 0
  const dirty = status?.isGitRepository && status.status === 'dirty' && changeCount > 0

  const onCommitPush = () => {
    sendMessage('请帮我把当前的所有工作区改动提交并推送到远端仓库。')
  }

  // Isolation only exists while the conversation's own working tree exists; a
  // directory removed outside the app must not leave a live "merge back" button
  // pointing at a branch nobody can see any more.
  const isolated = Boolean(worktree?.isWorktree && worktree.exists !== false)
  const isolatedDirty = worktree?.dirtyCount ?? 0
  const isolatedAhead = worktree?.ahead ?? 0
  const isolatedBehind = worktree?.behind ?? 0

  // Merging happens in the project folder, so it needs that folder free and on
  // the base branch. Saying why the click would fail beats letting it fail.
  const mergeHint = !isolated || isolatedAhead === 0
    ? ''
    : worktree?.inProgress
      ? `主项目里有一次未完成的${worktree.operation || '操作'}，处理完它才能合并`
      : worktree?.baseIsBranch && worktree.repoBranch !== worktree.base
        ? `主项目当前在 ${worktree.repoBranch || '游离 HEAD'}，切回 ${worktree.base} 后即可合并`
        : worktree?.repoDirty
          ? '主项目有未提交改动，先提交或撤销后即可合并'
          : ''

  const onMergeWorktree = async () => {
    setWorktreeMsg(null)
    const r = await mergeWorktree(worktree?.base || undefined)
    if (!r.ok) {
      setWorktreeMsg({ kind: 'err', text: r.error || '合并失败', files: r.conflictFiles })
      return
    }
    setWorktreeMsg({ kind: 'ok', text: `已合并回 ${r.target || worktree?.base || ''}` })
    void refresh()
  }

  const onDisposeWorktree = async () => {
    setWorktreeMsg(null)
    const r = await removeWorktree()
    if (!r.ok) {
      setWorktreeMsg({ kind: 'err', text: r.error || '移除失败' })
      return
    }
    setConfirmRemove(false)
    setWorktreeMsg({
      kind: 'ok',
      text: r.preserved
        ? '隔离目录没能安全删除，已原样保留在磁盘上'
        : r.keptBranch
          ? `隔离工作区已移除，未合并的分支保留为 ${worktree?.branch || ''}`
          : '隔离工作区已移除，改动已合入项目',
    })
    void refresh()
  }

  if (!open) return null

  return (
    <>
      <aside
        className={cn(
          // 宽度交给宿主的可拖拽列决定。此前写死 w-80（320px），而宿主列
          // 可在 16%-45% 间拖拽：拖窄被裁切、拖宽留白。
          "w-full h-full bg-sidebar/50 backdrop-blur-xl flex flex-col shrink-0",
        )}
      >
        <PanelHeader icon={Bot} title="控制中心">
          {dirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/20">
              有未提交改动
            </span>
          )}
        </PanelHeader>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          <section className="rounded-xl border border-border/30 bg-card/40 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{t('agentDir.gitTools', 'Git 工具')}</span>
              </div>
              {/* In an isolated tree the branch is the isolation itself: switching
                  it there would move the session branch under the conversation, so
                  the picker only makes sense on the project folder. */}
              {worktree?.isWorktree ? null : <BranchPicker />}
            </div>

            {worktree?.isWorktree && (
              <div className="rounded-lg border border-primary/25 bg-primary/[0.05] p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <GitFork className="h-3 w-3 text-primary shrink-0" />
                  <span className="text-[11px] font-medium shrink-0">隔离工作区</span>
                  <span
                    className="text-[11px] font-mono text-muted-foreground min-w-0 truncate"
                    title={worktree.path}
                  >
                    {worktree.branch}
                  </span>
                  {isolated && (isolatedAhead > 0 || isolatedBehind > 0) && (
                    <span className="ml-auto text-[10px] font-mono tabular-nums text-muted-foreground shrink-0">
                      {isolatedAhead > 0 && <span className="text-success">↑{isolatedAhead}</span>}
                      {isolatedBehind > 0 && <span className="ml-1 text-warning">↓{isolatedBehind}</span>}
                    </span>
                  )}
                </div>

                {isolated ? (
                  <>
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      基线{' '}
                      <span className="font-mono">
                        {worktree?.baseIsBranch ? worktree.base : (worktree?.base || '').slice(0, 8)}
                      </span>
                      {isolatedDirty > 0 ? (
                        <span className="text-warning"> · 未提交改动 {isolatedDirty}</span>
                      ) : null}
                    </p>
                    {mergeHint && (
                      <p className="text-[10px] text-warning/90 leading-snug">{mergeHint}</p>
                    )}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => { void onMergeWorktree() }}
                        disabled={isolatedAhead === 0 || mergeHint !== '' || worktreeBusy}
                        className={cn(
                          'text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1 min-w-0',
                          isolatedAhead > 0 && mergeHint === '' && !worktreeBusy
                            ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs cursor-pointer'
                            : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50',
                        )}
                      >
                        <GitMerge className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {isolatedAhead > 0 ? `合并回 ${worktree?.base || ''}` : '已与基线一致'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { if (confirmRemove) void onDisposeWorktree(); else setConfirmRemove(true) }}
                        onBlur={() => setConfirmRemove(false)}
                        disabled={worktreeBusy}
                        className={cn(
                          'text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1 shrink-0',
                          confirmRemove
                            ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70 cursor-pointer',
                          worktreeBusy && 'opacity-50 cursor-not-allowed',
                        )}
                      >
                        <X className="h-3 w-3" />
                        {confirmRemove ? '确认移除' : '移除隔离'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      隔离目录已不存在，改动仍保存在分支上。
                    </p>
                    <button
                      type="button"
                      onClick={() => { void onDisposeWorktree() }}
                      disabled={worktreeBusy}
                      className="text-[11px] px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-muted/70 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                      回到项目目录
                    </button>
                  </>
                )}

                {worktreeMsg && (
                  <div className="space-y-1">
                    <p
                      className={cn(
                        'text-[10px] leading-snug',
                        worktreeMsg.kind === 'ok' ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {worktreeMsg.text}
                    </p>
                    {/* A clash is actionable only if the files are named; the
                        prose says how many, these say which. */}
                    {worktreeMsg.files && worktreeMsg.files.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {worktreeMsg.files.slice(0, 8).map((f) => (
                          <span
                            key={f}
                            className="max-w-full truncate rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-mono text-destructive"
                            title={f}
                          >
                            {f}
                          </span>
                        ))}
                        {worktreeMsg.files.length > 8 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{worktreeMsg.files.length - 8}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between text-xs pt-1 border-t border-border/20">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t('agentDir.changes', '更改')}:</span>
                <span className="font-mono tabular-nums">{changeCount}</span>
                {changeCount > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                    (<span className="text-success">+{additions}</span> / <span className="text-destructive">-{deletions}</span>)
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={onCommitPush}
                disabled={!dirty}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer",
                  dirty
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs"
                    : "bg-muted text-muted-foreground cursor-not-allowed opacity-50"
                )}
              >
                <Upload className="h-3 w-3" />
                {t('agentDir.commitAndPush', '提交 / 推送')}
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-border/30 bg-card/40 p-3 space-y-2">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => setProcessExpanded(!processExpanded)}
            >
              <div className="flex items-center gap-1.5">
                <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{t('agentDir.process', '进程')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {completedCount}/{totalCount}
                </span>
                <ChevronRight
                  className={cn(
                    "h-3 w-3 text-muted-foreground transition-transform duration-200",
                    processExpanded && "rotate-90 text-foreground"
                  )}
                />
              </div>
            </div>

            {processExpanded && (
              toolCalls.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/60 py-1">{t('agentDir.noRunningTasks', '暂无运行中的任务')}</p>
              ) : (
                <div className="space-y-0.5 max-h-48 overflow-y-auto divide-y divide-border/10 pr-1">
                  {toolCalls.map(tc => (
                    <ProcessRow key={tc.id} tc={tc} />
                  ))}
                </div>
              )
            )}
          </section>

          <section>
            <div className="flex items-center gap-2 mb-2">
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">能力分身</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {runningAgents.length > 0
                  ? t('agentDir.runningCount', { n: runningAgents.length, defaultValue: `${runningAgents.length} 运行` })
                  : t('agentDir.doneCount', { n: finishedAgents.length, defaultValue: `${finishedAgents.length} 结束` })}
              </span>
            </div>
            <div className="space-y-2">
              {/* 按 ALL_ROLES 固定顺序渲染，key 用 role 本身。此前运行中与已
                  完成拆成两段列表、key 前缀不同（run- / done-），角色一完成
                  就会换 key 重挂载，用户展开的调用清单瞬间被合上。 */}
              {ALL_ROLES.map((role) => {
                const tools = byAgent.get(role) || []
                if (tools.length === 0) {
                  return (
                    <div
                      key={role}
                      className="rounded-xl border border-border/20 bg-card/20 px-3 py-2 flex items-center gap-2 opacity-70"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: ROLE_THEME_COLORS[role] }}
                      />
                      <div className="flex-1 min-w-0 flex items-center gap-1.5">
                        <span className="text-xs font-medium truncate">{AGENT_LABELS[role]}</span>
                        <span className="text-[10px] text-muted-foreground/60 truncate font-normal">
                          {DOMAIN_SUBTITLES[role]}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">{t('agentDir.idle', '待命')}</span>
                    </div>
                  )
                }
                return <AgentCard key={role} role={role} tools={tools} />
              })}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-2">
              <Network className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">已委派 Subagent</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {subagents.length > 0 ? `${subagents.length} 个` : '按需'}
              </span>
            </div>
            {subagents.length > 0 ? (
              <div className="space-y-2">
                {subagents.map((sub) => (
                  <SubagentCard key={sub.subagentId} info={sub} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border/30 bg-card/10 px-3 py-2.5 text-center">
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                  按需动态派发
                </p>
                <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                  如 /review 代码审查 · explore 搜索 · coder 实现
                </p>
              </div>
            )}
          </section>
        </div>
      </aside>
    </>
  )
}

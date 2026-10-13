// src/components/chat/ActivityFeed.tsx
// Seamless & Chronological AI Workflow Feed (IDE & Grok Trace Native)
import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  WrapText,
  Terminal,
  Clock,
  FolderOpen,
  ArrowUpRight,
  Globe,
  Rocket,
  AppWindow,
  Camera,
  MousePointer,
  Keyboard,
  Edit3,
  Zap,
  FileText,
  Wrench,
} from 'lucide-react'
import { OvolveLoader } from '@/components/ui/OvolveLoader'
import { OfficialFileIcon } from '@/components/ui/OfficialFileIcon'
import { useSidePanelStore, openReadOnlyFileViewer } from '@/store/sidePanelStore'
import { cn } from '@lib/utils'
import { useAgentStore } from '@/store/agentStore'
import { AskUserPanel } from '@/components/ui/chat/AskUserPanel'
import type { ReasoningBlock, SubagentInfo, ToolCall, ToolCallPreview } from '@apptypes/index'
import { CodeDiffView } from './CodeDiffView'
import { ReflexionCard } from './ReflexionCard'
import { BorderBeam } from '@/components/ui/BorderBeam'

interface ActivityFeedProps {
  reasoning: ReasoningBlock[]
  toolCalls: ToolCall[]
  toolPreviews?: ToolCallPreview[]
  withAvatar?: boolean
  working?: boolean
  phase?: { phase: string; step?: number; tool?: string } | null
  className?: string
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${Math.max(0.1, s)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function LiveTimerBadge({
  startedAt,
  isLive,
  fallbackDuration,
}: {
  startedAt?: number | string
  isLive: boolean
  fallbackDuration: string
}) {
  const [elapsedMs, setElapsedMs] = useState<number>(() => {
    const s = toEpochMs(startedAt)
    return s && isLive ? Math.max(100, Date.now() - s) : 0
  })

  useEffect(() => {
    if (!isLive || !startedAt) return
    const s = toEpochMs(startedAt)
    if (!s) return
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - s)
    }, 250) // Smooth 4Hz ticker, minimal CPU footprint
    return () => clearInterval(timer)
  }, [isLive, startedAt])

  if (!isLive) {
    return <span className="font-mono tabular-nums min-w-[3.6ch] text-left inline-block">{fallbackDuration}</span>
  }

  return (
    <span className="font-mono tabular-nums min-w-[3.6ch] text-left inline-block text-primary font-semibold">
      {fmtDuration(elapsedMs)}
    </span>
  )
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: 'text-slate-500',
  31: 'text-rose-600 dark:text-rose-400 font-medium',
  32: 'text-emerald-600 dark:text-emerald-400 font-medium',
  33: 'text-amber-600 dark:text-amber-400 font-medium',
  34: 'text-sky-600 dark:text-sky-400 font-medium',
  35: 'text-fuchsia-600 dark:text-fuchsia-400 font-medium',
  36: 'text-cyan-600 dark:text-cyan-400 font-medium',
  37: 'text-slate-200',
  90: 'text-muted-foreground/60',
  91: 'text-rose-500 font-semibold',
  92: 'text-emerald-500 font-semibold',
  93: 'text-amber-500 font-semibold',
  94: 'text-sky-500 font-semibold',
  95: 'text-fuchsia-500 font-semibold',
  96: 'text-cyan-500 font-semibold',
  97: 'text-white font-bold',
}

function renderAnsiText(text: string): React.ReactNode {
  if (!text || !text.includes('\x1b')) return text
  const parts = text.split(/(\x1b\[[0-9;]*m)/g)
  let currentColor = ''
  let isBold = false
  let isDim = false

  return parts.map((part, idx) => {
    const match = part.match(/\x1b\[([0-9;]*)m/)
    if (match) {
      const codes = (match[1] || '0').split(';').map((c) => parseInt(c, 10) || 0)
      for (const code of codes) {
        if (code === 0) {
          currentColor = ''
          isBold = false
          isDim = false
        } else if (code === 1) {
          isBold = true
        } else if (code === 2) {
          isDim = true
        } else if (code === 22) {
          isBold = false
          isDim = false
        } else if (ANSI_COLOR_MAP[code]) {
          currentColor = ANSI_COLOR_MAP[code]
        }
      }
      return null
    }
    if (!part) return null
    return (
      <span
        key={idx}
        className={cn(
          currentColor,
          isBold && 'font-bold',
          isDim && 'opacity-60',
        )}
      >
        {part}
      </span>
    )
  })
}

function SmartLogBox({ content, isWrapped }: { content: string; isWrapped: boolean }) {
  const [showFull, setShowFull] = useState(false)
  const lines = useMemo(() => content.split('\n'), [content])
  const isLarge = lines.length > 120

  if (!isLarge || showFull) {
    return (
      <div className="space-y-1">
        <pre className={cn(
          'text-foreground/85 font-mono text-[11px] leading-relaxed',
          isWrapped ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
        )}>
          {renderAnsiText(content)}
        </pre>
        {isLarge && showFull && (
          <button
            type="button"
            onClick={() => setShowFull(false)}
            className="text-[10px] text-primary hover:underline font-mono py-0.5 select-none cursor-pointer"
          >
            ↑ 折叠长日志 (共 {lines.length} 行)
          </button>
        )}
      </div>
    )
  }

  const headLines = lines.slice(0, 30).join('\n')
  const tailLines = lines.slice(-35).join('\n')
  const omittedCount = lines.length - 65

  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      <pre className={cn(
        'text-foreground/85 leading-relaxed',
        isWrapped ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
      )}>
        {renderAnsiText(headLines)}
      </pre>
      <button
        type="button"
        onClick={() => setShowFull(true)}
        className="w-full py-1 px-2 rounded bg-muted/50 hover:bg-muted/80 text-muted-foreground text-[10px] flex items-center justify-center gap-1.5 border border-border/40 transition-colors select-none cursor-pointer"
      >
        <span>⋯ 已省略中间 {omittedCount} 行输出 (点击展开完整日志) ⋯</span>
      </button>
      <pre className={cn(
        'text-foreground/85 leading-relaxed',
        isWrapped ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
      )}>
        {renderAnsiText(tailLines)}
      </pre>
    </div>
  )
}

function extractFilename(pathStr: string): string {
  if (!pathStr) return ''
  const clean = pathStr.replace(/\\/g, '/')
  const parts = clean.split('/')
  return parts[parts.length - 1] || clean
}

function getFileIcon(filename: string): string {
  return ''
}

function renderFileLangBadge(filename: string) {
  return <OfficialFileIcon filename={filename} size={13} className="shrink-0" />
}

interface ExplorationDetail {
  action: 'Searched' | 'Analyzed' | 'Listed' | 'Explored'
  target: string
  lineRef?: string
  resultPill?: string
  langBadge?: React.ReactNode
}

function parseExplorationCall(c: ToolCall): ExplorationDetail {
  const name = c.toolName
  const args = c.args || {}
  const output = typeof c.output === 'string' ? c.output : (typeof c.result === 'string' ? c.result : '')

  if (SEARCH_TOOLS.test(name)) {
    const query = args.Query ?? args.query ?? args.pattern ?? args.term ?? args.SearchPath ?? args.search_path ?? ''
    let count: number | null = null

    if (output) {
      const matchHeader = output.match(/Total results are capped at (\d+)/i) || output.match(/(\d+)\s+results?/i) || output.match(/(\d+)\s+matches/i)
      if (matchHeader) {
        count = parseInt(matchHeader[1], 10)
      } else {
        const matches = (output.match(/\{"File":/g) || []).length
        if (matches > 0) {
          count = matches
        } else if (output.includes('No results found') || output.includes('0 matches')) {
          count = 0
        } else {
          const lines = output.trim().split('\n').filter(l => l.trim() && !l.startsWith('Created At:') && !l.startsWith('Completed At:') && !l.startsWith('File Path:'))
          if (lines.length > 0 && lines.length < 500) count = lines.length
        }
      }
    }

    return {
      action: 'Searched',
      target: String(query || name),
      resultPill: count !== null ? `${count} ${count === 1 ? 'result' : 'results'}` : undefined,
    }
  }

  if (READ_TOOLS.test(name)) {
    const fullPath = args.AbsolutePath ?? args.path ?? args.filePath ?? args.file_path ?? args.DirectoryPath ?? ''
    const filename = extractFilename(fullPath)
    let lineRef: string | undefined = undefined

    const start = args.StartLine ?? args.start_line ?? args.startLine
    const end = args.EndLine ?? args.end_line ?? args.endLine

    if (start && end) {
      lineRef = `#L${start}-${end}`
    } else if (start) {
      lineRef = `#L${start}+`
    } else if (output) {
      const showMatch = output.match(/Showing lines (\d+) to (\d+)/i)
      if (showMatch) {
        lineRef = `#L${showMatch[1]}-${showMatch[2]}`
      }
    }

    return {
      action: 'Analyzed',
      target: filename || fullPath || name,
      lineRef,
      langBadge: renderFileLangBadge(filename || fullPath),
    }
  }

  if (name.includes('list_dir') || name.includes('ls')) {
    const dirPath = args.DirectoryPath ?? args.path ?? args.dir ?? ''
    const dirname = extractFilename(dirPath)
    return {
      action: 'Listed',
      target: dirname ? `${dirname}/` : dirPath || 'directory',
      langBadge: <FolderOpen className="w-3 h-3 shrink-0 text-muted-foreground" />,
    }
  }


  return {
    action: 'Explored',
    target: args.query || args.path || name,
  }
}

function diffStat(patchOrContent: string): { added: number; removed: number } {
  if (!patchOrContent) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  const lines = patchOrContent.split('\n')
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

type WorkflowItem =
  | {
      type: 'exploration_group'
      id: string
      filesCount: number
      searchCount: number
      calls: ToolCall[]
      at: number
    }
  | {
      type: 'file_edit'
      id: string
      action: string
      filename: string
      fullPath: string
      added: number
      removed: number
      call: ToolCall
      at: number
    }
  | {
      type: 'command'
      id: string
      summary: string
      command: string
      output?: string
      exitCode?: number
      call: ToolCall
      at: number
    }
  | {
      type: 'reasoning'
      id: string
      data: ReasoningBlock
      durationStr: string
      at: number
    }
  | {
      type: 'generic_tool'
      id: string
      name: string
      call: ToolCall
      at: number
    }

/**
 * Chat 流里的子代理入口：当前回合的每个子代理一枚
 * 可点击 chip——状态图标 + 类型 + 标签 + 实时耗时。点击 = 右侧边栏打开
 * 「子代理」页并展开该子代理的完整活动流；再点同一枚 = 取消聚焦。
 *
 * 分工纪律：过程事件（state/activity）仍然只更新侧栏，这里渲染的是
 * store 里的花名册投影、不产生任何时间线消息——Chat 流保持"决策流"，
 * chips 只是入口，不是第二份日志。
 */
function SubagentChips() {
  const { t } = useTranslation()
  const subagents = useAgentStore((s) => s.subagents)
  if (subagents.length === 0) return null

  const focus = (id: string) => {
    const cur = useAgentStore.getState().selectedSubagentId
    useAgentStore.setState({ selectedSubagentId: cur === id ? null : id })
    useSidePanelStore.getState().openAndRevealSidePanel('subagents')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-0.5">
      <span className="text-[11px] text-muted-foreground/80 shrink-0 select-none">
        {t('feed.subagents', '子代理')}
      </span>
      {subagents.map((s: SubagentInfo) => {
        const live = s.status === 'spawning' || s.status === 'running'
        const failed = s.status === 'error' || s.status === 'timeout'
        const killed = s.status === 'killed' || s.status === 'stale'
        return (
          <button
            key={s.subagentId}
            type="button"
            onClick={() => focus(s.subagentId)}
            title={t('feed.subagentFocusAria', '在侧栏查看 {{label}} 的完整流程', { label: s.label || s.subagentType })}
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] transition-colors select-none',
              'hover:bg-muted/60',
              failed ? 'border-destructive/40 text-destructive'
                : killed ? 'border-warning/40 text-warning'
                : live ? 'border-primary/30 text-foreground'
                : 'border-border/60 text-muted-foreground',
            )}
          >
            {s.status === 'running' ? (
              <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
            ) : s.status === 'spawning' ? (
              <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : s.status === 'completed' ? (
              <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
            ) : (
              <XCircle className={cn('h-3 w-3 shrink-0', killed ? 'text-warning' : 'text-destructive')} />
            )}
            <span className="uppercase tracking-wide text-muted-foreground/80 shrink-0">{s.subagentType}</span>
            <span className="max-w-40 truncate">{s.label || s.subagentType}</span>
            <LiveTimerBadge
              startedAt={s.startedAt || s.createdAt}
              isLive={live}
              fallbackDuration={fmtDuration(s.elapsedMs || 0)}
            />
          </button>
        )
      })}
    </div>
  )
}

const READ_TOOLS = /^(read_file|view_file|list_dir|get_file|fetch_file)$/i
const SEARCH_TOOLS = /^(grep_search|find_by_name|find_files|search_code|codebase_search|web_search|search_web)$/i
const WRITE_TOOLS = /^(write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content|apply_patch)$/i
const CMD_TOOLS = /^(run_command|shell_executor|bash|shell|exec|terminal|python_executor|run_python)$/i

export function ToolIcon({ toolName, className }: { toolName?: string; className?: string }) {
  const norm = (toolName || '').toLowerCase()
  if (norm === 'navigate' || norm === 'tab_open' || norm === 'browse') {
    return <Globe className={cn('h-3.5 w-3.5 text-sky-500 shrink-0', className)} />
  }
  if (norm === 'app_launch' || norm === 'launch_app') {
    return <Rocket className={cn('h-3.5 w-3.5 text-indigo-500 shrink-0', className)} />
  }
  if (norm === 'window_focus' || norm === 'focus_window') {
    return <AppWindow className={cn('h-3.5 w-3.5 text-purple-500 shrink-0', className)} />
  }
  if (norm === 'computer_screenshot' || norm === 'snapshot' || norm === 'screenshot') {
    return <Camera className={cn('h-3.5 w-3.5 text-emerald-500 shrink-0', className)} />
  }
  if (norm.includes('click') || norm.includes('cursor') || norm.includes('drag') || norm.includes('scroll')) {
    return <MousePointer className={cn('h-3.5 w-3.5 text-blue-500 shrink-0', className)} />
  }
  if (norm.includes('type') || norm.includes('press_key') || norm.includes('key')) {
    return <Keyboard className={cn('h-3.5 w-3.5 text-amber-500 shrink-0', className)} />
  }
  if (norm === 'fill' || norm.includes('write')) {
    return <Edit3 className={cn('h-3.5 w-3.5 text-teal-500 shrink-0', className)} />
  }
  if (norm === 'evaluate' || norm.includes('python') || norm.includes('exec')) {
    return <Zap className={cn('h-3.5 w-3.5 text-yellow-500 shrink-0', className)} />
  }
  if (norm.includes('search') || norm.includes('find')) {
    return <Search className={cn('h-3.5 w-3.5 text-cyan-500 shrink-0', className)} />
  }
  if (norm.includes('file') || norm.includes('read')) {
    return <FileText className={cn('h-3.5 w-3.5 text-blue-400 shrink-0', className)} />
  }
  return <Wrench className={cn('h-3.5 w-3.5 text-muted-foreground/80 shrink-0', className)} />
}

function toEpochMs(val: unknown): number | null {
  if (typeof val === 'string') {
    const num = Number(val)
    if (!isNaN(num) && num > 0) return num < 100_000_000_000 ? num * 1000 : num
    const parsed = Date.parse(val)
    if (!isNaN(parsed) && parsed > 0) return parsed
    return null
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return val < 100_000_000_000 ? val * 1000 : val
}

function getReasoningDurationMs(r: ReasoningBlock): number {
  const start = toEpochMs(r.startedAt) ?? toEpochMs(r.timestamp)
  const end = toEpochMs(r.endedAt)
  if (start && end && end >= start) {
    const diff = end - start
    return diff > 0 && diff < 86400000 ? diff : 800
  }
  if (start && r.streaming) {
    const diff = Date.now() - start
    return diff > 0 && diff < 3600000 ? diff : 800
  }
  if (r.text) {
    const estimatedSec = Math.max(0.5, Math.min(8, Math.round((r.text.length / 60) * 10) / 10))
    return estimatedSec * 1000
  }
  return 500
}

/** 命令分级旗标 → 人话文案。键名与后端 flags 对齐（kebab → camel 走 i18n）。 */
const GUARD_FLAG_META: Record<string, { key: string; fallback: string }> = {
  'network-egress': { key: 'networkEgress', fallback: '访问网络' },
  'fs-destructive': { key: 'fsDestructive', fallback: '删除文件' },
  'system-state': { key: 'systemState', fallback: '改动系统状态' },
  'remote-code-exec': { key: 'remoteCodeExec', fallback: '运行来历不明的程序' },
  'privilege-escalation': { key: 'privilegeEscalation', fallback: '使用管理员权限' },
  'persistence': { key: 'persistence', fallback: '设置开机自启' },
  'process-kill': { key: 'processKill', fallback: '结束进程' },
  'credential-access': { key: 'credentialAccess', fallback: '触碰密码凭据' },
}

function FeedApprovalBar({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation()
  const respond = useAgentStore((s) => s.respondPermission)
  const critical = toolCall.riskLevel === 'critical'
  const isHighRisk = toolCall.riskLevel === 'high' || critical

  const toolName = toolCall.toolName || ''
  const args = toolCall.args || {}

  // Extract command or file payload
  const isCommand = toolName === 'shell_executor' || toolName === 'command' || !!args.command || !!args.CommandLine
  const isFileOp = toolName.includes('file') || toolName.includes('edit') || toolName.includes('write') || !!args.path || !!args.TargetFile

  const rawCommand = String(args.command || args.CommandLine || args.cmd || '')
  const rawPath = String(args.path || args.TargetFile || args.file_path || '')

  let headerTitle = t('approval.titleAction', '是否允许执行此操作？')
  if (isCommand) {
    headerTitle = t('approval.titleCommand', '是否允许运行这个命令？')
  } else if (isFileOp) {
    headerTitle = t('approval.titleFile', '是否允许修改此文件？')
  }

  const highlightSnippet = rawCommand
    ? (rawCommand.length > 40 ? rawCommand.slice(0, 40) + '…' : rawCommand)
    : (rawPath ? extractFilename(rawPath) : toolName)

  const payloadText = rawCommand || rawPath || (Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '')

  // 命令安全检查结果（COMMAND 策略层）。告诉用户"为什么问"，不让用户盲批。
  const guard = toolCall.commandGuard
  const guardReasons = (guard?.reasons || []).filter(Boolean)
  const guardFlags = (guard?.flags || []).filter(f => GUARD_FLAG_META[f])
  // 这些旗标意味着"后果可能不可逆"——「以后都允许」不该出现在这类确认上，
  // 否则一次心急的点击等于把不可逆操作设成了长期白名单。
  const guardOneShotOnly = (guard?.flags || []).some(f =>
    ['remote-code-exec', 'fs-destructive', 'system-state', 'persistence', 'credential-access'].includes(f))

  // Keyboard shortcut listener (Esc -> Deny, Enter -> Approve)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(toolCall.id, 'deny')
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        respond(toolCall.id, 'approve')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toolCall.id, respond])

  return (
    <div className={cn(
      "my-2.5 rounded-xl border p-3.5 select-none transition-all shadow-xs",
      isHighRisk
        ? "border-destructive/30 bg-destructive/5"
        : "border-warning/30 bg-warning/5"
    )}>
      {/* 1. Header: Alert Icon + Bold Title */}
      <div className="flex items-center gap-2">
        {isHighRisk ? (
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 animate-pulse" />
        ) : (
          <ShieldAlert className="h-4 w-4 text-warning shrink-0" />
        )}
        <span className="font-semibold text-sm text-foreground tracking-tight">
          {headerTitle}
        </span>
      </div>

      {/* 2. Subtext with highlight badge */}
      <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
        <span>{isCommand ? t('approval.detectedCommand', '检测到高风险命令 ') : t('approval.detectedAction', '检测到敏感操作 ')}</span>
        {highlightSnippet && (
          <span className="px-1.5 py-0.5 mx-0.5 rounded bg-muted/80 font-mono text-[11px] font-medium text-foreground border border-border/50 inline-block max-w-[280px] sm:max-w-md truncate align-middle">
            {highlightSnippet}
          </span>
        )}
        <span>{t('approval.warningSuffix', '，运行命令可能会带来严重后果，请仔细检查')}</span>
      </div>

      {/* 2.5 安全检查发现（命令分级器）——先说"为什么"，再看命令本体 */}
      {guardReasons.length > 0 && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2">
          <div className="flex items-start gap-1.5 text-xs leading-relaxed">
            <ShieldAlert className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
            <div className="min-w-0">
              <span className="font-medium text-foreground/90">
                {t('approval.guardTitle', '安全检查发现：')}
              </span>
              <span className="text-foreground/80">{guardReasons[0]}</span>
              {guardFlags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {guardFlags.map((f) => {
                    const meta = GUARD_FLAG_META[f]
                    return (
                      <span
                        key={f}
                        className="px-1.5 py-0.5 rounded bg-muted/70 border border-border/40 text-[10px] text-muted-foreground"
                      >
                        {t(`approval.guardFlags.${meta.key}`, meta.fallback)}
                      </span>
                    )
                  })}
                </div>
              )}
              {guardReasons.length > 1 && (
                <div className="mt-1 text-[11px] text-muted-foreground/70">
                  {t('approval.guardMore', '还有 {{n}} 条相关提示', { n: guardReasons.length - 1 })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. Dedicated Terminal Box */}
      {payloadText && (
        <div className="mt-2.5 rounded-lg bg-muted/30 dark:bg-black/60 border border-border/40 p-2.5 font-mono text-[11px] leading-relaxed select-text max-h-36 overflow-y-auto">
          {isCommand && <span className="text-muted-foreground/60 select-none mr-1.5 font-bold">$</span>}
          <span className="text-foreground/90 whitespace-pre-wrap break-all">{payloadText}</span>
        </div>
      )}

      {/* 4. Action Buttons Footer */}
      <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-border/30">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          {critical && (
            <span className="px-1.5 py-0.2 rounded bg-destructive/15 text-destructive border border-destructive/30 text-[10px] font-medium">
              {t('activityFeed.irreversibleRisk')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => respond(toolCall.id, 'deny')}
            className="h-8 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/30 hover:bg-muted/60 border border-border/40 transition-all active:scale-98 flex items-center gap-1"
          >
            <span>{t('approval.skip', '跳过')}</span>
            <kbd className="hidden sm:inline-block px-1 py-0.2 text-[10px] font-mono text-muted-foreground/70 bg-muted/80 rounded border border-border/40">Esc</kbd>
          </button>

          {!critical && !guardOneShotOnly && (
            <button
              type="button"
              onClick={() => respond(toolCall.id, 'approve_always')}
              title={t('approval.alwaysHint', '本会话内不再询问同类操作')}
              className="h-8 px-3 rounded-lg text-xs font-medium text-foreground/80 hover:text-foreground hover:bg-accent border border-border/60 transition-all active:scale-98"
            >
              {t('approval.always', '以后都允许')}
            </button>
          )}

          <button
            type="button"
            onClick={() => respond(toolCall.id, 'approve')}
            className={cn(
              "h-8 px-4 rounded-lg text-xs font-semibold shadow-xs transition-all active:scale-98 flex items-center gap-1",
              isHighRisk
                ? "bg-destructive text-destructive-foreground hover:opacity-90 shadow-destructive/20"
                : "bg-primary text-primary-foreground hover:opacity-90"
            )}
          >
            <span>{isCommand ? t('approval.run', '运行') : t('approval.approve', '同意执行')}</span>
            <kbd className="hidden sm:inline-block px-1 py-0.2 text-[10px] font-mono opacity-70 bg-black/20 dark:bg-white/20 rounded">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

export function ActivityFeed({
  reasoning = [],
  toolCalls = [],
  toolPreviews = [],
  working = false,
  phase = null,
  className,
}: ActivityFeedProps) {
  const { t } = useTranslation()
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})

  // Automatic expansion rule: Live/running items, items needing confirmation/input, failed items, or reasoning blocks default to expanded.
  const isItemExpanded = (id: string, isLive: boolean, status?: string, type?: string) => {
    if (id in expandedItems) {
      return expandedItems[id]
    }
    if (status === 'needs_confirmation' || status === 'needs_input' || status === 'failed') return true
    if (type === 'reasoning') return true
    return isLive
  }

  const toggleItem = (id: string, isLive: boolean, status?: string, type?: string) => {
    const current = isItemExpanded(id, isLive, status, type)
    setExpandedItems((prev) => ({ ...prev, [id]: !current }))
  }

  // ── Two-Tier Progressive Disclosure: Tier-2 (Details Drawer) fold state ──
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({})
  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // Copy-to-clipboard feedback
  const [copiedIds, setCopiedIds] = useState<Record<string, boolean>>({})
  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIds((prev) => ({ ...prev, [id]: true }))
      setTimeout(() => setCopiedIds((prev) => ({ ...prev, [id]: false })), 1500)
    })
  }

  // Wrap toggle per result box
  const [wrappedIds, setWrappedIds] = useState<Record<string, boolean>>({})
  const toggleWrap = (id: string) => {
    setWrappedIds((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // Group raw actions into IDE chronological semantic items
  const { items, totalFilesEdited, totalAdded, totalRemoved } = useMemo(() => {
    const rawEvents = [
      ...reasoning.map((r, idx) => ({
        kind: 'reasoning' as const,
        at: toEpochMs(r.startedAt) ?? toEpochMs(r.timestamp) ?? idx,
        r,
      })),
      ...toolCalls.map((t, idx) => ({
        kind: 'tool' as const,
        at: toEpochMs(t.timestamp) ?? (reasoning.length + idx),
        t,
      })),
    ].sort((a, b) => a.at - b.at)

    const list: WorkflowItem[] = []
    let pendingExplorations: ToolCall[] = []

    const flushExplorations = () => {
      if (pendingExplorations.length === 0) return
      let fileCount = 0
      let searchCount = 0
      pendingExplorations.forEach((c) => {
        if (SEARCH_TOOLS.test(c.toolName)) searchCount++
        else fileCount++
      })
      list.push({
        type: 'exploration_group',
        id: `exp-${pendingExplorations[0].id}`,
        filesCount: fileCount,
        searchCount,
        calls: [...pendingExplorations],
        at: toEpochMs(pendingExplorations[0].timestamp) ?? Date.now(),
      })
      pendingExplorations = []
    }

    let editCount = 0
    let addedSum = 0
    let removedSum = 0
    const editedFilePaths = new Set<string>()

    for (const ev of rawEvents) {
      if (ev.kind === 'reasoning') {
        flushExplorations()
        const durMs = getReasoningDurationMs(ev.r)
        list.push({
          type: 'reasoning',
          id: ev.r.id || `r-${ev.at}`,
          data: ev.r,
          durationStr: fmtDuration(durMs),
          at: ev.at,
        })
      } else {
        const tc = ev.t
        const name = tc.toolName

        if (READ_TOOLS.test(name) || SEARCH_TOOLS.test(name)) {
          pendingExplorations.push(tc)
        } else if (WRITE_TOOLS.test(name)) {
          flushExplorations()
          const fullPath =
            tc.args?.TargetFile ??
            tc.args?.path ??
            tc.args?.file_path ??
            tc.args?.filePath ??
            tc.args?.target ??
            ''
          const filename = extractFilename(fullPath)
          const isNew = name.includes('write_to_file') || name.includes('create')
          const action = isNew ? 'Created' : 'Edited'

          const pathKey = fullPath || filename
          if (pathKey) {
            editedFilePaths.add(pathKey)
          }

          let { added, removed } = diffStat(String(tc.result || ''))
          if (added === 0 && removed === 0) {
            const rawRepl = tc.args?.ReplacementContent
              ?? tc.args?.replacement_content
              ?? tc.args?.replacementContent
              ?? tc.args?.CodeContent
              ?? tc.args?.code_content
              ?? tc.args?.codeContent
              ?? tc.args?.content
              ?? tc.args?.code
              ?? tc.args?.text
              ?? tc.args?.new_content
              ?? tc.args?.newContent
              ?? ''
            const rawTarget = tc.args?.TargetContent
              ?? tc.args?.target_content
              ?? tc.args?.targetContent
              ?? tc.args?.old_content
              ?? tc.args?.oldContent
              ?? ''
            if (typeof rawRepl === 'string' && rawRepl) added = rawRepl.split('\n').length
            if (typeof rawTarget === 'string' && rawTarget) removed = rawTarget.split('\n').length
          }
          if (added === 0 && removed === 0) added = 1

          editCount++
          addedSum += added
          removedSum += removed

          list.push({
            type: 'file_edit',
            id: tc.id,
            action,
            filename: filename || 'File',
            fullPath,
            added,
            removed,
            call: tc,
            at: ev.at,
          })
        } else if (CMD_TOOLS.test(name)) {
          flushExplorations()
          const cmd = tc.args?.CommandLine ?? tc.args?.command ?? tc.args?.cmd ?? tc.args?.code ?? tc.args?.script ?? ''
          let summary = tc.args?.toolSummary
          if (!summary && cmd) {
            const firstLine = String(cmd).trim().split('\n')[0]
            summary = firstLine.length > 50 ? firstLine.slice(0, 50) + '…' : firstLine
          }
          list.push({
            type: 'command',
            id: tc.id,
            summary: summary || 'command',
            command: String(cmd || ''),
            output: tc.output || (typeof tc.result === 'string' ? tc.result : (tc.result ? JSON.stringify(tc.result) : '')),
            exitCode: typeof tc.exitCode === 'number' ? tc.exitCode : 0,
            call: tc,
            at: ev.at,
          })
        } else {
          flushExplorations()
          list.push({
            type: 'generic_tool',
            id: tc.id,
            name: tc.toolName,
            call: tc,
            at: ev.at,
          })
        }
      }
    }
    flushExplorations()

    return {
      items: list,
      totalFilesEdited: editedFilePaths.size,
      totalEditOperations: editCount,
      totalAdded: addedSum,
      totalRemoved: removedSum,
    }
  }, [reasoning, toolCalls])

  // ── Early Waiting State (before any reasoning/tools arrive) ──
  if (items.length === 0 && toolPreviews.length === 0) {
    if (!working) return null
    // 批量委派 often starts before any reasoning/tool frame lands: the chips
    // ARE the first visible sign of activity, so they render in this branch too
    // instead of a bare "Thinking…" hiding a fan-out already in flight.
    const hasSubs = useAgentStore.getState().subagents.length > 0
    return (
      <div className={cn('w-full my-2.5 text-left space-y-1', className)}>
        {hasSubs && <SubagentChips />}
        <div className="flex items-center gap-3 text-sm text-foreground/90 select-none">
          <div className="flex items-center justify-center shrink-0">
            <OvolveLoader size={30} />
          </div>
          <span className="font-medium tracking-tight">{t('common.thinking', '正在思考…')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('w-full space-y-1.5 my-1 text-left select-text', className)}>
      <SubagentChips />
      {/* Chronological Stream of Actions (Top to Bottom, matching common IDE agents) */}
      {items.map((item, idx) => {
        if (item.type === 'exploration_group') {
          const filePart = item.filesCount > 0 ? `${item.filesCount} file${item.filesCount > 1 ? 's' : ''}` : ''
          const searchPart = item.searchCount > 0 ? `${item.searchCount} search${item.searchCount > 1 ? 'es' : ''}` : ''
          const label = filePart && searchPart
            ? `Explored ${filePart}, ${searchPart}`
            : filePart
            ? `Explored ${filePart}`
            : searchPart
            ? `Explored ${searchPart}`
            : 'Exploration'
          const isLive = working && item.calls.some((c) => !c.completedAt)
          const isExp = isItemExpanded(item.id, isLive)

          return (
            <div key={item.id} className="space-y-1">
              <button
                type="button"
                onClick={() => toggleItem(item.id, isLive)}
                className="p-0 m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground/90 hover:text-foreground font-medium transition-colors select-none"
              >
                <Search className="h-3 w-3 text-cyan-500/80 shrink-0" />
                <span>{label}</span>
                {isLive ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                ) : (
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground/60 transition-transform duration-200',
                      isExp && 'rotate-90',
                    )}
                  />
                )}
              </button>

              <div
                className={cn(
                  'grid transition-all duration-250 ease-out',
                  isExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                )}
              >
                <div className="overflow-hidden">
                  <div className="pl-2.5 py-1.5 space-y-1 text-xs text-muted-foreground border-l border-border/40 ml-1.5 my-1">
                    {item.calls.map((c) => {
                      const detail = parseExplorationCall(c)
                      const isCallRunning = working && !c.completedAt && c.status === 'running'
                      const rawOut = typeof c.output === 'string' ? c.output : (typeof c.result === 'string' ? c.result : '')
                      const isSearch = SEARCH_TOOLS.test(c.toolName || '') && !c.toolName?.includes('web') && !c.toolName?.includes('url')
                      const fileMatches = isSearch ? [...rawOut.matchAll(/\{"File":"([^"]+)","LineNumber":(\d+)/g)] : []
                      const uniqueHits = fileMatches.slice(0, 8).map((m) => ({
                        file: m[1],
                        line: parseInt(m[2], 10) || 1,
                      }))

                      const handleOpenExplorationItem = async (e: React.MouseEvent) => {
                        e.stopPropagation()
                        const name = c.toolName || ''
                        const args = c.args || {}

                        // 1. Directory listing: reveal files panel
                        if (name.includes('list_dir') || name.includes('ls')) {
                          useSidePanelStore.getState().openAndRevealSidePanel('files')
                          return
                        }

                        // 2. File read tools: read real file content via openReadOnlyFileViewer
                        if (READ_TOOLS.test(name)) {
                          const fullPath = String(args.AbsolutePath || args.path || args.filePath || args.file_path || '').trim()
                          if (!fullPath || /^https?:\/\//i.test(fullPath)) return

                          const start = args.StartLine || args.start_line || args.startLine
                          const diffStartLine = typeof start === 'number' ? start : (typeof start === 'string' && /^\d+$/.test(start) ? Number(start) : 1)

                          const fallbackText = typeof c.output === 'string' ? c.output : (typeof c.result === 'string' ? c.result : undefined)
                          await openReadOnlyFileViewer(fullPath, undefined, diffStartLine, detail.action || 'Inspected', fallbackText)
                          return
                        }

                        // 3. Search tools: parse matched file paths or open concrete search target
                        if (SEARCH_TOOLS.test(name)) {
                          if (name.includes('web') || name.includes('url')) return

                          if (fileMatches.length > 0) {
                            const firstTarget = fileMatches[0][1]
                            const firstLine = parseInt(fileMatches[0][2], 10) || 1
                            await openReadOnlyFileViewer(firstTarget, undefined, firstLine, 'Matched')
                            return
                          }

                          // If SearchPath / path is a single concrete local file
                          const searchPath = String(args.SearchPath || args.path || args.filePath || '').trim()
                          if (searchPath && !/^https?:\/\//i.test(searchPath) && /\.[a-zA-Z0-9]+$/i.test(searchPath)) {
                            await openReadOnlyFileViewer(searchPath, undefined, 1, 'Searched')
                          }
                        }
                      }

                      return (
                        <div key={c.id} className="space-y-1">
                          <div
                            onClick={handleOpenExplorationItem}
                            className="flex items-center gap-1.5 py-0.5 text-xs select-text rounded hover:bg-muted/40 px-1 -ml-1 cursor-pointer transition-colors group"
                          >
                            <span className="text-muted-foreground/70 font-normal shrink-0">{detail.action}</span>
                            {detail.langBadge}
                            <span className="font-mono text-[11px] font-medium text-foreground/90 truncate max-w-[280px] sm:max-w-md group-hover:text-primary group-hover:underline transition-colors">
                              {detail.target}
                            </span>
                            {detail.lineRef && (
                              <span className="font-mono text-muted-foreground/60 text-[10px] shrink-0 font-normal">
                                {detail.lineRef}
                              </span>
                            )}
                            {detail.resultPill && (
                              <span className="px-1.5 py-0.2 rounded-full bg-muted/60 text-muted-foreground text-[10px] font-sans border border-border/30 shrink-0">
                                {detail.resultPill}
                              </span>
                            )}
                            {isCallRunning && (
                              <Loader2 className="h-2.5 w-2.5 animate-spin text-primary shrink-0 ml-auto" />
                            )}
                          </div>
                          {uniqueHits.length > 1 && (
                            <div className="flex flex-wrap items-center gap-1 pl-4 pb-0.5 select-none">
                              {uniqueHits.map((hit, hIdx) => {
                                const fn = hit.file.split(/[/\\]/).pop() || hit.file
                                return (
                                  <button
                                    key={hIdx}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void openReadOnlyFileViewer(hit.file, fn, hit.line, 'Matched')
                                    }}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-background/80 hover:bg-background text-foreground/80 hover:text-primary text-[10px] font-mono border border-border/60 hover:border-primary/40 transition-all cursor-pointer shadow-2xs"
                                    title={`${hit.file}:${hit.line}`}
                                  >
                                    <span className="truncate max-w-[130px]">{fn}</span>
                                    <span className="text-muted-foreground/60 font-semibold">:{hit.line}</span>
                                  </button>
                                )
                              })}
                              {fileMatches.length > 8 && (
                                <span className="text-[10px] text-muted-foreground/60 font-mono self-center">
                                  +{fileMatches.length - 8}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        }

        if (item.type === 'file_edit') {
          const isLive = working && !item.call.completedAt
          const isFailed = item.call.status === 'failed'
          const isExp = isItemExpanded(item.id, isLive)
          const isCopied = copiedIds[item.id]

          // Extract description from args for Tier 1 summary
          const description = item.call.args?.Description || item.call.args?.Instruction || item.call.args?.description || item.call.args?.instruction || ''
          const rawResultText = typeof item.call.result === 'string' ? item.call.result : (item.call.result ? JSON.stringify(item.call.result, null, 2) : '')
          const resultText = rawResultText.trim()
          const tier1Content = description.trim() || (resultText.length > 200 ? resultText.slice(0, 200) + '…' : resultText)

          // 差异视图数据：TargetContent=旧码，Replacement/CodeContent=新码。
          const diffTarget = typeof item.call.args?.TargetContent === 'string' ? item.call.args.TargetContent
            : typeof item.call.args?.target_content === 'string' ? item.call.args.target_content
            : typeof item.call.args?.targetContent === 'string' ? item.call.args.targetContent
            : typeof item.call.args?.old_content === 'string' ? item.call.args.old_content
            : ''
          const rawReplacement = item.call.args?.ReplacementContent
            ?? item.call.args?.replacement_content
            ?? item.call.args?.replacementContent
            ?? item.call.args?.CodeContent
            ?? item.call.args?.code_content
            ?? item.call.args?.codeContent
            ?? item.call.args?.content
            ?? item.call.args?.code
            ?? item.call.args?.new_content
            ?? item.call.args?.newContent
          const diffReplacement = typeof rawReplacement === 'string' ? rawReplacement : ''
          const hasDiffPayload = !!(diffTarget || diffReplacement)
          const startLineRaw = item.call.args?.StartLine ?? item.call.args?.start_line ?? item.call.args?.startLine
          const diffStartLine =
            typeof startLineRaw === 'number' ? startLineRaw
              : (typeof startLineRaw === 'string' && /^\d+$/.test(startLineRaw)) ? Number(startLineRaw)
                : 1

          const handleOpenSideEditor = (e?: React.MouseEvent) => {
            e?.stopPropagation()
            useSidePanelStore.getState().openEditor({
              filePath: item.fullPath || item.filename,
              filename: item.filename,
              targetContent: diffTarget || undefined,
              replacementContent: diffReplacement || undefined,
              startLine: diffStartLine,
              added: item.added,
              removed: item.removed,
              action: item.action,
              status: item.call.status,
            })
          }

          // Status pill
          const statusPill = isLive
            ? null
            : isFailed
              ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-destructive/10 text-destructive border border-destructive/30">{t('activityFeed.statusFailed')}</span>
              : <span className="text-muted-foreground/50 text-[10px]">{t('activityFeed.statusDone')}</span>

          return (
            <div key={item.id} className="space-y-1">
              {/* ── Tier 0: File Edit Header ── */}
              <div
                onClick={() => toggleItem(item.id, isLive)}
                className="inline-flex items-center gap-1.5 py-0.5 text-xs text-foreground/90 hover:bg-muted/30 rounded px-1 -ml-1 cursor-pointer transition-colors select-none group"
              >
                <span className="text-muted-foreground">{item.action}</span>
                <OfficialFileIcon filename={item.filename} size={14} />
                <span
                  onClick={handleOpenSideEditor}
                  className="font-semibold text-foreground tracking-tight hover:underline hover:text-primary transition-colors"
                  title="点击在右侧侧边栏打开完整代码编辑器"
                >
                  {item.filename}
                </span>
                <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
                  <span className="text-emerald-500 font-medium">+{item.added}</span>
                  <span className="text-rose-500 font-medium">-{item.removed}</span>
                </span>
                {statusPill}

                {isLive ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary ml-1" />
                ) : (
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground/60 transition-transform duration-200',
                      isExp && 'rotate-90',
                    )}
                  />
                )}
              </div>

              {/* ── Tier 1: Result Box with Direct Code Diff ── */}
              <div
                className={cn(
                  'grid transition-all duration-250 ease-out',
                  isExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                )}
              >
                <div className="overflow-hidden">
                  <div className="relative rounded-xl bg-card/60 dark:bg-card/30 border border-border/60 my-1.5 overflow-hidden backdrop-blur-md shadow-xs">
                    {isLive && <BorderBeam size={160} duration={3.5} colorFrom="#38bdf8" colorTo="#818cf8" />}

                    {/* Result / Diff Header Bar */}
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 bg-muted/20">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/90 truncate mr-2">
                        <OfficialFileIcon filename={item.filename} size={13} />
                        <span className="font-mono text-foreground font-semibold truncate">{item.filename}</span>
                        {(item.added > 0 || item.removed > 0) && (
                          <span className="text-[10px] font-mono tabular-nums text-muted-foreground shrink-0">
                            <span className="text-emerald-500">+{item.added}</span> <span className="text-rose-500">-{item.removed}</span>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={handleOpenSideEditor}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium text-primary hover:bg-primary/10 transition-colors"
                          title="在右侧侧边栏打开完整代码编辑器"
                        >
                          <ArrowUpRight className="h-3 w-3" />
                          <span>侧栏打开</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCopy(item.id, diffReplacement || diffTarget || tier1Content)
                          }}
                          className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground transition-colors"
                          title={t('activityFeed.copy')}
                        >
                          {isCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    </div>

                    {/* Diff or Code Content */}
                    {hasDiffPayload ? (
                      <div className="p-2">
                        <CodeDiffView
                          targetContent={diffTarget || undefined}
                          replacementContent={diffReplacement || undefined}
                          filename={item.filename}
                          startLine={diffStartLine}
                        />
                      </div>
                    ) : tier1Content ? (
                      <div className="p-2.5 text-[11px] leading-relaxed text-foreground/80 font-mono">
                        <p className="whitespace-pre-wrap">{tier1Content}</p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {item.call.status === 'needs_confirmation' && <FeedApprovalBar toolCall={item.call} />}
              {item.call.status === 'needs_input' && <AskUserPanel toolCall={item.call} />}
              {isFailed && (
                <div className="pt-1">
                  <ReflexionCard
                    reflection={{
                      source_tool: 'replace_file_content',
                      scenario: `编辑文件 ${item.filename} 异常`,
                      root_cause: (typeof (item.call as any).error === 'string' ? (item.call as any).error : (typeof item.call.result === 'string' ? item.call.result : '')) || '目标替换块未完全匹配或行号产生偏移',
                      alternative_strategy: '调用 view_file 重新核验最新行号与精确缩进后发起替换',
                      prevention_rule: '在单块编辑前先校验文件当前版本内容',
                    }}
                    compact
                  />
                </div>
              )}
            </div>
          )
        }

        if (item.type === 'command') {
          const isLive = working && !item.call.completedAt
          const isFailed = item.exitCode !== undefined && item.exitCode !== 0
          const isExp = isItemExpanded(item.id, isLive, item.call.status)
          // Auto-expand details drawer on failure for immediate debugging
          const isDetailsExp = expandedDetails[item.id] ?? isFailed
          const cmd = item.command || ''
          const label = item.summary || (cmd ? (cmd.length > 45 ? cmd.slice(0, 45) + '…' : cmd) : 'command')
          const rawOutput = item.output || (typeof item.call.result === 'string' ? item.call.result : (item.call.result ? JSON.stringify(item.call.result, null, 2) : ''))
          const outputContent = rawOutput.trim()
          const cwd = item.call.cwd || (item.call.args?.Cwd ?? item.call.args?.cwd ?? '')
          const cleanCwd = String(cwd).replace(/\\/g, '/')
          const isWrapped = wrappedIds[item.id] ?? true
          const isCopied = copiedIds[item.id]

          // Duration calculation
          const startMs = toEpochMs(item.call.timestamp) ?? 0
          const endMs = toEpochMs(item.call.completedAt) ?? 0
          const durationStr = (startMs && endMs && endMs > startMs) ? fmtDuration(endMs - startMs) : null

          // Status pill
          const statusPill = isLive
            ? null  // spinner shown instead
            : item.call.status === 'needs_confirmation'
              ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning/10 text-warning border border-warning/30">{t('activityFeed.statusWaitingConfirm')}</span>
              : isFailed
                ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-destructive/10 text-destructive border border-destructive/30">exit {item.exitCode}</span>
                : <span className="text-muted-foreground/50 text-[10px]">{t('activityFeed.statusDone')}</span>

          return (
            <div key={item.id} className="space-y-1">
              {/* ── Tier 0: Semantic Header ── */}
              <button
                type="button"
                onClick={() => toggleItem(item.id, isLive, item.call.status)}
                className="p-0 m-0 inline-flex items-center gap-1.5 text-xs text-foreground/90 font-medium hover:text-foreground py-0.5 select-none transition-colors"
              >
                <Terminal className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                <span>{label}</span>
                {statusPill}
                {isLive ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0 ml-0.5" />
                ) : (
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground/60 transition-transform duration-200',
                      isExp && 'rotate-90',
                    )}
                  />
                )}
              </button>

              {/* ── Tier 1: Result Box (stdout output) ── */}
              <div
                className={cn(
                  'grid transition-all duration-250 ease-out',
                  isExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                )}
              >
                <div className="overflow-hidden">
                  <div className="relative rounded-xl bg-card/60 dark:bg-card/30 border border-border/60 my-1.5 overflow-hidden backdrop-blur-md shadow-xs">
                    {isLive && <BorderBeam size={180} duration={3.5} colorFrom="#38bdf8" colorTo="#818cf8" />}
                    {/* Result header bar with Wrap/Copy buttons */}
                    <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/20">
                      <span className="text-[11px] font-medium text-muted-foreground/70 select-none">{t('activityFeed.resultTitle')}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleWrap(item.id) }}
                          className={cn(
                            "p-1 rounded-md transition-colors",
                            isWrapped ? "text-primary bg-primary/10" : "text-muted-foreground/50 hover:text-muted-foreground"
                          )}
                          title={isWrapped ? t('activityFeed.wrapOff') : t('activityFeed.wrapOn')}
                        >
                          <WrapText className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCopy(item.id, outputContent || cmd) }}
                          className="p-1 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                          title={t('activityFeed.copy')}
                        >
                          {isCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    </div>

                    {/* Result content with Smart Log Truncation */}
                    <div className="p-2.5 max-h-64 overflow-auto text-muted-foreground leading-relaxed">
                      {outputContent ? (
                        <SmartLogBox content={outputContent} isWrapped={isWrapped} />
                      ) : (
                        <div className="text-muted-foreground/50 italic text-[10px]">
                          {isLive ? 'Executing…' : (item.call.status === 'needs_confirmation' ? t('activityFeed.waitingConfirm') : t('activityFeed.noOutput'))}
                        </div>
                      )}
                    </div>

                    {/* ── Tier 2: Details Drawer ── */}
                    {(cmd || cleanCwd || durationStr) && (
                      <div className="border-t border-border/20">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleDetails(item.id) }}
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors select-none"
                        >
                          <ChevronRight
                            className={cn(
                              'h-2.5 w-2.5 transition-transform duration-200',
                              isDetailsExp && 'rotate-90',
                            )}
                          />
                          <span>{t('activityFeed.detailsToggle')}</span>
                        </button>

                        <div
                          className={cn(
                            'grid transition-all duration-200 ease-out',
                            isDetailsExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                          )}
                        >
                          <div className="overflow-hidden">
                            <div className="px-2.5 pb-2.5 space-y-2 text-[11px]">
                              {/* Command */}
                              {cmd && (
                                <div className="space-y-1">
                                  <div className="flex items-center gap-1 text-muted-foreground/60 font-medium">
                                    <Terminal className="h-2.5 w-2.5" />
                                    <span>{t('activityFeed.commandLabel')}</span>
                                  </div>
                                  <div className="bg-background/60 border border-border/30 rounded px-2 py-1.5 font-mono text-foreground/90 select-all whitespace-pre-wrap break-all">
                                    {cmd}
                                  </div>
                                </div>
                              )}

                              {/* Working directory */}
                              {cleanCwd && (
                                <div className="flex items-center gap-1.5 text-muted-foreground/60">
                                  <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                                  <span className="font-medium shrink-0">{t('activityFeed.workDir')}</span>
                                  <span className="font-mono text-foreground/70 truncate">{cleanCwd}</span>
                                </div>
                              )}

                              {/* Exit code + Duration */}
                              <div className="flex items-center gap-3 text-muted-foreground/60">
                                {item.exitCode !== undefined && item.exitCode !== null && (
                                  <div className="flex items-center gap-1">
                                    <span className="font-medium">{t('activityFeed.exitCode')}</span>
                                    <span className={cn(
                                      'font-mono font-medium',
                                      isFailed ? 'text-destructive' : 'text-foreground/70'
                                    )}>{item.exitCode}</span>
                                  </div>
                                )}
                                {durationStr && (
                                  <div className="flex items-center gap-1">
                                    <Clock className="h-2.5 w-2.5" />
                                    <span className="font-medium">{t('activityFeed.duration')}</span>
                                    <span className="font-mono text-foreground/70">{durationStr}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {item.call.status === 'needs_confirmation' && <FeedApprovalBar toolCall={item.call} />}
              {item.call.status === 'needs_input' && <AskUserPanel toolCall={item.call} />}
              {isFailed && (
                <div className="pt-1">
                  <ReflexionCard
                    reflection={{
                      source_tool: 'run_command',
                      scenario: `执行命令 ${cmd} 退出码非0 (${item.exitCode})`,
                      root_cause: outputContent || '命令执行返回错误退出码',
                      alternative_strategy: '检查命令参数与当前工作目录，或尝试备用命令形式',
                      prevention_rule: '在执行长命令前先检查目标依赖与环境配置',
                    }}
                    compact
                  />
                </div>
              )}
            </div>
          )
        }

function ReasoningStreamBox({ text, isLive }: { text: string; isLive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isUserScrolledUp = useRef(false)
  const rafId = useRef<number | null>(null)

  // Track if user manually scrolled away from the bottom inside this reasoning box
  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 30
    isUserScrolledUp.current = !isNearBottom
  }

  // Smooth throttled auto-scroll to bottom as tokens arrive (never fights parent viewport)
  useEffect(() => {
    if (!isLive || !containerRef.current || isUserScrolledUp.current) return
    if (rafId.current) cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(() => {
      if (containerRef.current && !isUserScrolledUp.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight
      }
    })
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current)
    }
  }, [text, isLive])

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="max-h-72 overflow-y-auto overscroll-contain py-1 text-xs text-muted-foreground/90 leading-relaxed font-sans pr-2 selection:bg-primary/20 select-text [scrollbar-gutter:stable]"
      style={{ overscrollBehavior: 'contain' }}
    >
      <p className="whitespace-pre-wrap select-text">{text}</p>
    </div>
  )
}

        if (item.type === 'reasoning') {
          const isLive = working && (item.data.streaming || idx === items.length - 1)
          const isExp = isItemExpanded(item.id, isLive, undefined, 'reasoning')
          const cleanText = item.data.text ? item.data.text.trimStart() : ''
          const hasContent = Boolean(cleanText)
          const isExpanded = isExp && hasContent

          return (
            <div key={item.id} className="py-1">
              <button
                type="button"
                onClick={() => toggleItem(item.id, isLive, undefined, 'reasoning')}
                className="inline-flex items-center gap-1.5 h-6 px-1.5 -ml-1 rounded-md text-xs text-muted-foreground/80 hover:text-foreground hover:bg-muted/40 font-medium select-none transition-colors"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground/70 transition-transform duration-200 shrink-0',
                    isExp && 'rotate-90',
                  )}
                />
                <span>{isLive ? t('common.thinking', '正在思考…') : t('common.thoughtFor', '已思考')}</span>

                <LiveTimerBadge
                  startedAt={item.data.startedAt || item.data.timestamp}
                  isLive={isLive}
                  fallbackDuration={item.durationStr}
                />
                <span
                  className={cn(
                    'inline-flex items-center transition-[max-width,opacity] duration-200 overflow-hidden shrink-0',
                    isLive ? 'max-w-[16px] opacity-100 ml-0.5' : 'max-w-0 opacity-0 ml-0'
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                </span>
              </button>

              <div
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
                  isExpanded ? 'grid-rows-[1fr] opacity-100 mt-1.5' : 'grid-rows-[0fr] opacity-0 pointer-events-none mt-0'
                )}
              >
                <div className="overflow-hidden">
                  {cleanText ? (
                    <div className="pl-3 border-l-2 border-primary/25 dark:border-primary/35">
                      <ReasoningStreamBox text={cleanText} isLive={isLive} />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )
        }

        if (item.type === 'generic_tool') {
          const isLive = working && !item.call.completedAt
          const isFailed = item.call.status === 'failed'
          const isExp = isItemExpanded(item.id, isLive, item.call.status)
          const isDetailsExp = expandedDetails[item.id] ?? isFailed
          const toolName = item.call.toolName
          const args = item.call.args || {}
          const isCopied = copiedIds[item.id]
          const isWrapped = wrappedIds[item.id] ?? true

          let summary = args?.toolSummary || args?.Role || args?.Prompt || toolName
          if (toolName === 'computer_click') {
            summary = `Click (${args.x}, ${args.y}) [${args.button || 'left'}]`
          } else if (toolName === 'computer_type') {
            summary = `Type "${args.text ? (args.text.length > 20 ? args.text.slice(0, 20) + '…' : args.text) : ''}"`
          } else if (toolName === 'computer_press_key') {
            summary = `Press [${args.key || ''}]`
          } else if (toolName === 'computer_screenshot') {
            summary = `Capture Screen (Matrix Perception)`
          } else if (toolName === 'computer_drag') {
            summary = `Drag (${args.start_x}, ${args.start_y}) → (${args.end_x}, ${args.end_y})`
          } else if (toolName === 'computer_scroll') {
            summary = `Scroll (${args.clicks || 0})`
          } else if (toolName === 'computer_move_cursor') {
            summary = `Move cursor (${args.x}, ${args.y})`
          } else if (toolName === 'app_launch') {
            summary = `Launch App "${args.name || ''}"`
          } else if (toolName === 'window_focus') {
            summary = `Focus Window "${args.title || ''}"`
          } else if (toolName === 'navigate') {
            summary = `Navigate "${args.url ? (args.url.length > 30 ? args.url.slice(0, 30) + '…' : args.url) : ''}"`
          } else if (toolName === 'snapshot') {
            summary = `Snapshot Web Page (Voyager DOM)`
          } else if (toolName === 'click') {
            summary = `Web Click ${args.selector ? `"${args.selector}"` : `(${args.x}, ${args.y})`}`
          } else if (toolName === 'fill') {
            summary = `Web Fill ${args.selector ? `"${args.selector}"` : 'input'}: "${args.value ? (args.value.length > 20 ? args.value.slice(0, 20) + '…' : args.value) : ''}"`
          } else if (toolName === 'evaluate') {
            summary = `Evaluate JS (${args.code ? (args.code.length > 25 ? args.code.slice(0, 25) + '…' : args.code) : 'code'})`
          }

          // Check if result contains screenshot data_uri
          const resObj = typeof item.call.result === 'object' ? (item.call.result as any) : null
          const dataUri = resObj?.data_uri || (typeof item.call.result === 'string' && item.call.result.includes('data:image/') ? item.call.result : null)
          const rawResultText = item.call.result && !dataUri
            ? (typeof item.call.result === 'object' ? JSON.stringify(item.call.result, null, 2) : String(item.call.result))
            : ''
          const resultText = rawResultText.trim()
          // Tier 1: short result preview; Tier 2: full args dump
          const tier1Result = resultText.length > 300 ? resultText.slice(0, 300) + '…' : resultText
          const hasDetailArgs = Object.keys(args).filter(k => k !== 'toolSummary' && k !== 'toolAction').length > 0

          // Status pill
          const statusPill = isLive
            ? null
            : item.call.status === 'needs_confirmation'
              ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning/10 text-warning border border-warning/30">{t('activityFeed.statusWaitingConfirm')}</span>
              : isFailed
                ? <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-destructive/10 text-destructive border border-destructive/30">{t('activityFeed.statusFailed')}</span>
                : <span className="text-muted-foreground/50 text-[10px]">{t('activityFeed.statusDone')}</span>

          return (
            <div key={item.id} className="space-y-1">
              {/* ── Tier 0: Semantic Header ── */}
              <button
                type="button"
                onClick={() => toggleItem(item.id, isLive, item.call.status)}
                className="p-0 m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground/90 hover:text-foreground font-medium py-0.5 select-none transition-colors"
              >
                <ToolIcon toolName={toolName} />
                <span>{summary}</span>
                {statusPill}
                {isLive ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                ) : (
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground transition-transform duration-200',
                      isExp && 'rotate-90',
                    )}
                  />
                )}
              </button>

              {/* ── Tier 1: Result Box ── */}
              <div
                className={cn(
                  'grid transition-all duration-250 ease-out',
                  isExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                )}
              >
                <div className="overflow-hidden">
                  {/* Picture-in-Picture (PIP) Screenshot result */}
                  {dataUri && (
                    <div className="my-2 rounded-xl overflow-hidden border border-border/60 bg-black/40 backdrop-blur-md max-w-md shadow-md">
                      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/40 border-b border-border/30 text-[10px] text-muted-foreground">
                        <span className="font-semibold text-primary flex items-center gap-1">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          PIP Live View
                        </span>
                        <span className="font-mono text-[9px] opacity-70">
                          {resObj?.width && resObj?.height ? `${resObj.width}×${resObj.height}` : 'Screenshot'}
                        </span>
                      </div>
                      <div className="p-1">
                        <img src={dataUri} alt="PIP Desktop Screenshot" className="w-full h-auto object-contain rounded-lg" />
                      </div>
                    </div>
                  )}

                  {/* Text result + Details Drawer */}
                  {(tier1Result || hasDetailArgs) && (
                    <div className="relative rounded-xl bg-card/60 dark:bg-card/30 border border-border/60 my-1.5 overflow-hidden backdrop-blur-md shadow-xs">
                      {isLive && <BorderBeam size={160} duration={3.5} colorFrom="#38bdf8" colorTo="#818cf8" />}
                      {/* Result header bar */}
                      {tier1Result && (
                        <>
                          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/20">
                            <span className="text-[11px] font-medium text-muted-foreground/70 select-none">{t('activityFeed.resultTitle')}</span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleWrap(item.id) }}
                                className={cn(
                                  "p-1 rounded-md transition-colors",
                                  isWrapped ? "text-primary bg-primary/10" : "text-muted-foreground/50 hover:text-muted-foreground"
                                )}
                                title={isWrapped ? t('activityFeed.wrapOff') : t('activityFeed.wrapOn')}
                              >
                                <WrapText className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleCopy(item.id, resultText) }}
                                className="p-1 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                                title={t('activityFeed.copy')}
                              >
                                {isCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                          </div>
                          <div className="p-2.5 font-mono text-[11px] max-h-48 overflow-auto text-muted-foreground leading-relaxed">
                            <pre className={cn(
                              'text-foreground/80',
                              isWrapped ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
                            )}>{tier1Result}</pre>
                          </div>
                        </>
                      )}

                      {/* ── Tier 2: Details Drawer ── */}
                      {hasDetailArgs && (
                        <div className={cn(tier1Result ? "border-t border-border/20" : "")}>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleDetails(item.id) }}
                            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors select-none"
                          >
                            <ChevronRight
                              className={cn(
                                'h-2.5 w-2.5 transition-transform duration-200',
                                isDetailsExp && 'rotate-90',
                              )}
                            />
                            <span>{t('activityFeed.detailsToggle')}</span>
                          </button>

                          <div
                            className={cn(
                              'grid transition-all duration-200 ease-out',
                              isDetailsExp ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                            )}
                          >
                            <div className="overflow-hidden">
                              <div className="px-2.5 pb-2.5 space-y-2 text-[11px]">
                                {/* Tool name */}
                                <div className="flex items-center gap-1.5 text-muted-foreground/60">
                                  <Terminal className="h-2.5 w-2.5 shrink-0" />
                                  <span className="font-medium shrink-0">{t('activityFeed.toolLabel')}</span>
                                  <span className="font-mono text-foreground/70">{toolName}</span>
                                </div>

                                {/* Full args dump */}
                                <div className="space-y-1">
                                  <div className="text-muted-foreground/60 font-medium">{t('activityFeed.inputArgs')}</div>
                                  <div className="bg-background/60 border border-border/30 rounded p-2 font-mono max-h-48 overflow-auto">
                                    <pre className="text-[10px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-all">
                                      {JSON.stringify(
                                        Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'toolSummary' && k !== 'toolAction')),
                                        null, 2
                                      )}
                                    </pre>
                                  </div>
                                </div>

                                {/* Full result if truncated in Tier 1 */}
                                {resultText.length > 300 && (
                                  <div className="space-y-1">
                                    <div className="text-muted-foreground/60 font-medium">{t('activityFeed.fullResult')}</div>
                                    <div className="bg-background/60 border border-border/30 rounded p-2 font-mono max-h-48 overflow-auto">
                                      <pre className={cn(
                                        'text-[10px] leading-relaxed text-foreground/80',
                                        isWrapped ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
                                      )}>{resultText}</pre>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {item.call.status === 'needs_confirmation' && <FeedApprovalBar toolCall={item.call} />}
              {item.call.status === 'needs_input' && <AskUserPanel toolCall={item.call} />}
            </div>
          )
        }

        return null
      })}

      {/* Pending tool previews at the bottom. A preview is the model streaming a
          call it hasn't committed yet; once the real `tool_call` for it lands in
          `toolCalls` the preview is redundant. The store drops it on commit, but
          that hinges on a callId match which providers can send empty or late —
          so we dedupe here too: skip any preview already represented by a real
          call. Without a callId we fall back to the tool name, but only for calls
          that started at or after the preview appeared — an earlier step's
          `shell_executor` must not silence the next one's preview. This is the
          net that stops the ghost second `Calling …` row. */}
      {toolPreviews
        .filter((tp) => {
          const previewAt = toEpochMs(tp.timestamp) ?? 0
          return !toolCalls.some((c) =>
            tp.callId
              ? c.id === tp.callId
              : c.toolName === tp.toolName && (toEpochMs(c.timestamp) ?? 0) >= previewAt,
          )
        })
        .map((tp) => (
          <div key={`prev-${tp.callId || tp.index}`} className="flex items-center gap-1.5 text-xs text-muted-foreground animate-pulse py-0.5 select-none">
            <ToolIcon toolName={tp.toolName} />
            <span>Calling {tp.toolName || 'tool'}…</span>
            <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
          </div>
        ))}

      {/* Bottom Summary / Review Capsule (IDE review style) */}
      {!working && totalFilesEdited > 0 && (() => {
        const fileEdits = items.filter(it => it.type === 'file_edit')
        const parsedFiles = fileEdits.map(fe => {
          const tc = fe.call
          const diffTarget = typeof tc.args?.TargetContent === 'string' ? tc.args.TargetContent
            : typeof tc.args?.target_content === 'string' ? tc.args.target_content
            : typeof tc.args?.targetContent === 'string' ? tc.args.targetContent
            : typeof tc.args?.old_content === 'string' ? tc.args.old_content
            : ''
          const rawReplacement = tc.args?.ReplacementContent
            ?? tc.args?.replacement_content
            ?? tc.args?.replacementContent
            ?? tc.args?.CodeContent
            ?? tc.args?.code_content
            ?? tc.args?.codeContent
            ?? tc.args?.content
            ?? tc.args?.code
            ?? tc.args?.new_content
            ?? tc.args?.newContent
          const diffReplacement = typeof rawReplacement === 'string' ? rawReplacement : ''
          const startLineRaw = tc.args?.StartLine ?? tc.args?.start_line ?? tc.args?.startLine
          const diffStartLine = typeof startLineRaw === 'number' ? startLineRaw : 1

          return {
            filePath: fe.fullPath || fe.filename,
            filename: fe.filename,
            targetContent: diffTarget || undefined,
            replacementContent: diffReplacement || undefined,
            startLine: diffStartLine,
            added: fe.added,
            removed: fe.removed,
            action: fe.action,
            status: tc.status,
          }
        })

        const handleOpenReview = (targetFile?: typeof parsedFiles[0]) => {
          const target = targetFile || parsedFiles[parsedFiles.length - 1] || parsedFiles[0]
          if (target) {
            useSidePanelStore.getState().openEditor({
              ...target,
              allFiles: parsedFiles,
            })
          }
        }

        return (
          <div
            onClick={() => handleOpenReview()}
            className="mt-2.5 space-y-2 p-3 rounded-xl border border-border/80 dark:border-white/15 bg-card/85 dark:bg-card/50 backdrop-blur-xl shadow-xs hover:border-primary/50 hover:shadow-sm transition-all ring-1 ring-black/[0.03] dark:ring-white/[0.05] cursor-pointer group select-none"
          >
            <div className="flex items-center justify-between text-xs font-medium text-foreground">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground/90 group-hover:text-primary transition-colors">
                  {totalFilesEdited} file{totalFilesEdited > 1 ? 's' : ''} changed
                </span>
                <span className="font-mono text-[11px] tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{totalAdded}</span>
                  {' '}
                  <span className="text-rose-600 dark:text-rose-400 font-semibold">-{totalRemoved}</span>
                </span>
              </div>

              <div className="flex items-center gap-1 text-muted-foreground/70 group-hover:text-primary transition-colors text-[11.5px]">
                <span>查看差异</span>
                <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
              </div>
            </div>

            {parsedFiles.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-border/30">
                {parsedFiles.map((pf, pIdx) => (
                  <button
                    key={pIdx}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleOpenReview(pf)
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/60 hover:bg-muted text-foreground/85 text-[11px] font-mono border border-border/50 hover:border-primary/40 transition-all cursor-pointer shadow-2xs"
                  >
                    <OfficialFileIcon filename={pf.filename} size={12} />
                    <span className="truncate max-w-[140px]">{pf.filename}</span>
                    {(pf.added !== undefined || pf.removed !== undefined) && (
                      <span className="text-[9.5px] tabular-nums font-mono">
                        {pf.added ? <span className="text-emerald-500 font-semibold">+{pf.added}</span> : null}
                        {pf.removed ? <span className="text-rose-500 font-semibold">-{pf.removed}</span> : null}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

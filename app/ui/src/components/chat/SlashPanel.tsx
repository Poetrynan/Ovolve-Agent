// src/components/chat/SlashPanel.tsx
// `/` palette. One scrollable list, grouped into 命令 / 技能 / 子智能体 with
// sticky section headers. Each row is `name` + inline description, keyboard
// navigable across the flattened list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, Loader2 } from 'lucide-react'
import { useThemeStore } from '@store/themeStore'
import { useSkillStore } from '@store/skillStore'
import { useSubagentStore, isWriteCapable } from '@store/subagentStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { cn } from '@lib/utils'

type Group = '命令' | '技能' | '子智能体'

interface Entry {
  id: string
  /** Displayed token, e.g. `/settings`, `$pdf`, `explore`. */
  token: string
  description: string
  group: Group
  disabled?: boolean
  /**
   * Extra search terms. Lets people who learned the word elsewhere
   * (`compact`, `summarize`) still land on Ovolve's own command name.
   */
  aliases?: string[]
  run: () => void
}

interface Props {
  query: string
  onPicked: () => void
  onClose: () => void
  actions: {
    newTask: () => void
    toggleSidebar: () => void
    toggleBrowserPanel: () => void
    openFilesPanel: () => void
    foldContext?: () => void
  }
  /** Insert text into the composer (used by skills / subagents). */
  onInsert?: (text: string) => void
}

/**
 * Built-in fallback in case the backend isn't reachable at panel-open time.
 * Only used while the real fetch is in flight or has failed — once
 * /api/subagents/types resolves we always show whatever the registry reports.
 */
const FALLBACK_SUBAGENTS: Array<{ id: string; description: string }> = [
  { id: 'explore', description: '内置 · 代码搜索与跨文件定位' },
  { id: 'planner', description: '内置 · 只读分析，产出技术方案' },
  { id: 'reviewer', description: '内置 · 10 阶段代码审查与 3-State 裁决' },
  { id: 'coder', description: '内置 · 编写 & 修改代码（Worktree 隔离）' },
  { id: 'diagnostician', description: '内置 · 环境依赖与 Git 状态全自动体检' },
  { id: 'researcher', description: '内置 · 深度技术与网络调研专家' },
  { id: 'validator', description: '内置 · 自动化测试运行与质量验证' },
  { id: 'refactor', description: '内置 · 代码重构与架构简化专家' },
  { id: 'docwriter', description: '内置 · 技术文档与架构图解编写' },
  { id: 'memory_curator', description: '内置 · 长期知识与经验记忆沉淀' },
]

export function SlashPanel({ query, onPicked, onClose, actions, onInsert }: Props) {
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useThemeStore()
  const { skills, loading, fetchSkills } = useSkillStore()
  const { types: agentTypes, loaded: agentsLoaded, fetchTypes } = useSubagentStore()
  const setPermission = useSessionConfigStore((s) => s.setPermission)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (skills.length === 0) void fetchSkills()
  }, [skills.length, fetchSkills])

  // Personas come from the backend registry so a YAML-defined persona appears
  // here without a frontend change. `loaded` gates the fallback so we never
  // flash the built-in list over a real one that's about to arrive.
  useEffect(() => {
    if (!agentsLoaded) void fetchTypes()
  }, [agentsLoaded, fetchTypes])

  const entries: Entry[] = useMemo(() => {
    const commands: Entry[] = [
      { id: 'status', token: '/status', description: '查看当前会话、模型、Git、风控与子代理状态看板', group: '命令', aliases: ['状态', '看板', 'info'], run: () => onInsert ? onInsert('/status') : undefined },
      { id: 'permissions', token: '/permissions', description: '查看五大能力分身权限矩阵与沙箱策略', group: '命令', aliases: ['权限', '安全', 'risk'], run: () => onInsert ? onInsert('/permissions') : undefined },
      { id: 'review', token: '/review', description: '启动 3-State 严格代码审查（8 维度扫描 + 缺陷裁决）', group: '命令', aliases: ['审查', 'cr', 'audit'], run: () => onInsert ? onInsert('/review ') : undefined },
      { id: 'simplify', token: '/simplify', description: '代码 4 维度精炼重构（复用、简化、效率、设计层级）', group: '命令', aliases: ['精简', '净化', 'refactor'], run: () => onInsert ? onInsert('/simplify ') : undefined },
      { id: 'batch', token: '/batch', description: '启动大工程跨模块并发批量重构与看板追踪', group: '命令', aliases: ['批量', '并发'], run: () => onInsert ? onInsert('/batch ') : undefined },
      { id: 'loop', token: '/loop', description: '调度定时循环任务（/loop 5m [prompt]）', group: '命令', aliases: ['循环', '定时', 'schedule'], run: () => onInsert ? onInsert('/loop ') : undefined },
      { id: 'doctor', token: '/doctor', description: '工作区环境、依赖、工具链与 Git 全自动体检', group: '命令', aliases: ['体检', '诊断', 'health'], run: () => onInsert ? onInsert('/doctor') : undefined },
      { id: 'stuck', token: '/stuck', description: '卡点自省与突破：反思失败原因并推荐 3 条替代路径', group: '命令', aliases: ['卡住', '自救', 'help'], run: () => onInsert ? onInsert('/stuck ') : undefined },
      { id: 'dream', token: '/dream', description: '触发梦境记忆整合（Applicable / Durable / Legible）', group: '命令', aliases: ['记忆整合', 'dream'], run: () => onInsert ? onInsert('/dream') : undefined },
      { id: 'new', token: '/new', description: '清空当前对话，开始新任务', group: '命令', run: actions.newTask },
      { id: 'plan', token: '/plan', description: '切到「只出方案」：只读分析，产出方案后停下等确认', group: '命令', aliases: ['规划', '方案', 'spec'], run: () => setPermission('plan') },
      { id: 'confirm', token: '/confirm', description: '切到「每步问我」：每个写操作都先问我', group: '命令', aliases: ['ask', '确认', '每步确认'], run: () => setPermission('confirm') },
      { id: 'auto', token: '/auto', description: '切到「小事放手」：低风险自动放行，高风险才问', group: '命令', aliases: ['自动', 'edit', '编辑'], run: () => setPermission('auto') },
      { id: 'full', token: '/full', description: '切到「全权代理」：不再逐步确认（谨慎使用）', group: '命令', aliases: ['yolo', '完全访问', 'agent'], run: () => setPermission('full') },
      { id: 'fold', token: '/fold', description: '折叠上下文：把此前对话压缩成摘要，腾出窗口', group: '命令', aliases: ['compact', 'summarize', '压缩', '摘要'], run: () => actions.foldContext?.() },
      { id: 'files', token: '/files', description: '在侧边打开工作区文件树', group: '命令', run: actions.openFilesPanel },
      { id: 'browser', token: '/browser', description: '打开 AI 浏览器面板', group: '命令', run: actions.toggleBrowserPanel },
      { id: 'sidebar', token: '/sidebar', description: '收起或展开左侧导航', group: '命令', run: actions.toggleSidebar },
      { id: 'theme', token: '/theme', description: resolvedTheme === 'dark' ? '切换到浅色外观' : '切换到深色外观', group: '命令', run: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark') },
      { id: 'goals', token: '/goals', description: '查看与管理长期目标', group: '命令', run: () => navigate('/goals') },
      { id: 'cron', token: '/cron', description: '查看与管理定时任务', group: '命令', run: () => navigate('/cron') },
      { id: 'skills', token: '/skills', description: '管理已导入的技能', group: '命令', run: () => navigate('/capabilities/skills') },
      { id: 'mcp', token: '/mcp', description: '管理 MCP 服务器与外部工具', group: '命令', run: () => navigate('/capabilities/mcp') },
      { id: 'usage', token: '/usage', description: '查看 Token 用量统计', group: '命令', run: () => navigate('/usage') },
      { id: 'settings', token: '/settings', description: '打开设置：模型、权限、记忆', group: '命令', run: () => navigate('/settings') },
    ]

    const skillEntries: Entry[] = skills.map((s) => ({
      id: `skill-${s.name}`,
      token: `$${s.name}`,
      description: `${s.status === 'disabled' ? '已停用' : '技能'} · ${s.description || '无描述'}`,
      group: '技能' as Group,
      disabled: s.status === 'disabled',
      run: () => onInsert?.(`$${s.name} `),
    }))

    // Real registry when we have it, built-in list only as a cold-start stand-in.
    const agentEntries: Entry[] = agentTypes.length > 0
      ? agentTypes.map((a) => ({
          id: `agent-${a.name}`,
          token: a.name,
          // Lead with the capability boundary: "can it touch my files?" matters
          // more than the prose description when you're about to delegate.
          description: `${isWriteCapable(a) ? '可改动文件' : '只读'} · ${a.description}`,
          group: '子智能体' as Group,
          aliases: [a.permission],
          run: () => onInsert?.(`@${a.name} `),
        }))
      : FALLBACK_SUBAGENTS.map((a) => ({
          id: `agent-${a.id}`,
          token: a.id,
          description: a.description,
          group: '子智能体' as Group,
          run: () => onInsert?.(`@${a.id} `),
        }))

    return [...commands, ...skillEntries, ...agentEntries]
  }, [actions, navigate, resolvedTheme, setTheme, setPermission, skills, agentTypes, onInsert])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.token.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.aliases?.some((a) => a.toLowerCase().includes(q)),
    )
  }, [entries, query])

  // Group while preserving the flat index used for keyboard navigation.
  const sections = useMemo(() => {
    const order: Group[] = ['命令', '技能', '子智能体']
    return order
      .map((g) => ({ group: g, items: filtered.filter((e) => e.group === g) }))
      .filter((s) => s.items.length > 0)
  }, [filtered])

  useEffect(() => setCursor(0), [query])

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // Memoised so the key handler can list it as a dep. Left inline it was a new
  // identity per render, so the dep array had to omit it — which captures a stale
  // closure rather than avoiding one.
  const pick = useCallback((e: Entry) => {
    e.run()
    onPicked()
  }, [onPicked])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { onClose(); return }
      if (!filtered.length) return
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setCursor((c) => (c + 1) % filtered.length) }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); setCursor((c) => (c - 1 + filtered.length) % filtered.length) }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); pick(filtered[cursor]) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, cursor, pick, onClose])

  return (
    <div
      data-testid="chat-slash-panel"
      className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover shadow-lg z-50 animate-message-in overflow-hidden"
    >
      <div ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
        {sections.map((section) => (
          <div key={section.group}>
            <div className="sticky top-0 px-3 py-1 bg-popover text-[10px] font-medium text-muted-foreground">
              {section.group}
            </div>
            {section.items.map((e) => {
              const idx = filtered.indexOf(e)
              return (
                <button
                  key={e.id}
                  data-idx={idx}
                  data-testid="chat-slash-item"
                  onClick={() => pick(e)}
                  onMouseEnter={() => setCursor(idx)}
                  className={cn(
                    'w-full flex items-baseline gap-2 px-3 py-1.5 text-left transition-colors',
                    idx === cursor ? 'bg-accent' : 'hover:bg-accent/50',
                    e.disabled && 'opacity-50',
                  )}
                >
                  <span className="text-[13px] font-medium shrink-0">{e.token}</span>
                  <span className="text-[12px] text-muted-foreground truncate">{e.description}</span>
                </button>
              )
            })}
          </div>
        ))}

        {filtered.length === 0 && !loading && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配项</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border/40 bg-popover">
        {loading
          ? <Loader2 size={11} className="animate-spin text-muted-foreground shrink-0" />
          : <Info size={11} className="text-muted-foreground shrink-0" />}
        <span className="text-[11px] text-muted-foreground">
          继续输入以筛选命令、技能或子智能体
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/70 shrink-0">
          ↑↓ 选择 · Enter 确认
        </span>
      </div>
    </div>
  )
}

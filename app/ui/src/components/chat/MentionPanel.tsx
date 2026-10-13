// src/components/chat/MentionPanel.tsx
// The `@` panel: two levels — category list, then per-category search results.
// Files are searched via the file:search IPC channel; skills/agents/sessions from stores.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FileText, Folder, Sparkles, Users, MessageSquare, ChevronLeft, Loader2, Search, GitCompare,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useComposerContextStore, type MentionKind } from '@store/composerContextStore'
import { useSessionListStore } from '@store/sessionListStore'
import { useSubagentStore, isWriteCapable } from '@store/subagentStore'
import { useSkillStore } from '@store/skillStore'
import { cn } from '@lib/utils'

interface CategoryDef {
  kind: MentionKind
  title: string
  description: string
  icon: typeof FileText
}

const CATEGORIES: CategoryDef[] = [
  { kind: 'file', title: 'mention.categoryFile', description: 'mention.categoryFileDesc', icon: FileText },
  { kind: 'skill', title: 'mention.categorySkill', description: 'mention.categorySkillDesc', icon: Sparkles },
  { kind: 'subagent', title: 'mention.categoryAgent', description: 'mention.categoryAgentDesc', icon: Users },
  { kind: 'git_diff', title: 'mention.categoryDiff', description: 'mention.categoryDiffDesc', icon: GitCompare },
  { kind: 'session', title: 'mention.categorySession', description: 'mention.categorySessionDesc', icon: MessageSquare },
]

const KIND_ICONS: Record<MentionKind, typeof FileText> = {
  file: FileText,
  dir: Folder,
  git_diff: GitCompare,
  skill: Sparkles,
  subagent: Users,
  session: MessageSquare,
}

interface Row {
  label: string
  ref: string
  hint?: string
  kind: MentionKind
}

interface Props {
  /** Text typed after the `@`, used as the search query. */
  query: string
  /** Called after a mention is inserted so the composer can strip the token. */
  onPicked: () => void
  onClose: () => void
}

export function MentionPanel({ query, onPicked, onClose }: Props) {
  const { t } = useTranslation()
  const [category, setCategory] = useState<MentionKind | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [root, setRoot] = useState<string | null>(null)
  const addMention = useComposerContextStore((s) => s.addMention)
  const activeWorkspace = useSessionListStore((s) => s.activeWorkspace)
  const sessions = useSessionListStore((s) => s.sessions)
  const { types: agentTypes, loaded: agentsLoaded, fetchTypes } = useSubagentStore()
  const { skills, loading: skillsLoading, fetchSkills } = useSkillStore()
  const boxRef = useRef<HTMLDivElement>(null)

  // Resolve search root
  useEffect(() => {
    if (activeWorkspace) {
      setRoot(activeWorkspace)
      return
    }
    void window.electronAPI?.invoke('system:info').then((i: any) => setRoot(i?.homePath ?? null))
  }, [activeWorkspace])

  // Pull personas and skills
  useEffect(() => {
    if (!agentsLoaded) void fetchTypes()
  }, [agentsLoaded, fetchTypes])

  useEffect(() => {
    if (skills.length === 0 && !skillsLoading) void fetchSkills()
  }, [skills.length, skillsLoading, fetchSkills])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const q = query.trim().toLowerCase()
      setCursor(0)

      // Specific category selected
      if (category === 'file') {
        if (!root) return
        setLoading(true)
        try {
          const res = await window.electronAPI?.invoke('file:search', root, query, 30)
          if (!cancelled) {
            setRows((res ?? []).map((f: any) => ({ label: f.name, ref: f.path, hint: f.path, kind: 'file' })))
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
        return
      }

      if (category === 'skill') {
        const filtered = skills.filter(
          (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        )
        setRows(filtered.map((s) => ({
          label: s.name,
          ref: s.name,
          hint: `${s.status === 'disabled' ? '已停用' : '技能'} · ${s.description || '无描述'}`,
          kind: 'skill',
        })))
        return
      }

      if (category === 'subagent') {
        const filtered = agentTypes.filter(
          (a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
        )
        setRows(filtered.map((a) => ({
          label: a.name,
          ref: a.name,
          hint: `${isWriteCapable(a) ? '可改动文件' : '只读'} · ${a.description}`,
          kind: 'subagent',
        })))
        return
      }

      if (category === 'git_diff') {
        const opts: Row[] = [
          { label: t('mention.diffWorking'), ref: '', hint: t('mention.diffWorkingHint'), kind: 'git_diff' },
          { label: t('mention.diffStaged'), ref: 'staged', hint: t('mention.diffStagedHint'), kind: 'git_diff' },
        ]
        setRows(q ? opts.filter((o) => o.label.toLowerCase().includes(q) || o.ref.includes(q)) : opts)
        return
      }

      if (category === 'session') {
        const filtered = sessions.filter(
          (s) => !q || (s.title && s.title.toLowerCase().includes(q)) || s.id.toLowerCase().includes(q),
        )
        setRows(filtered.map((s) => ({
          label: s.title || s.id,
          ref: s.id,
          hint: `会话 · ${s.updated_at ? new Date(s.updated_at * 1000).toLocaleString() : s.id}`,
          kind: 'session',
        })))
        return
      }

      // If no specific category and query is typed: search across all categories!
      if (!category && q) {
        const combined: Row[] = []

        // 1. Skills match
        const matchSkills = skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
        for (const s of matchSkills.slice(0, 5)) {
          combined.push({ label: s.name, ref: s.name, hint: `技能 · ${s.description || '无描述'}`, kind: 'skill' })
        }

        // 2. Subagents match
        const matchAgents = agentTypes.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
        for (const a of matchAgents.slice(0, 5)) {
          combined.push({ label: a.name, ref: a.name, hint: `智能体 · ${a.description}`, kind: 'subagent' })
        }

        // 3. Sessions match
        const matchSessions = sessions.filter((s) => (s.title && s.title.toLowerCase().includes(q)) || s.id.toLowerCase().includes(q))
        for (const s of matchSessions.slice(0, 3)) {
          combined.push({ label: s.title || s.id, ref: s.id, hint: `历史会话`, kind: 'session' })
        }

        // 4. Files match
        if (root) {
          try {
            const files = await window.electronAPI?.invoke('file:search', root, query, 15)
            if (!cancelled && files) {
              for (const f of files) {
                combined.push({ label: f.name, ref: f.path, hint: f.path, kind: 'file' })
              }
            }
          } catch {}
        }

        if (!cancelled) setRows(combined)
        return
      }

      // No category & no query: show empty rows so categories render
      setRows([])
    }

    void run()
    return () => { cancelled = true }
  }, [category, query, root, agentTypes, skills, sessions, t])

  const visible = useMemo(() => rows.slice(0, 30), [rows])

  const pick = useCallback((r: Row) => {
    addMention({
      id: `mn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      kind: r.kind,
      label: r.label,
      ref: r.ref,
    })
    onPicked()
  }, [addMention, onPicked])

  // Keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (!visible.length) return
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % visible.length) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + visible.length) % visible.length) }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (visible[cursor]) pick(visible[cursor]) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, cursor, pick, onClose])

  const activeCat = CATEGORIES.find((c) => c.kind === category)

  return (
    <div
      ref={boxRef}
      data-testid="chat-mention-panel"
      className="absolute bottom-full left-0 mb-2 w-[min(380px,100%)] max-h-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg z-50 animate-message-in"
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/40 sticky top-0 bg-popover">
        {category && (
          <button
            onClick={() => setCategory(null)}
            className="p-0.5 rounded hover:bg-accent text-muted-foreground"
            aria-label={t('mention.back')}
          >
            <ChevronLeft size={13} />
          </button>
        )}
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {activeCat ? t(activeCat.title) : (query ? t('mention.searchAll', { defaultValue: '快捷引用' }) : t('mention.header'))}
        </span>
        {query && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Search size={10} />
            {query}
          </span>
        )}
        {loading && <Loader2 size={11} className="animate-spin text-muted-foreground ml-1" />}
      </div>

      {!category && !query ? (
        <div className="p-1 space-y-0.5">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.kind}
                onClick={() => setCategory(c.kind)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-accent transition-colors"
              >
                <Icon size={13} className="shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium leading-none">{t(c.title)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/70 truncate max-w-[52%]">{t(c.description)}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="p-1 space-y-0.5">
          {visible.map((r, i) => {
            const Icon = KIND_ICONS[r.kind] || FileText
            return (
              <button
                key={`${r.kind}-${r.ref}-${i}`}
                onClick={() => pick(r)}
                onMouseEnter={() => setCursor(i)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors',
                  i === cursor ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <Icon size={13} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs leading-tight truncate font-medium">{r.label}</div>
                  {r.hint && (
                    <div className="text-[10px] text-muted-foreground truncate font-mono">{r.hint}</div>
                  )}
                </div>
              </button>
            )
          })}
          {!loading && visible.length === 0 && (
            <p className="px-3 py-3 text-center text-xs text-muted-foreground">
              {t('mention.noMatch', { defaultValue: '未找到匹配的引用项' })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

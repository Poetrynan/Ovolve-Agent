// src/components/workspace/ArtifactPanel.tsx
// Flat, newest-first list of everything the current session produced (images + files).
// Clicking a row scrolls the transcript to the producing turn via data-turn-index.
import { useEffect, useState, useCallback, useRef } from 'react'
import { Image, FileCode, RefreshCw, ExternalLink, AlertCircle, Package } from 'lucide-react'
import { useAgentStore } from '@store/agentStore'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@lib/utils'
import { useTranslation } from 'react-i18next'
import { openReadOnlyFileViewer } from '@store/sidePanelStore'

interface Artifact {
 id: string
 kind: 'image' | 'file'
 name: string
 path: string
 url: string
 mime: string
 bytes: number
 tool: string
 change: 'created' | 'modified'
 revisions: number
 exists: boolean
 seq: number
 turnIndex: number
 createdAt: number
}

interface ArtifactIndex {
 sessionId: string
 total: number
 truncated: boolean
 counts: { image: number; file: number }
 artifacts: Artifact[]
}

function formatBytes(n: number): string {
 if (n <= 0) return ''
 if (n < 1024) return `${n} B`
 if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
 return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ArtifactPanel() {
 const { t } = useTranslation()
 const sessionId = useAgentStore((s) => s.sessionId)
 const messagesLen = useAgentStore((s) => s.messages.length)
 const [index, setIndex] = useState<ArtifactIndex | null>(null)
 const [loading, setLoading] = useState(false)
 const [error, setError] = useState<string | null>(null)
 const [filter, setFilter] = useState<'all' | 'image' | 'file'>('all')
 // 请求序号：流式一轮里 messagesLen 连续 +1 会触发多次请求，
 // 慢的旧响应晚到会把新数据覆盖回去（无序保护）。
 const seqRef = useRef(0)

 const fetchIndex = useCallback(async () => {
 if (!sessionId) return
 const seq = ++seqRef.current
 setLoading(true)
 setError(null)
 try {
 // Previously root-relative: relied on the dev proxy being same-origin.
 const res = await apiFetch(`${API_BASE}/api/artifacts?session_id=${encodeURIComponent(sessionId)}`)
 if (seq !== seqRef.current) return // 已有更新的请求在路上，丢弃过期响应
 if (!res.ok) throw new Error(`HTTP ${res.status}`)
 const data = (await res.json()) as ArtifactIndex
 if (seq !== seqRef.current) return
 setIndex(data)
 } catch (e) {
 if (seq !== seqRef.current) return
 setError(e instanceof Error ? e.message : String(e))
 } finally {
 if (seq === seqRef.current) setLoading(false)
 }
 }, [sessionId])

 // Fetch when the session changes and again after any turn completes — the
 // panel is a "find that thing again" surface, so it must stay in step with
 // the transcript without demanding a manual refresh. The messagesLen bump is
 // the cheapest proxy for "something new landed". 防抖 600ms 把流式期间
 // 连续的多次触发合并成一次请求。
 useEffect(() => {
 const id = window.setTimeout(() => { void fetchIndex() }, 600)
 return () => window.clearTimeout(id)
 }, [fetchIndex, messagesLen])

 const rows = index?.artifacts ?? []
 const visible = filter === 'all' ? rows : rows.filter((a) => a.kind === filter)

 return (
 <div className="flex flex-col h-full">
 <div className="flex items-center gap-1 px-2 py-2 border-b border-border/50 shrink-0">
 <FilterChip label={t('artifact.filterAll')} count={rows.length}
 active={filter === 'all'} onClick={() => setFilter('all')} />
 <FilterChip label={t('artifact.filterImage')} count={index?.counts.image ?? 0}
 active={filter === 'image'} onClick={() => setFilter('image')} />
 <FilterChip label={t('artifact.filterFile')} count={index?.counts.file ?? 0}
 active={filter === 'file'} onClick={() => setFilter('file')} />
 <div className="flex-1" />
 <button
 onClick={() => void fetchIndex()}
 disabled={loading}
 className={cn(
 'p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent',
 'transition-[color,background-color] duration-150 ease-out',
 'disabled:opacity-40 disabled:hover:bg-transparent',
 )}
 aria-label={t('common.refresh')}
 title={t('common.refresh')}
 >
 <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
 </button>
 </div>

 <div className="flex-1 overflow-y-auto">
 {error && (
 <div className="flex items-start gap-2 m-2 p-2.5 text-xs rounded-md bg-destructive/10 text-destructive">
 <AlertCircle size={14} className="shrink-0 mt-0.5" />
 <span className="leading-relaxed">{error}</span>
 </div>
 )}
 {!error && visible.length === 0 && !loading && (
 <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-3">
 <Package size={28} strokeWidth={1.5} className="text-muted-foreground/40" />
 <div className="text-xs text-muted-foreground/80 max-w-[230px] leading-relaxed">
 {t('artifact.empty')}
 </div>
 </div>
 )}
 <ul className="divide-y divide-border/30">
 {visible.map((a) => (
 <ArtifactRow key={a.id} artifact={a} />
 ))}
 </ul>
 {index?.truncated && (
 <div className="text-[11px] text-muted-foreground/70 text-center py-2.5">
 {t('artifact.truncated', { total: index.total })}
 </div>
 )}
 </div>
 </div>
 )
}

function FilterChip({ label, count, active, onClick }: {
 label: string; count: number; active: boolean; onClick: () => void
}) {
 return (
 <button
 onClick={onClick}
 className={cn(
 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
 'transition-[color,background-color] duration-150 ease-out',
 active
 ? 'bg-accent text-foreground ring-1 ring-border/60'
 : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
 )}
 >
 <span>{label}</span>
 <span className={cn('tabular-nums', active ? 'opacity-70' : 'opacity-50')}>{count}</span>
 </button>
 )
}

function ArtifactRow({ artifact }: { artifact: Artifact }) {
 const { t } = useTranslation()
 const Icon = artifact.kind === 'image' ? Image : FileCode
 const isImage = artifact.kind === 'image'
 // One dot-joined meta line, assembled first so we never render a stray
 // leading "·" when the middle pieces happen to be absent.
 const meta = [
 artifact.path,
 artifact.tool,
 artifact.bytes > 0 ? formatBytes(artifact.bytes) : '',
 artifact.turnIndex >= 0 ? t('artifact.turn', { n: artifact.turnIndex + 1 }) : '',
 ].filter(Boolean)
 const metaText = meta.join(' · ')

 // 点击行为：优先滚到产生该产物的对话轮次；对话节点已被折叠/裁剪找不到
 // 时，文件类产物兜底直接在「代码与差异」面板打开——此前两种情况都
 // 毫无反应，像按钮坏了。
 const handleRowClick = () => {
 const el = artifact.turnIndex >= 0
 ? document.querySelector(`[data-turn-index="${artifact.turnIndex}"]`)
 : null
 if (el) {
 el.scrollIntoView({ behavior: 'smooth', block: 'center' })
 return
 }
 if (artifact.kind === 'file' && artifact.path && artifact.exists) {
 void openReadOnlyFileViewer(artifact.path, artifact.name, 1, 'Opened')
 }
 }

 return (
 <li
 onClick={handleRowClick}
 className={cn(
 'group flex items-start gap-2.5 px-2.5 py-2 cursor-pointer',
 'transition-colors duration-150 ease-out hover:bg-accent/60',
 )}
 >
 <Icon size={14} className="shrink-0 mt-0.5 text-muted-foreground" />
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-1.5">
 <span className={cn(
 'text-xs text-foreground truncate',
 !artifact.exists && 'line-through opacity-50',
 )}>
 {artifact.name}
 </span>
 {artifact.revisions > 1 && (
 <span className="text-[10px] px-1.5 rounded-full bg-foreground/10 text-muted-foreground shrink-0 tabular-nums">
 ×{artifact.revisions}
 </span>
 )}
 </div>
 {metaText && (
 <div className="text-[10px] text-muted-foreground/70 truncate mt-0.5" title={metaText}>
 {metaText}
 </div>
 )}
 </div>
 {isImage && artifact.url && (
 <a
 href={artifact.url}
 target="_blank"
 rel="noreferrer"
 onClick={(e) => e.stopPropagation()}
 className={cn(
 'shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent',
 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-foreground transition-opacity duration-150',
 )}
 aria-label={t('common.open')}
 title={t('common.open')}
 >
 <ExternalLink size={12} />
 </a>
 )}
 </li>
 )
}

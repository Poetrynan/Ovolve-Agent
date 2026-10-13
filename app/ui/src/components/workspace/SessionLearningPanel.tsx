// src/components/workspace/SessionLearningPanel.tsx
// 本次会话学习面板 (Session Learning Projection Panel)
// §13.4/13.5 & Phase 24:
// 1. Session 与 Branch 严格隔离，只展示当前会话产生的 Episode 与 1st-class LearningItem 投影；
// 2. 支持按 Episode 分组折叠、显示封存原因、生命周期状态机与一键封存；
// 3. 支持就地采纳、编辑、暂缓、拒绝与撤销，直接调用 /api/learning-items/{id}/{action}；
// 4. 支持不可篡改 EventStore 溯源审计 (Trace Modal)；
// 5. 支持跨会话复用知识视图 (Read-only Cross-session Knowledge)。

import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
 Sparkles,
 CheckCircle2,
 XCircle,
 Clock,
 RotateCcw,
 ShieldAlert,
 BookOpen,
 Boxes,
 Compass,
 FileCode,
 Layers,
 ChevronRight,
 ChevronDown,
 RefreshCw,
 History,
 Lock,
 Edit3,
 AlertTriangle,
} from 'lucide-react'
import { useAgentStore } from '@store/agentStore'
import { apiGet, apiPost } from '@lib/api'
import type { LearningItem, SessionLearningProjection } from '@/types'

export function SessionLearningPanel() {
 const sessionId = useAgentStore((s) => s.sessionId)
 const branchId = useAgentStore((s) => s.branchId) || ''
 const [loading, setLoading] = useState(false)
 const [data, setData] = useState<SessionLearningProjection | null>(null)
 const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null)
 const [selectedTraceItem, setSelectedTraceItem] = useState<{ itemId: string; events: any[] } | null>(null)
 const [actionLoading, setActionLoading] = useState<string | null>(null)
 const [sealingEpisode, setSealingEpisode] = useState<string | null>(null)
 const [editingItem, setEditingItem] = useState<{ id: string; content: string } | null>(null)
 const [errorMessage, setErrorMessage] = useState<string | null>(null)
 const opKeysRef = useRef<Record<string, string>>({})
 // 已拿到数据后再次刷新不再闪 loading（后台静默刷新）。
 const dataRef = useRef<SessionLearningProjection | null>(null)
 // 只有会话首次加载才自动展开第一个片段。此前 auto-expand 写在
 // fetch 成功回调里、依赖 expandedEpisode，用户手动收起后会被下一条
 // WS 推送触发的 refetch 重新展开——用户的收起操作被撤销。
 const autoExpandRef = useRef(true)

 useEffect(() => {
 // 切会话：重置首展标记与数据缓存
 autoExpandRef.current = true
 dataRef.current = null
 setExpandedEpisode(null)
 }, [sessionId])

 const fetchSessionLearning = useCallback(async () => {
 if (!sessionId) return
 if (!dataRef.current) setLoading(true)
 setErrorMessage(null)
 try {
 const url = `/api/sessions/${sessionId}/learning?branchId=${encodeURIComponent(branchId)}`
 const res = await apiGet<SessionLearningProjection>(url)
 dataRef.current = res
 setData(res)
 if (autoExpandRef.current && res.episodes?.length) {
 autoExpandRef.current = false
 setExpandedEpisode(res.episodes[0].episode_id)
 }
 } catch (err: any) {
 console.error('Failed to load session learning:', err)
 setErrorMessage(err?.message || '加载会话学习数据失败')
 } finally {
 setLoading(false)
 }
 }, [sessionId, branchId])

 useEffect(() => {
 void fetchSessionLearning()
 }, [sessionId, branchId, fetchSessionLearning])

 // P1-10: Real-time projection listener on WebSocket events with strict branch matching
 useEffect(() => {
 const handleUpdate = (e: Event) => {
 const detail = (e as CustomEvent).detail || {}
 if (detail.sessionId === sessionId) {
 const isGlobal = detail.scopeType === 'global' || detail.scope === 'global'
 const currentBranch = (branchId || '').trim()
 const eventBranch = (detail.branchId || '').trim()
 if (isGlobal || currentBranch === eventBranch) {
 void fetchSessionLearning()
 }
 }
 }
 if (typeof window !== 'undefined') {
 window.addEventListener('ovolve:learning_item_updated', handleUpdate)
 }
 return () => {
 if (typeof window !== 'undefined') {
 window.removeEventListener('ovolve:learning_item_updated', handleUpdate)
 }
 }
 }, [sessionId, branchId, fetchSessionLearning])

 const handleAction = async (
 itemId: string,
 action: 'approve' | 'reject' | 'defer' | 'revoke' | 'edit',
 overrideContent?: string
 ) => {
 setActionLoading(itemId)
 setErrorMessage(null)
 try {
 const currentItem = data?.learningItems?.find(it => it.learning_item_id === itemId || (it as any).id === itemId)
 const opKey = `${itemId}:${action}:${currentItem?.version || 1}`
 if (!opKeysRef.current[opKey]) {
 opKeysRef.current[opKey] = `panel-op-${itemId}-${action}-${currentItem?.version || 1}`
 }
 const idempotencyKey = opKeysRef.current[opKey]
 const payload: Record<string, any> = {
 sessionId,
 branchId,
 version: currentItem?.version,
 idempotencyKey,
 }
 if (overrideContent !== undefined) {
 payload.content = overrideContent
 }
 const res = await apiPost<{ ok: boolean; status?: string; error?: string }>(
 `/api/learning-items/${itemId}/${action}`,
 payload
 )
 if (res.ok) {
 if (action === 'edit') {
 setEditingItem(null)
 }
 await fetchSessionLearning()
 } else {
 setErrorMessage(res.error || `操作 ${action} 失败`)
 }
 } catch (err: any) {
 console.error(`Failed to execute ${action} on ${itemId}:`, err)
 setErrorMessage(err?.message || `执行 ${action} 异常`)
 } finally {
 setActionLoading(null)
 }
 }

 const handleSealEpisode = async (episodeId: string) => {
 // 封存没有防重：连点会向后端重复提交。用 in-flight 标记挡住。
 if (sealingEpisode) return
 setSealingEpisode(episodeId)
 try {
 await apiPost('/api/episodes/seal', { episodeId, sessionId, branchId, reason: 'user_manual' })
 await fetchSessionLearning()
 } catch (err: any) {
 console.error('Failed to seal episode:', err)
 setErrorMessage(err?.message || '封存片段失败')
 } finally {
 setSealingEpisode(null)
 }
 }

 const handleShowTrace = async (itemId: string) => {
 try {
 const url = `/api/learning-items/${itemId}/trace?sessionId=${encodeURIComponent(sessionId)}&branchId=${encodeURIComponent(branchId)}`
 const res = await apiGet<{ itemId: string; events: any[] }>(url)
 setSelectedTraceItem(res)
 } catch (err: any) {
 console.error('Failed to load item trace:', err)
 setErrorMessage(err?.message || '加载事件链失败')
 }
 }

 if (!sessionId) {
 return (
 <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted-foreground">
 <Sparkles className="w-8 h-8 mb-2 opacity-40" />
 <p className="text-sm">请先选择或创建一个会话</p>

 </div>
 )
 }

 const episodes = data?.episodes || []
 const items = data?.learningItems || []
 const counts = data?.counts || { total: 0, actionable: 0, published: 0, deferred: 0, failed: 0 }
 const crossSession = data?.crossSessionReused || []

 return (
 <div className="flex flex-col h-full bg-background overflow-hidden text-foreground">
 {/* Header */}
 <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between shrink-0 bg-muted/20">
 <div className="flex items-center gap-2">
 <Sparkles className="w-4 h-4 text-primary" />
 <span className="text-xs font-semibold tracking-wide">本次会话学习</span>
 <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
 <Lock className="w-3 h-3" />
 会话作用域
 </span>
 </div>
 <button
 type="button"
 onClick={() => { void fetchSessionLearning() }}
 disabled={loading}
 className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
 title="刷新"
 >
 <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
 </button>
 </div>

 {/* Error Alert */}
 {errorMessage && (
 <div className="mx-3 mt-2 p-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-[11px] flex items-center justify-between">
 <div className="flex items-center gap-1.5 truncate">
 <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
 <span className="truncate">{errorMessage}</span>
 </div>
 <button
 type="button"
 onClick={() => setErrorMessage(null)}
 className="p-0.5 hover:bg-destructive/20 rounded text-destructive"
 >
 ✕
 </button>
 </div>
 )}

 {/* Metrics Bar */}
 <div className="grid grid-cols-4 gap-1 p-2 bg-muted/10 border-b border-border/30 text-center shrink-0">
 <div className="py-1 px-1.5 rounded bg-card/60">
 <div className="text-[10px] text-muted-foreground">总计发现</div>
 <div className="text-xs font-bold text-foreground">{counts.total}</div>
 </div>
 <div className="py-1 px-1.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
 <div className="text-[10px]">待处理</div>
 <div className="text-xs font-bold">{counts.actionable}</div>
 </div>
 <div className="py-1 px-1.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
 <div className="text-[10px]">已沉淀</div>
 <div className="text-xs font-bold">{counts.published}</div>
 </div>
 <div className="py-1 px-1.5 rounded bg-muted/40 text-muted-foreground">
 <div className="text-[10px]">已暂缓</div>
 <div className="text-xs font-bold">{counts.deferred}</div>
 </div>
 </div>

 {/* Main Content Area */}
 <div className="flex-1 overflow-y-auto p-3 space-y-4">
 {/* Episodes Timeline */}
 <div>
 <div className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center justify-between">
 <div className="flex items-center gap-1.5">
 <Layers className="w-3.5 h-3.5" />
 <span>会话分段 (Episodes)</span>
 </div>
 {data?.activeEpisode && (
 <span className="text-[10px] text-blue-500 font-medium">
 当前片段活跃中
 </span>
 )}
 </div>

 {episodes.length === 0 ? (
 <div className="text-xs text-muted-foreground/70 p-3 rounded-lg border border-dashed border-border/60 text-center">
 会话进行中，达到静默期或切换话题时将自动归档片段并提取经验
 </div>
 ) : (
 <div className="space-y-2">
 {episodes.map((ep) => {
 const epItems = items.filter((i) => i.episode_id === ep.episode_id)
 const isExpanded = expandedEpisode === ep.episode_id
 return (
 <div
 key={ep.episode_id}
 className="border border-border/50 rounded-lg overflow-hidden bg-card/40 transition"
 >
 <div
 onClick={() => setExpandedEpisode(isExpanded ? null : ep.episode_id)}
 className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-muted/30 select-none text-xs"
 >
 <div className="flex items-center gap-2 min-w-0">
 {isExpanded ? (
 <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
 ) : (
 <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
 )}
 <span className="font-medium truncate">{ep.topic || '常规对话片段'}</span>
 <span
 className={`text-[10px] px-1.5 py-0.2 rounded-full ${
 ep.status === 'active'
 ? 'bg-blue-500/10 text-blue-500 font-medium'
 : 'bg-muted text-muted-foreground'
 }`}
 >
 {ep.status === 'active' ? '进行中' : '已封存'}
 </span>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 <span className="text-[10px] text-muted-foreground">
 {ep.turn_ids?.length || 0} 轮 · {epItems.length} 学习项
 </span>
 {ep.status === 'active' && (
 <button
 type="button"
 disabled={sealingEpisode !== null}
 onClick={(e) => {
 e.stopPropagation()
 void handleSealEpisode(ep.episode_id)
 }}
 className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent border border-border text-foreground transition disabled:opacity-50 disabled:cursor-not-allowed"
 >
 {sealingEpisode === ep.episode_id ? '封存中…' : '封存片段'}
 </button>
 )}
 </div>
 </div>

 {isExpanded && (
 <div className="px-3 py-2 border-t border-border/30 bg-muted/10 space-y-2">
 {epItems.length === 0 ? (
 <div className="text-[11px] text-muted-foreground/60 py-1">本片段暂无提取的学习项</div>
 ) : (
 epItems.map((item) =>
 renderLearningItemCard(
 item,
 actionLoading,
 handleAction,
 handleShowTrace,
 editingItem,
 setEditingItem
 )
 )
 )}
 </div>
 )}
 </div>
 )
 })}
 </div>
 )}
 </div>

 {/* Unbound / Goal Learning Items */}
 {items.filter((i) => !i.episode_id).length > 0 && (
 <div>
 <div className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
 <Boxes className="w-3.5 h-3.5" />
 <span>任务自主学习产物</span>
 </div>
 <div className="space-y-2">
 {items
 .filter((i) => !i.episode_id)
 .map((item) =>
 renderLearningItemCard(
 item,
 actionLoading,
 handleAction,
 handleShowTrace,
 editingItem,
 setEditingItem
 )
 )}
 </div>
 </div>
 )}

 {/* Cross-session Reusable items */}
 {crossSession.length > 0 && (
 <div>
 <div className="text-[11px] font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
 <Compass className="w-3.5 h-3.5" />
 <span>已激活的全局/工作区长效知识 (跨会话可用)</span>
 </div>
 <div className="space-y-1.5">
 {crossSession.map((m: any) => (
 <div
 key={m.id}
 className="p-2 rounded-lg border border-border/40 bg-muted/10 text-xs flex items-start justify-between gap-2"
 >
 <div className="min-w-0 flex-1">
 <div className="flex items-center gap-1.5 mb-1">
 <span className="text-[10px] font-semibold px-1 py-0.2 rounded bg-primary/10 text-primary">
 {m.kind === 'wiki' ? 'Wiki 规则' : '记忆事实'}
 </span>
 <span className="text-[10px] text-muted-foreground truncate">
 {m.root || '全局'}
 </span>
 </div>
 <p className="text-[11px] text-foreground/85 line-clamp-2 leading-relaxed">{m.content}</p>
 </div>
 </div>
 ))}
 </div>
 </div>
 )}
 </div>

 {/* Event Trace Modal */}
 {selectedTraceItem && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
 <div className="bg-card border border-border rounded-xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl">
 <div className="px-4 py-3 border-b border-border flex items-center justify-between">
 <div className="flex items-center gap-2">
 <History className="w-4 h-4 text-primary" />
 <span className="text-xs font-semibold">不可篡改事件溯源 (Event Trace)</span>
 </div>
 <button
 type="button"
 onClick={() => setSelectedTraceItem(null)}
 className="p-1 rounded text-muted-foreground hover:text-foreground"
 >
 ✕
 </button>
 </div>
 <div className="flex-1 overflow-y-auto p-4 space-y-2 text-xs">
 {selectedTraceItem.events.length === 0 ? (
 <div className="text-muted-foreground text-center py-6">无相关事件记录</div>
 ) : (
 selectedTraceItem.events.map((ev, idx) => (
 <div key={idx} className="p-2.5 rounded bg-muted/30 border border-border/40 font-mono text-[11px]">
 <div className="flex justify-between text-muted-foreground mb-1">
 <span className="font-semibold text-primary">{ev.eventType || ev.event_type}</span>
 <span>seq: {ev.seq}</span>
 </div>
 <div className="text-foreground/90 break-words">{JSON.stringify(ev.payload, null, 2)}</div>
 </div>
 ))
 )}
 </div>
 </div>
 </div>
 )}
 </div>
 )
}

function renderLearningItemCard(
 item: LearningItem,
 actionLoading: string | null,
 handleAction: (id: string, action: 'approve' | 'reject' | 'defer' | 'revoke' | 'edit', content?: string) => void,
 handleShowTrace: (id: string) => void,
 editingItem: { id: string; content: string } | null,
 setEditingItem: (val: { id: string; content: string } | null) => void
) {
 const isActionable = item.status === 'proposed' || item.status === 'staged' || item.user_verdict === 'pending'
 const isPublished = item.status === 'published' || item.user_verdict === 'approved'
 const isDeferred = item.status === 'deferred' || item.user_verdict === 'deferred'
 const isEditing = editingItem?.id === item.learning_item_id

 const getKindBadge = () => {
 switch (item.kind) {
 case 'memory_fact':
 case 'preference':
 return { label: '记忆事实', icon: BookOpen, color: 'text-blue-500 bg-blue-500/10' }
 case 'skill_step':
 return { label: '技能候选', icon: FileCode, color: 'text-purple-500 bg-purple-500/10' }
 case 'failure_guard':
 return { label: '失败防护', icon: ShieldAlert, color: 'text-rose-500 bg-rose-500/10' }
 default:
 return { label: '经验策略', icon: Boxes, color: 'text-amber-500 bg-amber-500/10' }
 }
 }

 const badge = getKindBadge()
 const Icon = badge.icon

 return (
 <div key={item.learning_item_id} className="p-2.5 rounded-lg border border-border/60 bg-card text-xs space-y-2">
 <div className="flex items-start justify-between gap-2">
 <div className="flex items-center gap-1.5">
 <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>
 <Icon className="w-3 h-3" />
 {badge.label}
 </span>
 <span className="text-[10px] text-muted-foreground uppercase">{item.scope}</span>
 </div>
 <div className="flex items-center gap-1">
 <span
 className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
 isPublished
 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
 : isActionable
 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
 : isDeferred
 ? 'bg-muted text-muted-foreground'
 : 'bg-rose-500/10 text-rose-500'
 }`}
 >
 {item.status}
 </span>
 <button
 type="button"
 onClick={() => handleShowTrace(item.learning_item_id)}
 className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
 title="查看事件证据链"
 >
 <History className="w-3 h-3" />
 </button>
 </div>
 </div>

 {isEditing ? (
 <div className="space-y-1.5">
 <textarea
 value={editingItem.content}
 onChange={(e) => setEditingItem({ id: item.learning_item_id, content: e.target.value })}
 className="w-full p-2 text-xs rounded border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
 rows={2}
 />
 <div className="flex justify-end gap-1">
 <button
 type="button"
 onClick={() => setEditingItem(null)}
 className="px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-muted"
 >
 取消
 </button>
 <button
 type="button"
 disabled={actionLoading === item.learning_item_id}
 onClick={() => handleAction(item.learning_item_id, 'edit', editingItem.content)}
 className="px-2 py-0.5 rounded text-[10px] bg-primary text-primary-foreground font-medium"
 >
 保存
 </button>
 </div>
 </div>
 ) : (
 <div className="font-medium text-foreground/90 leading-snug">{item.content}</div>
 )}

 {item.why && (
 <div className="text-[11px] text-muted-foreground bg-muted/20 p-1.5 rounded leading-relaxed">
 <span className="font-semibold text-foreground/75">为何学习：</span>
 {item.why}
 </div>
 )}

 {item.future_effect && (
 <div className="text-[10px] text-muted-foreground/80">
 <span className="font-medium">后续影响：</span>
 {item.future_effect}
 </div>
 )}

 {item.deferred_reason && (
 <div className="text-[10px] text-amber-600/80 bg-amber-500/5 p-1 rounded">
 <span className="font-medium">暂缓原因：</span>
 {item.deferred_reason}
 </div>
 )}

 {/* Action Buttons */}
 <div className="flex items-center justify-between pt-1 border-t border-border/30">
 <div>
 {!isEditing && (isActionable || isDeferred) && (
 <button
 type="button"
 onClick={() => setEditingItem({ id: item.learning_item_id, content: item.content })}
 className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
 >
 <Edit3 className="w-2.5 h-2.5" />
 编辑
 </button>
 )}
 </div>
 <div className="flex items-center gap-1.5">
 {(isActionable || isDeferred) && (
 <>
 <button
 type="button"
 disabled={actionLoading === item.learning_item_id}
 onClick={() => handleAction(item.learning_item_id, 'approve')}
 className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition"
 >
 <CheckCircle2 className="w-3 h-3" />
 采纳
 </button>
 {isActionable && (
 <button
 type="button"
 disabled={actionLoading === item.learning_item_id}
 onClick={() => handleAction(item.learning_item_id, 'defer')}
 className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition"
 >
 <Clock className="w-3 h-3" />
 暂缓
 </button>
 )}
 <button
 type="button"
 disabled={actionLoading === item.learning_item_id}
 onClick={() => handleAction(item.learning_item_id, 'reject')}
 className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded hover:bg-destructive/10 text-destructive transition"
 >
 <XCircle className="w-3 h-3" />
 拒绝
 </button>
 </>
 )}

 {isPublished && (
 <button
 type="button"
 disabled={actionLoading === item.learning_item_id}
 onClick={() => handleAction(item.learning_item_id, 'revoke')}
 className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive transition"
 >
 <RotateCcw className="w-3 h-3" />
 撤销/回滚
 </button>
 )}
 </div>
 </div>
 </div>
 )
}

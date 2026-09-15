// src/components/chat/QueuePanel.tsx
// The waiting list that sits directly above the composer. Only rendered when
// something is actually queued, so it costs zero space in the common case.
//
// Per item: drag to reorder, 立即 to jump the line, pencil to edit inline,
// trash to drop it. When the queue is paused a banner explains why and offers
// 继续 — nothing auto-sends behind the user's back.
import { useState, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Pencil, Trash2, ArrowUp, Check, X, PlayCircle, ListOrdered, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@lib/utils'
import { useQueueStore, type QueuedPrompt } from '@store/queueStore'
import { useAgentStore } from '@store/agentStore'

/** "刚刚" / "等待 2 分钟" — how long this item has been in line. */
function waitedLabel(queuedAt: number, now: number, t: any): string {
  const secs = Math.floor((now - queuedAt) / 1000)
  if (secs < 10) return t('queue.justNow', '刚刚')
  if (secs < 60) return t('queue.seconds', '{{n}} 秒', { n: secs })
  return t('queue.minutes', '{{n}} 分钟', { n: Math.floor(secs / 60) })
}

interface RowProps {
  item: QueuedPrompt
  index: number
  now: number
}

function QueueRow({ item, index, now }: RowProps) {
  const { t } = useTranslation()
  const { beginEdit, endEdit, editingId } = useQueueStore()
  const send = useAgentStore((s) => s.send)
  const isWorking = useAgentStore((s) => s.isWorking)
  const steer = useAgentStore((s) => s.steer)
  const sendMessage = useAgentStore((s) => s.sendMessage)
  const [draft, setDraft] = useState(item.text)
  const isEditing = editingId === item.id

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: isEditing })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  const commit = () => {
    const next = draft.trim()
    if (next && next !== item.text) send('queue_update_text', { id: item.id, text: next })
    endEdit()
  }

  const handleSendNow = () => {
    send('queue_remove', { id: item.id })
    if (isWorking) {
      steer(item.text, { immediate: true, urgent_interrupt: true })
    } else {
      void sendMessage(item.text)
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-queue-index={index}
      className={cn(
        'group flex items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 text-xs transition-colors select-none',
        'hover:bg-foreground/[0.04]',
        isDragging && 'bg-muted/80 shadow-md',
        isEditing && 'bg-muted/60',
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <button
          {...attributes}
          {...listeners}
          aria-label={t('queue.dragToSort', '拖动排序')}
          className={cn(
            'shrink-0 text-muted-foreground/40 hover:text-foreground cursor-grab active:cursor-grabbing transition-colors',
            isEditing && 'opacity-30 cursor-not-allowed',
          )}
        >
          <GripVertical size={14} />
        </button>

        {isEditing ? (
          <>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit() }
                if (e.key === 'Escape') { setDraft(item.text); endEdit() }
              }}
              className="flex-1 min-w-0 bg-background/80 px-2.5 py-1 rounded-lg border border-primary/40 text-xs focus:outline-none text-foreground"
            />
            <div className="shrink-0 flex items-center gap-1">
              <button
                type="button"
                onClick={commit}
                aria-label={t('common.save', '保存')}
                title={t('common.save', '保存修改')}
                className="p-1 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                onClick={() => { setDraft(item.text); endEdit() }}
                aria-label={t('queue.cancelEdit', '取消编辑')}
                title={t('queue.cancelEdit', '取消')}
                className="p-1 rounded-md text-muted-foreground hover:bg-muted transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </>
        ) : (
          <span className="flex-1 min-w-0 truncate text-[13px] text-foreground font-normal leading-relaxed" title={item.text}>
            {item.text}
          </span>
        )}
      </div>

      {!isEditing && (
        <div className="shrink-0 flex items-center gap-1.5">
          {/* 1. [ ↑ 立即 / 插队 ] Button */}
          <button
            type="button"
            onClick={handleSendNow}
            aria-label={t('queue.sendNow', '立即发送')}
            title={isWorking ? t('queue.steerNow', '立即插队（硬打断当前执行）') : t('queue.sendNow', '立即发送')}
            className={cn(
              "inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium transition-all active:scale-95",
              isWorking
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20"
                : "bg-muted/70 hover:bg-muted border-border/40 hover:border-border/80 text-foreground"
            )}
          >
            <ArrowUp size={11.5} className="stroke-[2.2]" />
            <span>{isWorking ? t('queue.steer', '插队') : t('queue.jump', '立即')}</span>
          </button>

          {/* 2. [ ✏️ ] Edit Button */}
          <button
            type="button"
            onClick={() => { setDraft(item.text); beginEdit(item.id) }}
            aria-label={t('common.edit', '编辑')}
            title={t('common.edit', '编辑')}
            className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
          >
            <Pencil size={13} />
          </button>

          {/* 3. [ 🗑️ ] Delete Button */}
          <button
            type="button"
            onClick={() => send('queue_remove', { id: item.id })}
            aria-label={t('common.delete', '删除')}
            title={t('common.delete', '删除')}
            className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </li>
  )
}

const PAUSE_COPY: Record<string, { key: string; fallback: string }> = {
  interrupted: { key: 'queue.pauseInterrupted', fallback: '你中断了当前回答，队列已暂停' },
  error: { key: 'queue.pauseError', fallback: '上一条出错了，队列已暂停' },
  manual: { key: 'queue.pauseManual', fallback: '队列已暂停' },
}

interface QueuePanelProps {
  className?: string
}

export function QueuePanel({ className }: QueuePanelProps) {
  const { t } = useTranslation()
  const { items, paused, pauseReason } = useQueueStore()
  const send = useAgentStore((s) => s.send)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  if (items.length === 0) return null

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = items.findIndex((i) => i.id === active.id)
    const to = items.findIndex((i) => i.id === over.id)
    if (from < 0 || to < 0) return
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    useQueueStore.setState({ items: next })
    send('queue_reorder', { ids: next.map((i) => i.id) })
  }

  return (
    <div className={cn('rounded-2xl border border-border/60 bg-popover/80 backdrop-blur-md px-3 py-2 shadow-sm space-y-1', className)}>
      {paused && (
        <div className="mb-1 flex items-center gap-2 rounded-lg border border-warning/35 bg-warning/10 px-2 py-1">
          <span className="flex-1 text-[11px] text-warning">
            {(() => { const c = PAUSE_COPY[pauseReason ?? 'manual']; return t(c.key, c.fallback) })()}
          </span>
          <button
            onClick={() => send('queue_resume')}
            className="inline-flex items-center gap-1 rounded-md bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/30 transition-colors"
          >
            <PlayCircle size={11} />
            {t('queue.resume', '继续')}
          </button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5 max-h-40 overflow-y-auto">
            {items.map((item, i) => (
              <QueueRow key={item.id} item={item} index={i} now={now} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  )
}

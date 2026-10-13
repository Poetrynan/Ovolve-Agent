import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { MarkdownContent } from './MarkdownContent'
import { Copy, Check, Pencil, RefreshCw, GitBranch, Undo2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip'

interface BubbleProps {
  role: 'user' | 'assistant'
  children: React.ReactNode
  className?: string
  messageId?: string
  /**
   * This bubble is the tail of a live stream. Two effects, both about telling
   * the user the difference between "still arriving" and "done":
   *   · no text yet → a shimmering skeleton instead of an empty box, so the
   *     bubble doesn't appear as a rendering glitch during first-token latency
   *   · text present → a blinking caret at the tail, the universal "typing" tell
   * Without it, a finished short reply and a stalled stream look identical.
   */
  streaming?: boolean
  /**
   * Pull this message's text back into the composer and drop it (plus everything
   * after it) from the timeline, so the user can reword and resend. User rows
   * only — editing an assistant reply is meaningless.
   */
  onEdit?: (id: string) => void
  /**
   * Called when the user confirms their inline edit on a user bubble.
   */
  onSaveEdit?: (id: string, newContent: string) => void
  /**
   * Re-run the turn that produced THIS assistant reply: drop it and re-send the
   * user message above it. Assistant rows only — regenerating a user message is
   * meaningless (that's what `onEdit` is for).
   *
   * Suppressed while `streaming` is true: offering "regenerate" on a reply that
   * is still arriving invites a click that races the stream.
   */
  onRegenerate?: (id: string) => void
  /**
   * Fork the conversation here (UA1): a NEW session that keeps history up to
   * just before this message, leaving this one and everything after it intact.
   *
   * The additive sibling of `onEdit`. Edit rewrites the past; fork keeps it and
   * opens a second line — so "let me try another approach" stops costing you the
   * first one. User rows only.
   */
  onFork?: (id: string) => void
  /**
   * Roll the session back TO this turn (IDE-style undo point):
   * keep everything up to and including this bubble, withdraw every message
   * and file change made after it. The caller owns the confirm dialog —
   * this only opens it. User rows only, and not on the last user turn
   * (nothing after it to drop).
   */
  onRollbackTurn?: () => void
  /**
   * Play the drop-in entrance? True for a message that just ARRIVED, false for
   * one restored from history.
   *
   * This matters because the entrance is a CSS keyframe: it fires once per DOM
   * node creation, and it cannot tell "new reply" from "session switched". So
   * loading a 30-message conversation used to slide all 30 bubbles up from 10px
   * at the same instant, while the scroller was simultaneously jumping to the
   * bottom — the twitch you see the moment a session opens. Restored history was
   * already there as far as the user is concerned; it should just be there.
   */
  animate?: boolean
  /** When this message was sent (seconds, same wire clock as tool calls). */
  timestamp?: number
  /**
   * What the turn cost (duration / tokens / money), stamped by the store on
   * `completed`. Assistant rows only; renders as a quiet chip next to the
   * hover actions.
   */
  turnStats?: {
    durationMs: number
    tokens?: number
    costMicros?: number
    /** `reported` = provider-billed; anything else = rate-table estimate. */
    costSource?: string
  }
}

/** "1.2s" / "1m03s" — wall-clock turn duration in the smallest clean unit. */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function Bubble({ role, children, className, messageId, streaming, onEdit, onSaveEdit, onRegenerate, onFork, onRollbackTurn, animate = true, timestamp, turnStats }: BubbleProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const isUser = role === 'user'
  const canEdit = isUser && (!!onSaveEdit || !!onEdit) && !!messageId
  const canRegenerate = !isUser && !!onRegenerate && !!messageId && !streaming
  const canFork = isUser && !!onFork && !!messageId
  const canRollback = isUser && !!onRollbackTurn
  const isEmpty = typeof children === 'string' ? children.trim() === '' : !children

  const handleCopy = async () => {
    const text = typeof children === 'string' ? children : ''
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    setEditText(typeof children === 'string' ? children : '')
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setIsEditing(false)
  }

  const submitEdit = () => {
    if (!editText.trim() || !messageId) return
    if (onSaveEdit) {
      onSaveEdit(messageId, editText.trim())
    } else if (onEdit) {
      onEdit(messageId)
    }
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className={cn('w-full flex justify-end', className)}>
        <div className="w-fit max-w-[85%] min-w-[280px] sm:min-w-[340px] rounded-2xl rounded-br-sm p-3 bg-card text-card-foreground border border-border focus-within:border-ring/50 focus-within:ring-1 focus-within:ring-ring/20 shadow-xs transition-all animate-message-in">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitEdit()
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                submitEdit()
              } else if (e.key === 'Escape') {
                cancelEdit()
              }
            }}
            rows={Math.min(10, Math.max(2, editText.split('\n').length))}
            className="w-full bg-transparent text-foreground text-[0.935rem] leading-relaxed border-0 focus:outline-none focus:ring-0 p-0 resize-none placeholder:text-muted-foreground/50"
            autoFocus
            placeholder={t('chat.editMessagePlaceholder', '编辑消息...')}
          />
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/60">
            <span className="text-[11px] text-muted-foreground select-none">
              Esc 取消 · ↵ 发送 · Shift+↵ 换行
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={cancelEdit}
                className="h-6 px-2 text-[11px] font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={!editText.trim()}
                className="h-6 px-2.5 text-[11px] font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-all disabled:opacity-40 shadow-2xs active:scale-98"
              >
                {t('common.send', '发送')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('group w-full select-text', className)}>
      <div
        className={cn(
          'text-[0.95rem] leading-relaxed transition-all duration-200 select-text',
          animate && 'animate-message-in',
          isUser
            ? 'w-fit max-w-full ml-auto bg-transparent border-0 text-foreground font-medium shadow-none px-0 py-0.5'
            : 'w-full max-w-full bg-transparent border-0 text-foreground shadow-none px-0 py-0.5'
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words select-text">{children}</div>
        ) : streaming && isEmpty ? (
          <div className="space-y-2 py-1" aria-label="正在生成…">
            <div className="shimmer h-3.5 w-[75%] rounded-md" />
            <div className="shimmer h-3.5 w-[90%] rounded-md" />
            <div className="shimmer h-3.5 w-[60%] rounded-md" />
          </div>
        ) : (
          typeof children === 'string' ? (
            <MarkdownContent content={children} />
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {children}
            </div>
          )
        )}
      </div>

      <div
        className={cn(
          'flex items-center gap-0.5 mt-1',
          'opacity-40 group-hover:opacity-100 focus-within:opacity-100',
          'transition-opacity duration-150 motion-reduce:opacity-100',
          isUser ? 'justify-end' : 'justify-start',
        )}
      >
        {(timestamp || turnStats) && (
          <span className="text-[11px] text-muted-foreground/80 tabular-nums mr-1 select-none whitespace-nowrap">
            {timestamp
              ? new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ''}
            {turnStats && (
              <>
                {timestamp ? ' · ' : ''}
                {fmtDuration(turnStats.durationMs)}
                {typeof turnStats.tokens === 'number' && turnStats.tokens > 0
                  ? ` · ${fmtTokens(turnStats.tokens)} tok` : ''}
                {typeof turnStats.costMicros === 'number' && turnStats.costMicros > 0 ? (
                  <span
                    title={
                      turnStats.costSource === 'reported'
                        ? '服务商上报的实际计费金额。'
                        : turnStats.costSource === 'fallback'
                          ? '推算值：内置费率表没有收录这个模型，使用了中位费率。仅供参考，不是账单金额。'
                          : '推算值：按内置费率表 × token 数计算。不是账单金额。'
                    }
                  >
                    {` · ${turnStats.costSource === 'reported' ? '' : '≈'}$${(turnStats.costMicros / 1e6).toFixed(4)}`}
                  </span>
                ) : ''}
              </>
            )}
          </span>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              aria-label={t('common.copy')}
            >
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{copied ? t('common.copied') : t('common.copy')}</p></TooltipContent>
        </Tooltip>

        {canEdit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={startEdit}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('common.edit')}
              >
                <Pencil size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t('common.edit')}</p></TooltipContent>
          </Tooltip>
        )}

        {canFork && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onFork!(messageId!)}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('common.fork')}
              >
                <GitBranch size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[220px]">
              <p>{t('common.fork')}</p>
              <p className="text-[11px] text-muted-foreground">{t('common.forkHint')}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {canRollback && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRollbackTurn!}
                className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                aria-label={t('timeline.rollbackToHere', '回滚到此轮')}
              >
                <Undo2 size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px]">
              <p>{t('timeline.rollbackToHere', '回滚到此轮')}</p>
              <p className="text-[11px] text-muted-foreground">
                {t('timeline.rollbackToHereHint', '保留到此轮为止的对话，撤回它之后的所有消息与文件改动（不可撤销）')}
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {canRegenerate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onRegenerate!(messageId!)}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('common.regenerate')}
              >
                <RefreshCw size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t('common.regenerate')}</p></TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export function BubbleAvatar({
  role,
  name = 'Ovolve',
  working = false,
  className,
}: {
  role: 'user' | 'assistant'
  name?: string
  working?: boolean
  className?: string
}) {
  const isUser = role === 'user'

  return (
    <div
      className={cn(
        'h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold overflow-hidden border select-none',
        isUser
          ? 'bg-muted text-muted-foreground border-border/60'
          : 'bg-card border-border/40 shadow-xs p-0.5',
        !isUser && working && 'agent-breathe ring-2 ring-primary/40',
        className,
      )}
    >
      {isUser ? (
        '你'
      ) : (
        <img
          src="/icon.png"
          alt="Ovolve"
          className="h-full w-full object-cover rounded-full pointer-events-none"
        />
      )}
    </div>
  )
}

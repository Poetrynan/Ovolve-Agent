/**
 * TimelineRail — 吸附式轮次时间轴（Step Tracker）。
 *
 * 一列贴在聊天区右缘的小圆点，纯导航：
 *   - hover 某个圆点 → 仅该点的左侧浮现它的首句摘要（无背景纯文字）
 *   - 点击           → 平滑滚动到对应轮次
 *   - 当前轮         → 主色点（略大）；agent 工作中时呼吸闪烁
 *
 * 没有面板、没有底色：整个 rail 只是点 + 悬浮文字。回滚入口在每条
 * 用户气泡的操作栏（Bubble 的 onRollbackTurn），这里不承载。
 */
import { useMemo, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { Message } from '@apptypes/index'
import type { CheckpointNode } from '@store/checkpointStore'

export interface Turn {
  index: number
  /** The user message that starts this turn. */
  userMsg: Message
  /** All messages in this turn (user + assistant reply + tool calls inside). */
  messages: Message[]
  /** Character count of this turn. */
  charCount: number
}

/** Scan the flat message list and partition it into turns (one per user bubble). */
export function partitionTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let current: Message[] = []
  let idx = 0

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current.length > 0) {
        const chars = current.reduce((s, m) => s + (m.content?.length ?? 0), 0)
        turns.push({ index: idx++, userMsg: current[0], messages: current, charCount: chars })
      }
      current = [msg]
    } else {
      current.push(msg)
    }
  }
  if (current.length > 0 && current.some((m) => m.role === 'user')) {
    const chars = current.reduce((s, m) => s + (m.content?.length ?? 0), 0)
    turns.push({ index: idx++, userMsg: current[0], messages: current, charCount: chars })
  }
  return turns
}

/** First line of the user prompt — the hover label. Single line, CSS-truncated. */
function firstLine(msg: Message): string {
  const text = (msg.content || '').trim()
  return text.split('\n')[0] || text
}

export interface TimelineRailProps {
  messages: Message[]
  /** Ref to the scroll container so we can scrollIntoView on click. */
  scrollerRef: React.RefObject<HTMLElement | null>
  className?: string
  /** Checkpoint annotations — a custom label (if any) replaces the summary. */
  checkpoints?: CheckpointNode[]
  /** True while the agent is driving the current turn → breathing dot on the tail. */
  working?: boolean
  sessionId?: string | null
}

export function TimelineRail({
  messages,
  scrollerRef,
  className,
  checkpoints,
  working = false,
  sessionId,
}: TimelineRailProps) {
  const { t } = useTranslation()
  const turns = useMemo(() => partitionTurns(messages), [messages])
  const labels = useMemo(() => {
    const m = new Map<number, string>()
    for (const c of checkpoints || []) {
      if (c.label) m.set(c.ordinal, c.label)
    }
    return m
  }, [checkpoints])
  const [activeTurn, setActiveTurn] = useState(() => (turns.length > 0 ? turns.length - 1 : 0))
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  // Which row is hovered: { vertical position within the rail }. The label is
  // rendered OUTSIDE the scrolling dot column (see below) so it can overhang
  // to the left without being clipped — `overflow-y-auto` on the column would
  // otherwise turn into a clip in x too.
  const [hovered, setHovered] = useState<{ idx: number; top: number } | null>(null)

  // ── Scroll → highlight sync (ScrollSpy) ──
  const updateActiveTurn = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || turns.length === 0) return

    const scrollBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    // 1. If near bottom (within 96px), active turn is definitely the latest turn
    if (scrollBottom <= 96) {
      setActiveTurn(turns.length - 1)
      return
    }

    // 2. If near top, active turn is turn 0
    if (scroller.scrollTop <= 40) {
      setActiveTurn(0)
      return
    }

    // 3. Otherwise find which turn is currently under the reading line (35% from top of viewport)
    const userEls = Array.from(scroller.querySelectorAll<HTMLElement>('[data-role="user"]'))
    if (userEls.length === 0) return

    const readingY = scroller.scrollTop + scroller.clientHeight * 0.35
    let currentIdx = 0

    for (const el of userEls) {
      const turnIdx = Number(el.getAttribute('data-turn-index'))
      if (isNaN(turnIdx)) continue
      if (el.offsetTop <= readingY) {
        currentIdx = turnIdx
      } else {
        break
      }
    }

    setActiveTurn(currentIdx)
  }, [scrollerRef, turns.length])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    updateActiveTurn()

    scroller.addEventListener('scroll', updateActiveTurn, { passive: true })
    window.addEventListener('resize', updateActiveTurn, { passive: true })

    const r1 = requestAnimationFrame(() => {
      updateActiveTurn()
      const r2 = requestAnimationFrame(updateActiveTurn)
      return () => cancelAnimationFrame(r2)
    })

    return () => {
      scroller.removeEventListener('scroll', updateActiveTurn)
      window.removeEventListener('resize', updateActiveTurn)
      cancelAnimationFrame(r1)
    }
  }, [messages, updateActiveTurn, scrollerRef])

  // ── Keep the active dot visible inside the rail itself ──
  // Manual scrollTop math, NOT scrollIntoView: the rail shares the page with
  // the message scroller, and scrollIntoView({nearest}) would happily scroll
  // BOTH containers, yanking the chat while the user is only hovering a dot.
  useLayoutEffect(() => {
    const list = listRef.current
    const row = activeRowRef.current
    if (!list || !row) return
    const top = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2
    if (top < 0) list.scrollTop = 0
    else if (top > list.scrollHeight - list.clientHeight) list.scrollTop = list.scrollHeight
    else list.scrollTop = top
  }, [activeTurn, turns.length])

  // ── Click → smooth-scroll to that turn ──
  const jumpTo = useCallback(
    (turnIndex: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      setActiveTurn(turnIndex)
      const target = scroller.querySelector<HTMLElement>(`[data-turn-index="${turnIndex}"]`)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [scrollerRef],
  )

  // A single dot has nowhere to jump — the rail would be pure decoration.
  if (turns.length < 2) return null

  const latestIdx = turns.length - 1

  return (
    <div
      className={cn('absolute left-2 top-1/2 -translate-y-1/2 z-30', className)}
      aria-label={t('timeline.title', '对话轮次')}
    >
      <div className="relative">
        {/* Hover label for exactly ONE row — the one under the pointer.
            Positioned from the row's offsetTop so it rides beside its dot.
            Reads as a floating chip (popover bg + border + shadow) so it stays
            legible over the chat bubbles it overlaps. */}
        {hovered && (
          <span
            className="pointer-events-none absolute left-full ml-2 -translate-y-1/2 max-w-[260px] truncate text-[11px] leading-none whitespace-nowrap text-foreground font-medium rounded-md bg-popover/95 backdrop-blur-sm border border-border/50 shadow-sm px-2 py-1 animate-in fade-in-0 duration-100"
            style={{ top: hovered.top + 8 }}
          >
            <span className="text-muted-foreground/70 font-mono mr-1">#{hovered.idx + 1}</span>
            {labels.get(hovered.idx) || firstLine(turns[hovered.idx]?.userMsg || ({ content: '' } as Message))}
          </span>
        )}

        <div
          ref={listRef}
          className={cn(
            'flex flex-col items-start gap-0.5 max-h-[60vh] overflow-y-auto py-1 pl-0.5',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
          {turns.map((turn) => {
            const isActive = turn.index === activeTurn
            const isLatest = turn.index === latestIdx
            const loading = isLatest && working
            return (
              <button
                key={turn.index}
                ref={isActive ? activeRowRef : undefined}
                type="button"
                onClick={() => jumpTo(turn.index)}
                onMouseEnter={(e) => setHovered({ idx: turn.index, top: e.currentTarget.offsetTop })}
                onMouseLeave={() => setHovered(null)}
                aria-label={`#${turn.index + 1} ${labels.get(turn.index) || firstLine(turn.userMsg)}`}
                className="group/row flex items-center justify-center h-4 w-4 rounded-full"
              >
                {/* Small dot. The button is 16px so the target stays easy to
                    hit; the visible dot is deliberately tiny. */}
                <span className="relative flex items-center justify-center">
                  {loading && (
                    <span className="absolute h-2 w-2 rounded-full bg-primary/40 animate-ping" />
                  )}
                  <span
                    className={cn(
                      'relative rounded-full transition-colors',
                      isActive
                        ? 'bg-primary h-1.5 w-1.5'
                        : 'bg-muted-foreground/40 h-1 w-1 group-hover/row:bg-muted-foreground',
                    )}
                  />
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Backward-compatibility aliases for the pre-sidebar component name. */
export const TurnRail = TimelineRail
export const TurnNavigator = TimelineRail

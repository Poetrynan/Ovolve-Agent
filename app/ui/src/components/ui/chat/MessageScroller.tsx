import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MessageScrollerProps {
  children: React.ReactNode
  className?: string
  /**
   * Optional handle on the scrolling viewport, for siblings that need to query
   * or observe it — the TurnRail uses it to run an IntersectionObserver and to
   * `scrollIntoView` a chosen turn.
   */
  viewportRef?: React.MutableRefObject<HTMLDivElement | null>
  /**
   * Change this when switching conversations to reset stickiness and pin to bottom instantly.
   */
  resetKey?: string | null
  /**
   * Triggers an immediate reset of stickiness and forces scrolling to the bottom (e.g. when user sends message).
   */
  forceScrollKey?: string | number | null
}

interface SessionScrollEntry {
  scrollTop: number
  scrollHeight: number
  wasAtBottom: boolean
}

// Module-level persistent scroll memory across session switches (IDE style)
const sessionScrollMemory = new Map<string, SessionScrollEntry>()

/**
 * Bottom pinning threshold: re-engage stickiness only when user is within 16px of bottom
 * (accounts for subpixel / DPI rounding).
 */
const AT_BOTTOM_THRESHOLD_PX = 16

export function MessageScroller({
  children,
  className,
  viewportRef: externalViewportRef,
  resetKey,
  forceScrollKey,
}: MessageScrollerProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  /** Follow the tail? Only flipped to false when the user INTENTIONALLY scrolls upward. */
  const stickRef = useRef(true)
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false)
  const isProgrammaticScrollRef = useRef(false)
  const rafScrollRef = useRef<number | null>(null)
  const prevResetKeyRef = useRef<string | null>(null)
  const lastScrollTopRef = useRef(0)

  // Mirror our internal viewport node onto the caller's ref, if provided.
  useEffect(() => {
    if (externalViewportRef) externalViewportRef.current = viewportRef.current
  }, [externalViewportRef])

  const scrollToBottom = useCallback((force = false) => {
    if (!force && !stickRef.current) return
    const el = viewportRef.current
    if (!el) return

    if (rafScrollRef.current) {
      cancelAnimationFrame(rafScrollRef.current)
    }

    rafScrollRef.current = requestAnimationFrame(() => {
      if (viewportRef.current && (force || stickRef.current)) {
        isProgrammaticScrollRef.current = true
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight
        lastScrollTopRef.current = viewportRef.current.scrollTop
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false
        })
      }
    })
  }, [])

  // 1. Session Switch / Reset Key -> Restore reading position or instant snap to bottom with 0 gliding
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return

    // Save previous session scroll position
    if (prevResetKeyRef.current && prevResetKeyRef.current !== resetKey) {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX
      sessionScrollMemory.set(prevResetKeyRef.current, {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        wasAtBottom: isNearBottom,
      })
    }
    prevResetKeyRef.current = resetKey ?? null

    // Prevent session switch from triggering forceScrollKey effect
    lastForceScrollRef.current = forceScrollKey

    const saved = resetKey ? sessionScrollMemory.get(resetKey) : undefined

    isProgrammaticScrollRef.current = true
    const canScroll = el.scrollHeight - el.clientHeight > AT_BOTTOM_THRESHOLD_PX
    if (saved && !saved.wasAtBottom && canScroll) {
      // User was reading earlier turns: restore exact reading position
      stickRef.current = false
      setShowScrollBottomBtn(true)
      el.scrollTop = saved.scrollTop
      lastScrollTopRef.current = saved.scrollTop
    } else {
      // User was at bottom (or initial open / short conversation): instant snap to bottom with 0ms delay
      stickRef.current = true
      setShowScrollBottomBtn(false)
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollHeight
    }

    // Stabilize across DOM/Math/Code expansions without animated gliding
    const r1 = requestAnimationFrame(() => {
      if (viewportRef.current && stickRef.current) {
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight
        lastScrollTopRef.current = viewportRef.current.scrollTop
      }
      const r2 = requestAnimationFrame(() => {
        if (viewportRef.current && stickRef.current) {
          viewportRef.current.scrollTop = viewportRef.current.scrollHeight
          lastScrollTopRef.current = viewportRef.current.scrollTop
        }
        isProgrammaticScrollRef.current = false
      })
      return () => cancelAnimationFrame(r2)
    })

    return () => cancelAnimationFrame(r1)
  }, [resetKey])

  // Explicit user send or turn event.
  const lastForceScrollRef = useRef(forceScrollKey)
  useEffect(() => {
    if (forceScrollKey !== undefined && forceScrollKey !== null && forceScrollKey !== lastForceScrollRef.current) {
      lastForceScrollRef.current = forceScrollKey
      stickRef.current = true
      setShowScrollBottomBtn(false)
      scrollToBottom(true)
    }
  }, [forceScrollKey, scrollToBottom])

  // Track user wheel and scroll intent.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop

    // Interrupt any in-flight programmatic scroll RAF when the user touches/wheels
    const interruptProgrammaticScroll = () => {
      if (rafScrollRef.current) {
        cancelAnimationFrame(rafScrollRef.current)
        rafScrollRef.current = null
      }
      isProgrammaticScrollRef.current = false
    }

    // 1. User Wheel Event: ANY upward scroll immediately and irrevocably flips stickiness off
    const onWheel = (e: WheelEvent) => {
      interruptProgrammaticScroll()
      const canScroll = el.scrollHeight - el.clientHeight > AT_BOTTOM_THRESHOLD_PX
      if (!canScroll) {
        stickRef.current = true
        setShowScrollBottomBtn(false)
        return
      }

      if (e.deltaY < 0) {
        // User deliberately scrolled up (any amplitude, micro-scroll or large)
        stickRef.current = false
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance > AT_BOTTOM_THRESHOLD_PX) {
          setShowScrollBottomBtn(true)
        }
      } else if (e.deltaY > 0) {
        // User scrolled down
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance <= AT_BOTTOM_THRESHOLD_PX) {
          stickRef.current = true
          setShowScrollBottomBtn(false)
        }
      }
    }

    // 2. Touch/Pointer drag events
    let startY = 0
    const onTouchStart = (e: TouchEvent) => {
      interruptProgrammaticScroll()
      startY = e.touches[0]?.clientY || 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const canScroll = el.scrollHeight - el.clientHeight > AT_BOTTOM_THRESHOLD_PX
      if (!canScroll) {
        stickRef.current = true
        setShowScrollBottomBtn(false)
        return
      }

      const currentY = e.touches[0]?.clientY || 0
      if (currentY - startY > 2) {
        // Swiped down -> moving view up
        stickRef.current = false
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance > AT_BOTTOM_THRESHOLD_PX) {
          setShowScrollBottomBtn(true)
        }
      } else if (startY - currentY > 2) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance <= AT_BOTTOM_THRESHOLD_PX) {
          stickRef.current = true
          setShowScrollBottomBtn(false)
        }
      }
    }

    // 3. Native scroll event: Dispatches for wheel, scrollbar drag, PageUp/ArrowUp
    const onScroll = () => {
      if (isProgrammaticScrollRef.current) return

      const currentScrollTop = el.scrollTop
      const isScrollingUp = currentScrollTop < lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      const canScroll = el.scrollHeight - el.clientHeight > AT_BOTTOM_THRESHOLD_PX
      if (!canScroll) {
        stickRef.current = true
        setShowScrollBottomBtn(false)
        return
      }

      const distance = el.scrollHeight - currentScrollTop - el.clientHeight

      if (isScrollingUp) {
        // User is scrolling UP: NEVER re-engage stickiness!
        stickRef.current = false
        if (distance > AT_BOTTOM_THRESHOLD_PX) {
          setShowScrollBottomBtn(true)
        }
      } else {
        // User is scrolling DOWN
        if (distance <= AT_BOTTOM_THRESHOLD_PX) {
          stickRef.current = true
          setShowScrollBottomBtn(false)
        } else {
          // Still in history
          stickRef.current = false
          setShowScrollBottomBtn(true)
        }
      }
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // New / changed messages.
  useEffect(() => {
    scrollToBottom(false)
    const vp = viewportRef.current
    if (vp && vp.scrollHeight - vp.clientHeight <= AT_BOTTOM_THRESHOLD_PX) {
      stickRef.current = true
      setShowScrollBottomBtn(false)
    }
  }, [children, scrollToBottom])

  // Late content growth (images decoding, syntax highlighting, font swap, tool expansions).
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) {
        scrollToBottom(false)
      }
      const vp = viewportRef.current
      if (vp && vp.scrollHeight - vp.clientHeight <= AT_BOTTOM_THRESHOLD_PX) {
        stickRef.current = true
        setShowScrollBottomBtn(false)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollToBottom])

  const handleManualScrollToBottom = () => {
    stickRef.current = true
    setShowScrollBottomBtn(false)
    const el = viewportRef.current
    if (!el) return
    isProgrammaticScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setTimeout(() => {
      isProgrammaticScrollRef.current = false
      if (viewportRef.current) {
        lastScrollTopRef.current = viewportRef.current.scrollTop
      }
    }, 400)
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
      <div
        ref={viewportRef}
        className={cn('flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 [scrollbar-gutter:stable_both-edges] [scroll-behavior:auto]', className)}
      >
        <div
          ref={contentRef}
          className="message-list max-w-3xl mx-auto space-y-4 w-full overflow-hidden"
        >
          {children}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Floating 'Scroll to Bottom' pill when user has scrolled up */}
      {showScrollBottomBtn && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-200">
          <button
            type="button"
            onClick={handleManualScrollToBottom}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-card/90 dark:bg-card/85 text-foreground shadow-lg border border-border/60 hover:bg-muted/90 backdrop-blur-xl transition-all cursor-pointer select-none group ring-1 ring-black/[0.04] dark:ring-white/[0.08]"
          >
            <ArrowDown size={13} className="text-primary group-hover:translate-y-0.5 transition-transform" />
            <span>回到底部</span>
          </button>
        </div>
      )}
    </div>
  )
}

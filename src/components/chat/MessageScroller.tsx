import React, { useEffect, useRef, useCallback } from 'react'
import { cn } from '../ui/button'

const STICK_THRESHOLD_PX = 24 // Tight threshold: only engage when within 24px of bottom

interface ScrollerProps {
  children: React.ReactNode
  forceScrollKey?: any
  className?: string
}

export const MessageScroller: React.FC<ScrollerProps> = ({ children, forceScrollKey, className }) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const scrollToBottom = useCallback((force = false) => {
    if (!force && !stickRef.current) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Explicit user send: force jump to bottom
  const lastForceScrollRef = useRef(forceScrollKey)
  useEffect(() => {
    if (forceScrollKey !== undefined && forceScrollKey !== null && forceScrollKey !== lastForceScrollRef.current) {
      lastForceScrollRef.current = forceScrollKey
      stickRef.current = true
      scrollToBottom(true)
    }
  }, [forceScrollKey, scrollToBottom])

  // Wheel & Scroll Listeners: NEVER fight user scrolling up
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User rolling UP: IMMEDIATELY disengage stickiness
        stickRef.current = false
      } else if (e.deltaY > 0) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance <= STICK_THRESHOLD_PX) stickRef.current = true
      }
    }

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickRef.current = distance <= STICK_THRESHOLD_PX
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // Content growth during streaming (respects stickRef)
  useEffect(() => {
    scrollToBottom(false)
  }, [children, scrollToBottom])

  return (
    <div
      ref={viewportRef}
      className={cn(
        'flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges] w-full',
        className,
      )}
    >
      <div className="max-w-3xl mx-auto space-y-4 w-full px-4 py-4">{children}</div>
    </div>
  )
}

export default MessageScroller

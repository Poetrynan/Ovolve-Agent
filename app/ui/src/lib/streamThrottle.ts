/**
 * IDE-style dual-threshold stream throttle.
 * Flush when EITHER the time window (≈60fps) OR char budget is met.
 */
export type StreamThrottleFlush = (text: string) => void

export interface StreamThrottleOptions {
  ms?: number
  chars?: number
}

export class StreamThrottle {
  private readonly ms: number
  private readonly chars: number
  private readonly onFlush: StreamThrottleFlush
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private raf: number | null = null
  private lastFlush = 0

  constructor(onFlush: StreamThrottleFlush, opts: StreamThrottleOptions = {}) {
    this.ms = opts.ms ?? 16
    this.chars = opts.chars ?? 32
    this.onFlush = onFlush
  }

  push(piece: string) {
    if (!piece) return
    this.buffer += piece
    if (this.buffer.length >= this.chars) {
      this.flushNow()
      return
    }
    this.schedule()
  }

  drain() {
    this.cancelScheduled()
    if (this.buffer) {
      const text = this.buffer
      this.buffer = ''
      this.lastFlush = performance.now()
      this.onFlush(text)
    }
  }

  reset() {
    this.cancelScheduled()
    this.buffer = ''
  }

  private schedule() {
    if (this.timer || this.raf) return
    const elapsed = performance.now() - this.lastFlush
    const wait = Math.max(0, this.ms - elapsed)
    if (wait <= 1) {
      this.raf = requestAnimationFrame(() => {
        this.raf = null
        this.flushNow()
      })
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushNow()
    }, wait)
  }

  private flushNow() {
    this.cancelScheduled()
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.lastFlush = performance.now()
    this.onFlush(text)
  }

  private cancelScheduled() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }
}

let activeThrottle: StreamThrottle | null = null

export function ensureStreamThrottle(flush: StreamThrottleFlush): StreamThrottle {
  if (!activeThrottle) {
    activeThrottle = new StreamThrottle(flush)
  }
  return activeThrottle
}

export function resetStreamThrottle() {
  activeThrottle?.reset()
  activeThrottle = null
}

export function drainStreamThrottle() {
  activeThrottle?.drain()
}

export function pushStreamDelta(piece: string, flush: StreamThrottleFlush) {
  ensureStreamThrottle(flush).push(piece)
}

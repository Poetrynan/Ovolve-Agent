export type SteerMode = 'queue_next' | 'interrupt_immediate' | 'cancel_and_replace'

export interface QueuedMessage {
  id: string
  content: string
  priority: 'normal' | 'high' | 'steer'
  timestamp: number
  steerMode?: SteerMode
}

export class MessageQueueManager {
  private queue: QueuedMessage[] = []
  private activeMessageId: string | null = null
  private abortController: AbortController | null = null
  private isProcessing = false

  /**
   * Enqueue a standard message (FIFO)
   */
  public enqueue(content: string, priority: 'normal' | 'high' = 'normal'): QueuedMessage {
    const msg: QueuedMessage = {
      id: `qmsg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      priority,
      timestamp: Date.now(),
      steerMode: priority === 'high' ? 'queue_next' : undefined,
    }

    if (priority === 'high') {
      // Put at front of queue behind any ongoing turn
      const firstNormalIdx = this.queue.findIndex((m) => m.priority === 'normal')
      if (firstNormalIdx !== -1) {
        this.queue.splice(firstNormalIdx, 0, msg)
      } else {
        this.queue.push(msg)
      }
    } else {
      this.queue.push(msg)
    }

    return msg
  }

  /**
   * Steer / Interruption (紧急插队与实时打断)
   */
  public steerImmediate(content: string, mode: SteerMode = 'interrupt_immediate'): QueuedMessage {
    const msg: QueuedMessage = {
      id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      priority: 'steer',
      timestamp: Date.now(),
      steerMode: mode,
    }

    if (mode === 'interrupt_immediate' || mode === 'cancel_and_replace') {
      // Interrupt current streaming turn
      this.abortCurrentTurn()
    }

    if (mode === 'cancel_and_replace') {
      // Clear remaining queue and replace with this urgent steer
      this.queue = [msg]
    } else {
      // Put at the very front of the queue
      this.queue.unshift(msg)
    }

    return msg
  }

  public getNextMessage(): QueuedMessage | null {
    return this.queue.shift() || null
  }

  public peekQueue(): QueuedMessage[] {
    return [...this.queue]
  }

  public getQueueLength(): number {
    return this.queue.length
  }

  public createTurnAbortController(): AbortController {
    this.abortController = new AbortController()
    return this.abortController
  }

  public abortCurrentTurn(): boolean {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort()
      this.abortController = null
      return true
    }
    return false
  }

  public clearQueue(): void {
    this.queue = []
  }
}

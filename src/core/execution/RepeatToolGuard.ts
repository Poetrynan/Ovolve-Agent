/**
 * RepeatToolGuard.ts — Loop Detector with MD5 Fingerprinting & Advisory Context
 *
 * Responsibilities:
 * 1. Monitor tool execution fingerprints in real-time within the AgentLoop.
 * 2. Detect deadlock loops where the agent repeatedly runs identical or near-identical tool calls.
 * 3. Generate Chinese advisory guidance prompts to help the agent break out of local optima.
 * 4. Emit structured failure signatures (`repeat_loop:{tool_name}:{fingerprint}`) for GEPA self-evolution.
 */

import crypto from 'node:crypto'

export interface ToolCallEntry {
  toolName: string
  argsFingerprint: string
  argsSummary: string
  timestamp: number
  outcomeOk: boolean
  outcomeLength: number
}

export interface LoopAlert {
  detected: boolean
  toolName: string
  repeatCount: number
  argsSummary?: string
  advisoryMessage: string
  failureSignature: string
}

/**
 * Normalizes tool arguments and computes an MD5 hash fingerprint.
 * Strips volatile/ephemeral fields and normalizes whitespace and object key orders.
 */
export function normalizeArgsFingerprint(argsOrToolName: any, optionalArgs?: any): string {
  let toolName = ''
  let args: any = argsOrToolName

  if (typeof argsOrToolName === 'string' && optionalArgs !== undefined) {
    toolName = argsOrToolName
    args = optionalArgs
  } else if (typeof argsOrToolName === 'object' && argsOrToolName !== null && optionalArgs === undefined) {
    args = argsOrToolName
  }

  if (!args || typeof args !== 'object') {
    const raw = String(args || '')
    const hash = crypto.createHash('md5').update(raw).digest('hex').slice(0, 12)
    return toolName ? `${toolName}:${hash}` : hash
  }

  const cleanObj: Record<string, any> = {}
  const ignoredKeys = new Set([
    'session_id',
    'sessionId',
    'timestamp',
    'request_id',
    'requestId',
    'call_id',
    'callId',
    'toolSummary',
    'toolAction',
  ])

  function sanitizeValue(val: any): any {
    if (val === null || val === undefined) return val
    if (typeof val === 'string') {
      return val.trim().replace(/\s+/g, ' ')
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      return val
    }
    if (Array.isArray(val)) {
      return val.map(sanitizeValue)
    }
    if (typeof val === 'object') {
      const sortedSub: Record<string, any> = {}
      for (const k of Object.keys(val).sort()) {
        if (!ignoredKeys.has(k) && !k.startsWith('_')) {
          sortedSub[k] = sanitizeValue(val[k])
        }
      }
      return sortedSub
    }
    return String(val)
  }

  for (const k of Object.keys(args).sort()) {
    if (!ignoredKeys.has(k) && !k.startsWith('_')) {
      cleanObj[k] = sanitizeValue(args[k])
    }
  }

  const serialized = JSON.stringify(cleanObj)
  const hash = crypto.createHash('md5').update(`${toolName ? toolName + ':' : ''}${serialized}`).digest('hex').slice(0, 12)
  return toolName ? `${toolName}:${hash}` : hash
}

export class RepeatToolGuard {
  private maxWindowSize: number
  private repeatThreshold: number
  private history: ToolCallEntry[] = []
  private alertedFingerprints = new Set<string>()

  constructor(maxWindowSize = 10, repeatThreshold = 3) {
    this.maxWindowSize = maxWindowSize
    this.repeatThreshold = repeatThreshold
  }

  public recordCall(
    toolName: string,
    args: any,
    outcomeOk = true,
    outcomeContent: string | any = ''
  ): void {
    const fp = normalizeArgsFingerprint(toolName, args)
    const summary = typeof args === 'object' ? JSON.stringify(args).slice(0, 100) : String(args).slice(0, 100)

    const entry: ToolCallEntry = {
      toolName,
      argsFingerprint: fp,
      argsSummary: summary,
      timestamp: Date.now(),
      outcomeOk,
      outcomeLength: typeof outcomeContent === 'string' ? outcomeContent.length : JSON.stringify(outcomeContent || '').length,
    }

    this.history.push(entry)
    if (this.history.length > this.maxWindowSize) {
      this.history.shift()
    }
  }

  public checkLoop(): LoopAlert | null {
    if (this.history.length < this.repeatThreshold) {
      return null
    }

    // Check tail consecutive repeat
    const tail = this.history.slice(-this.repeatThreshold)
    const targetTool = tail[0].toolName
    const targetFp = tail[0].argsFingerprint

    const isExactRepeat = tail.every(
      (e) => e.toolName === targetTool && e.argsFingerprint === targetFp
    )

    // Check frequency count in sliding window
    const count = this.history.filter(
      (e) => e.toolName === targetTool && e.argsFingerprint === targetFp
    ).length

    if ((isExactRepeat || count >= this.repeatThreshold) && !this.alertedFingerprints.has(targetFp)) {
      this.alertedFingerprints.add(targetFp)
      const lastSummary = tail[tail.length - 1].argsSummary

      return {
        detected: true,
        toolName: targetTool,
        repeatCount: count,
        argsSummary: lastSummary,
        advisoryMessage: `【系统防死循环守卫提示】: 你已连续 ${count} 次执行类似的 \`${targetTool}\` 操作且未取得新突破。请停止重复盲试！请尝试：1) 更换排查关键词或检索策略；2) 查看目录树或文件结构；3) 向用户澄清或说明当前困境。`,
        failureSignature: `repeat_loop:${targetFp.startsWith(targetTool + ':') ? targetFp : `${targetTool}:${targetFp}`}`,
      }
    }

    return null
  }

  public getHistory(): ToolCallEntry[] {
    return [...this.history]
  }

  public reset(): void {
    this.history = []
    this.alertedFingerprints.clear()
  }
}

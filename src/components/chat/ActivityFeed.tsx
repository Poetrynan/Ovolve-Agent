import React, { useState, useEffect } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Terminal,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldAlert,
  Code,
  Search,
  ExternalLink,
} from 'lucide-react'
import type { ToolCall } from '../../types/agent'
import { CodeDiffView } from './CodeDiffView'
// 截图反馈面板：CUA/浏览器动作的截图内嵌显示。
import { ScreenshotFeedbackPanel } from './ScreenshotFeedbackCard'
import { extractScreenshotRefs } from '../../lib/screenshotFeedback'
import { AskUserPanel } from './AskUserPanel'
import { useAgentStore } from '../../store/agentStore'
import { cn } from '../ui/button'
// 确认卡场景化分流：组件只消费结论。
import { confirmCardMode } from '../../lib/confirmationScenario'
// 认领失败卡（U3 指认闭环）：fail-closed 认领
// 被拒时按协议原文渲染「旧快照 → 新现状」对照 + 一键重新指认。
import { ClaimFailureCard } from './ClaimFailureCard'
import { claimFailureFromToolCall, parseTabTargetRef } from '../../lib/claimRef'

interface ActivityFeedProps {
  reasoning?: string
  reasoningDuration?: number
  isThinking?: boolean
  toolCalls?: ToolCall[]
  onApproveTool?: (id: string) => void
  onRejectTool?: (id: string, feedback?: string) => void
}

/** 4Hz live stopwatch timer badge during live execution */
export const LiveTimerBadge: React.FC<{ startTime: number; isLive: boolean; durationMs?: number }> = ({
  startTime,
  isLive,
  durationMs,
}) => {
  const [elapsed, setElapsed] = useState<number>(durationMs || 0)

  useEffect(() => {
    if (!isLive) {
      if (durationMs !== undefined) setElapsed(durationMs)
      return
    }
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 250) // 4Hz
    return () => clearInterval(interval)
  }, [startTime, isLive, durationMs])

  const seconds = (elapsed / 1000).toFixed(1)

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-md bg-primary/10 text-primary border border-primary/20 font-mono text-[10px] font-semibold">
      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
      <span>{seconds}s</span>
    </span>
  )
}

/** ANSI color to HTML span renderer for terminal outputs */
function renderAnsiOutput(text: string) {
  // Strip or basic colorize common ANSI escape sequences
  const clean = text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
  return clean
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  reasoning,
  reasoningDuration,
  isThinking = false,
  toolCalls = [],
  onApproveTool,
  onRejectTool,
}) => {
  const [thoughtExpanded, setThoughtExpanded] = useState(isThinking)
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})

  const respondToToolApproval = useAgentStore((s) => s.respondToToolApproval)

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const handleApprove = (id: string) => {
    if (onApproveTool) onApproveTool(id)
    else respondToToolApproval(id, true)
  }

  const handleReject = (id: string, reason?: string) => {
    if (onRejectTool) onRejectTool(id, reason)
    else respondToToolApproval(id, false, reason)
  }

  if (!reasoning && (!toolCalls || toolCalls.length === 0)) return null

  return (
    <div className="space-y-2.5 my-2">
      {/* 1. Reasoning / Thought Stream Block */}
      {reasoning && (
        <div className="rounded-xl border border-border/80 dark:border-white/10 bg-card/60 dark:bg-white/[0.02] backdrop-blur-md overflow-hidden text-xs transition-all">
          <button
            type="button"
            onClick={() => setThoughtExpanded(!thoughtExpanded)}
            className="w-full flex items-center justify-between px-3 py-2 bg-muted/30 dark:bg-white/[0.02] hover:bg-muted/60 transition-colors text-left select-none cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Sparkles size={13} className="text-primary shrink-0 animate-pulse" />
              <span className="font-semibold text-foreground/90">
                {isThinking ? 'Reasoning in progress...' : 'Thought Process'}
              </span>
              <LiveTimerBadge
                startTime={Date.now() - (reasoningDuration || 1000)}
                isLive={isThinking}
                durationMs={reasoningDuration}
              />
            </div>
            <div className="text-muted-foreground">
              {thoughtExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          </button>

          {thoughtExpanded && (
            <div className="p-3.5 text-xs text-muted-foreground/90 font-mono leading-relaxed whitespace-pre-wrap border-t border-border/60 dark:border-white/5 bg-black/10 max-h-80 overflow-y-auto">
              {reasoning}
            </div>
          )}
        </div>
      )}

      {/* 2. Tool Execution Timeline */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="space-y-2">
          {toolCalls.map((tc) => {
            const isExpanded = expandedTools[tc.id] ?? (tc.status === 'running' || tc.status === 'needs_confirmation' || tc.status === 'needs_input')
            const mode = confirmCardMode(tc)

            // Handoff 接管卡 / 审批卡（场景语义字段由 WS tool_result meta 透传，
            // 旧帧不带 → 与现状渲染一致）。
            if (mode !== 'plain') {
              return (
                <AskUserPanel
                  key={tc.id}
                  title={mode === 'takeover' ? '此操作需要你亲自执行' : `Approval Required: ${tc.tool}`}
                  description={JSON.stringify(tc.args)}
                  tool={tc.tool}
                  confirmReason={tc.confirmReason}
                  scenarioTags={tc.scenarioTags}
                  allowAlways={tc.allowAlways}
                  handoff={tc.handoff}
                  onAlways={mode === 'approval' ? () => respondToToolApproval(tc.id, true, '以后都允许') : undefined}
                  onApprove={() => handleApprove(tc.id)}
                  onReject={() => handleReject(tc.id, 'User rejected')}
                />
              )
            }

            // Check if tool output contains code diff
            const isDiff =
              tc.tool === 'fast_replace' ||
              tc.tool === 'replace_file_content' ||
              Boolean(tc.args?.old_content || tc.args?.target_content)

            return (
              <div
                key={tc.id}
                className="rounded-xl border border-border/80 dark:border-white/10 bg-card/70 dark:bg-card/40 backdrop-blur-xl shadow-2xs overflow-hidden text-xs"
              >
                {/* Tool Header */}
                <div
                  onClick={() => toggleTool(tc.id)}
                  className="flex items-center justify-between px-3 py-2 bg-muted/40 dark:bg-white/[0.03] hover:bg-muted/70 transition-colors cursor-pointer select-none"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {tc.status === 'running' && <Loader2 size={13} className="text-primary animate-spin shrink-0" />}
                    {tc.status === 'done' && <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />}
                    {tc.status === 'failed' && <XCircle size={13} className="text-rose-500 shrink-0" />}

                    <span className="font-mono font-semibold text-foreground/90">{tc.tool}</span>

                    {/* Tool Target Arg preview */}
                    {tc.args && (
                      <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[240px]">
                        {tc.args.TargetFile || tc.args.path || tc.args.CommandLine || tc.args.query || ''}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-muted-foreground">
                    <LiveTimerBadge
                      startTime={tc.startTime}
                      isLive={tc.status === 'running'}
                      durationMs={tc.endTime ? tc.endTime - tc.startTime : undefined}
                    />
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                </div>

                {/* Screenshot feedback: CUA/browser captures embedded under the tool header */}
                {(() => {
                  const shots = extractScreenshotRefs({ toolName: tc.tool, result: tc.output, output: tc.output })
                  return shots.length > 0 ? <ScreenshotFeedbackPanel refs={shots} tool={tc.tool} /> : null
                })()}

                {/* Claim failure card（U3 认领闭环）: fail-closed 认领被拒的固定文案
                    命中时渲染对照卡。taskId/objectId 只从调用参数 target_ref 解析，
                    解析不出交给卡片降级为"复制引用信息"——绝不编造会话号。
                    不含认领失败文本的输出在此返回 null，渲染与现状逐字节一致。 */}
                {(() => {
                  const fail = claimFailureFromToolCall({ output: tc.output, result: tc.error })
                  if (!fail) return null
                  const ref = parseTabTargetRef(tc.args?.target_ref)
                  return (
                    <ClaimFailureCard
                      fail={fail}
                      taskId={ref?.taskId ?? null}
                      objectId={ref?.objectId ?? fail.objectId ?? null}
                    />
                  )
                })()}

                {/* Tool Details / Output */}
                {isExpanded && (
                  <div className="p-3 border-t border-border/60 dark:border-white/5 space-y-2 bg-black/5">
                    {/* Args block */}
                    {tc.args && Object.keys(tc.args).length > 0 && (
                      <div className="rounded-lg bg-background/80 dark:bg-black/30 p-2 border border-border/50 dark:border-white/5 font-mono text-[11px] text-muted-foreground overflow-x-auto">
                        <span className="text-[10px] text-primary/80 uppercase block mb-0.5">Parameters:</span>
                        <pre className="whitespace-pre-wrap">{JSON.stringify(tc.args, null, 2)}</pre>
                      </div>
                    )}

                    {/* Diff view if replace */}
                    {isDiff && tc.args && (
                      <CodeDiffView
                        filename={tc.args.TargetFile || tc.args.path || 'diff'}
                        oldCode={tc.args.TargetContent || tc.args.old_content || ''}
                        newCode={tc.args.ReplacementContent || tc.args.new_content || ''}
                      />
                    )}

                    {/* Output block */}
                    {tc.output && !isDiff && (
                      <div className="rounded-lg bg-background/80 dark:bg-black/40 p-2.5 border border-border/50 dark:border-white/5 font-mono text-[11px] text-foreground/90 overflow-x-auto max-h-60">
                        <span className="text-[10px] text-emerald-500 uppercase block mb-0.5 font-bold">Output:</span>
                        <pre className="whitespace-pre-wrap leading-relaxed">{renderAnsiOutput(tc.output)}</pre>
                      </div>
                    )}

                    {/* Error block */}
                    {tc.error && (
                      <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-2.5 font-mono text-[11px] text-rose-500">
                        <span className="text-[10px] font-bold uppercase block mb-0.5">Error:</span>
                        <div>{tc.error}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ActivityFeed

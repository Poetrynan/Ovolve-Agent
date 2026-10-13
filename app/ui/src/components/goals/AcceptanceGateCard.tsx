// src/components/goals/AcceptanceGateCard.tsx
// Machine Verification Gate & Anti-Early-Quit Acceptance Checklist Card
import { useState } from 'react'
import {
  ShieldCheck,
  ShieldAlert,
  FileCheck2,
  Terminal,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface VerificationPlanItem {
  type: string
  path?: string
  command?: string
  expect_exit?: number
  contains?: string
  status?: 'passed' | 'failed' | 'running' | 'pending'
}

export interface AcceptanceContractData {
  goal_id?: string
  summary?: string
  required_artifacts?: string[]
  verification_plan?: VerificationPlanItem[]
  passed?: boolean
  unmet?: string[]
}

interface AcceptanceGateCardProps {
  contract: AcceptanceContractData
  isVerifying?: boolean
  className?: string
}

export function AcceptanceGateCard({ contract, isVerifying = false, className }: AcceptanceGateCardProps) {
  const [expanded, setExpanded] = useState(true)

  const artifacts = contract.required_artifacts || []
  const plans = contract.verification_plan || []
  const unmet = contract.unmet || []
  const allPassed = contract.passed === true

  const totalChecks = artifacts.length + plans.length
  const failedCount = unmet.length
  const isAntiEarlyQuitActive = !allPassed && totalChecks > 0

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border transition-all duration-300',
        allPassed
          ? 'border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10'
          : isAntiEarlyQuitActive
          ? 'border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10'
          : 'border-border/60 bg-card/60',
        'backdrop-blur-xl shadow-sm text-xs',
        className,
      )}
    >
      {/* Header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between gap-2 px-3.5 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-bold',
              allPassed
                ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
            )}
          >
            {isVerifying ? (
              <Loader2 size={12} className="animate-spin" />
            ) : allPassed ? (
              <ShieldCheck size={12} />
            ) : (
              <ShieldAlert size={12} />
            )}
          </div>
          <span className="font-semibold tracking-wide text-[11px] uppercase">
            机器验收契约门禁 (Acceptance Gate)
          </span>
          {isAntiEarlyQuitActive && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20">
              <Lock size={9} />
              防早退保护生效中
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {allPassed ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 size={11} />
              全绿放行
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              {failedCount > 0 ? `待自愈 (${failedCount} 项未达标)` : '机器检验中'}
            </span>
          )}
          {expanded ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded Checklist */}
      {expanded && (
        <div className="px-3.5 pb-3 pt-1 border-t border-border/40 space-y-2.5 text-[11px] animate-fade-in">
          {/* Deliverable Artifacts */}
          {artifacts.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-muted-foreground font-medium text-[10.5px]">
                <FileCheck2 size={12} />
                <span>必交付产物清单 ({artifacts.length})</span>
              </div>
              <div className="space-y-1 pl-4">
                {artifacts.map((art, idx) => {
                  const isMissing = unmet.some((u) => u.includes(art))
                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1 rounded-lg border font-mono text-[10.5px]',
                        isMissing
                          ? 'border-destructive/30 bg-destructive/10 text-destructive'
                          : 'border-border/40 bg-muted/20 text-foreground/90',
                      )}
                    >
                      {isMissing ? <XCircle size={12} /> : <CheckCircle2 size={12} className="text-emerald-500" />}
                      <span className="truncate flex-1">{art}</span>
                      <span className="text-[9.5px] opacity-70">
                        {isMissing ? '缺失 - 拦截结项' : '已就绪'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Verification Plan */}
          {plans.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-muted-foreground font-medium text-[10.5px]">
                <Terminal size={12} />
                <span>自动化测试与指令计划 ({plans.length})</span>
              </div>
              <div className="space-y-1 pl-4">
                {plans.map((p, idx) => {
                  const label = p.command || p.path || p.type
                  const isFailed = unmet.some((u) => u.includes(label) || (p.command && u.includes(p.command)))
                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1 rounded-lg border font-mono text-[10.5px]',
                        isFailed
                          ? 'border-destructive/30 bg-destructive/10 text-destructive'
                          : 'border-border/40 bg-muted/20 text-foreground/90',
                      )}
                    >
                      {isFailed ? (
                        <RotateCcw size={12} className="animate-spin shrink-0 text-amber-500" />
                      ) : (
                        <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                      )}
                      <span className="truncate flex-1">
                        {p.command ? `$ ${p.command}` : p.path ? `file: ${p.path}` : p.type}
                      </span>
                      <span className="text-[9.5px] opacity-70 shrink-0">
                        {isFailed ? '退出码非0 · 正在修复' : '测试通过 (0报错)'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Anti Early Quit Reassurance Banner */}
          {isAntiEarlyQuitActive && (
            <div className="flex items-start gap-2 p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-[10.5px] leading-relaxed">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">客观门禁守卫：</span>
                当前仍有验收条件未通过，系统已刚性阻止模型提前宣称完成（Anti-Early-Quit），正驱动下一轮自动修复与回归测试。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

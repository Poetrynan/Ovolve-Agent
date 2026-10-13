// src/components/chat/ModelSelector.tsx
// Clean model selector displaying provider-grouped models with vision/reasoning badges and overflow protection.
// Thinking level is managed exclusively by the adjacent ThoughtLevelSelector.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Cpu, ChevronDown, Check, Eye, Brain, AlertCircle, AlertTriangle, FoldVertical, Settings
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'
import { ModelProviderLogo } from '@/components/common/BrandIcons'
import { useModelStore } from '@store/modelStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { useContextUsageStore } from '@store/contextUsageStore'
import { useAgentStore } from '@store/agentStore'
import { cn } from '@/lib/utils'

function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

const OUTPUT_HEADROOM = 0.9

export function ModelSelector() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers, loadProviders, enabledModels } = useModelStore()
  const { activeModel, setActiveModel } = useSessionConfigStore()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const currentTokens = useContextUsageStore((s) => s.usage.currentTokens)
  const send = useAgentStore((s) => s.send)

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models = useMemo(() => enabledModels(), [providers, enabledModels])

  const [activeProviderId, activeModelId] = activeModel ? activeModel.split(':') : ['', '']
  const activeProvider = providers[activeProviderId]
  const activeModelDef = activeProvider?.models?.[activeModelId]

  const activeLabel = models.length === 0
    ? t('modelSelector.noModel', '未配置模型')
    : (activeModelDef?.name ?? activeModelId ?? t('modelSelector.pick', '选择模型'))

  const overflows = (value: string): boolean => {
    if (!value.includes(':')) return false
    const [pid, mid] = value.split(':')
    const ctx = providers[pid]?.models?.[mid]?.limit?.context
    if (!ctx || !currentTokens) return false
    return currentTokens > ctx * OUTPUT_HEADROOM
  }

  const pick = (value: string) => {
    if (overflows(value)) {
      setPending(value)
      return
    }
    setActiveModel(value)
    setOpen(false)
  }

  const confirmPending = (foldFirst: boolean) => {
    if (!pending) return
    if (foldFirst) send('fold')
    setActiveModel(pending)
    setPending(null)
    setOpen(false)
  }

  const grouped = useMemo(() => {
    const map = new Map<string, typeof models>()
    for (const m of models) {
      const arr = map.get(m.providerId) ?? []
      arr.push(m)
      map.set(m.providerId, arr)
    }
    return map
  }, [models])

  const pendingDef = useMemo(() => {
    if (!pending || !pending.includes(':')) return null
    const [pid, mid] = pending.split(':')
    const def = providers[pid]?.models?.[mid]
    return def ? { name: def.name ?? mid, ctx: def.limit?.context ?? 0 } : null
  }, [pending, providers])

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setPending(null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          data-testid="chat-model-select-trigger"
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-xl text-xs font-medium transition-all press-feedback max-w-[200px]',
            models.length === 0
              ? 'text-warning hover:bg-warning/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
          )}
          title={activeLabel}
        >
          {activeProviderId && models.length > 0 ? (
            <ModelProviderLogo providerId={activeProviderId} size={13} />
          ) : (
            <Cpu size={13} className={models.length === 0 ? 'text-warning shrink-0' : 'text-primary/70 shrink-0'} />
          )}
          <span className="truncate">{activeLabel}</span>
          <ChevronDown size={11} className="opacity-50 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[260px] p-1.5 shadow-2xl rounded-2xl border border-border/60 bg-popover/90 backdrop-blur-2xl max-h-[360px] overflow-y-auto"
        data-testid="chat-model-select-group"
      >
        {models.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
            <AlertCircle size={22} className="text-warning" />
            <div className="text-xs font-semibold text-foreground">{t('modelSelector.empty', '暂无可用模型')}</div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t('modelSelector.emptyHint', '尚未检测到配置的 API Key。请在设置中添加供应商密钥后即可在此选择。')}
            </p>
            <button
              onClick={() => {
                setOpen(false)
                navigate('/settings/models')
              }}
              className="mt-1.5 px-3 py-1 rounded-md text-xs font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors press-feedback"
            >
              {t('modelSelector.goConfig', '前往配置')}
            </button>
          </div>
        ) : pending && pendingDef ? (
          /* Overflow guard */
          <div className="p-2 space-y-2">
            <div className="flex items-start gap-2 px-1 pt-1">
              <AlertTriangle size={15} className="text-warning shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed text-foreground">
                {t('modelSelector.guardTitle', '上下文可能放不下')}
                <p className="text-muted-foreground mt-1">
                  {t('modelSelector.guardBody', '当前对话约 {{used}} tokens，接近 {{name}} 的 {{ctx}} 窗口。建议先折叠上下文再切换。', {
                    used: currentTokens >= 1000 ? `${(currentTokens / 1000).toFixed(1)}k` : String(currentTokens),
                    name: pendingDef.name,
                    ctx: fmtContext(pendingDef.ctx),
                  })}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => confirmPending(true)}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors press-feedback"
              >
                <FoldVertical size={12} />
                {t('modelSelector.foldAndSwitch', '先折叠并切换')}
              </button>
              <button
                onClick={() => confirmPending(false)}
                className="w-full px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {t('modelSelector.switchAnyway', '仍要直接切换')}
              </button>
              <button
                onClick={() => setPending(null)}
                className="w-full px-2 py-1 rounded-md text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
              >
                {t('common.cancel', '取消')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {Array.from(grouped.entries()).map(([pid, list]) => (
              <div key={pid} className="mb-1">
                {grouped.size > 1 && (
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    <ModelProviderLogo providerId={pid} size={11} />
                    <span>{providers[pid]?.name ?? pid}</span>
                  </div>
                )}
                <div className="space-y-0.5">
                  {list.map(({ modelId, model }) => {
                    const value = `${pid}:${modelId}`
                    const active = activeModel === value
                    const hasVision = model.modalities?.input?.includes('image')
                    const hasReasoning = !!model.reasoning?.enabled
                    const ctx = model.limit?.context
                    const tight = overflows(value)
                    return (
                      <button
                        key={value}
                        data-testid="chat-model-select-item"
                        onClick={() => pick(value)}
                        className={cn(
                          'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer',
                          active ? 'bg-muted text-foreground font-semibold' : 'hover:bg-accent text-foreground',
                        )}
                      >
                        <span className="flex-1 min-w-0 text-xs truncate">
                          {model.name ?? modelId}
                        </span>
                        {ctx && (
                          <span className="text-[10px] px-1 py-0.2 rounded bg-muted text-muted-foreground font-mono shrink-0">
                            {fmtContext(ctx)}
                          </span>
                        )}
                        {hasVision && <span title="支持视觉输入" className="inline-flex"><Eye size={11} className="shrink-0 text-muted-foreground" /></span>}
                        {hasReasoning && <span title="支持深度思考" className="inline-flex"><Brain size={11} className="shrink-0 text-indigo-500" /></span>}
                        {tight && <span title="上下文可能偏紧" className="inline-flex"><AlertTriangle size={11} className="text-warning shrink-0" /></span>}
                        {active && <Check size={13} className="shrink-0 text-foreground ml-0.5" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            <div className="h-px bg-border/40 my-1" />

            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate('/settings/models')
              }}
              className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
            >
              <Settings size={12} className="shrink-0" />
              <span>{t('modelSelector.manageModels', '管理服务商与密钥...')}</span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

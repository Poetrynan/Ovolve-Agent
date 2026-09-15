/**
 * SubagentsPanel — the 子 Agent tab of the Capabilities page.
 *
 * Read-only on purpose. The single source of truth is
 * `app/backend/subagent_registry.py`: four built-in presets merged with any
 * YAML dropped into `app/backend/subagents/`, user definitions winning on name
 * collision.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Lock, PencilLine, Wrench, Cpu, RotateCw, ArrowRightLeft } from 'lucide-react'
import { useSubagentStore, isWriteCapable, type SubagentType } from '@store/subagentStore'
import { useModelStore, type ProviderDef } from '@store/modelStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { Badge } from '@components/ui/badge'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@components/ui/select'
import { cn } from '@/lib/utils'
import { API_BASE, sendJson } from '@lib/api'

function Meta({ icon: Icon, children }: { icon: typeof Wrench; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
      <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground/80" />
      {children}
    </span>
  )
}

function economyForProvider(
  providerId: string,
  providers: Record<string, ProviderDef>,
): { composite: string; label: string } | null {
  const econId = providers[providerId]?.options?.economyModelId?.trim()
  if (!econId) return null
  const name = providers[providerId]?.models?.[econId]?.name || econId
  return { composite: `${providerId}:${econId}`, label: name }
}

function SubagentCard({ def }: { def: SubagentType }) {
  const { t } = useTranslation()
  const writes = isWriteCapable(def)
  const handoffs = def.handoffs ?? []
  const { enabledModels, providers } = useModelStore()
  const { activeModel: parentModel } = useSessionConfigStore()
  const [model, setModel] = useState<string>(def.model ?? '')
  const [modelPolicy, setModelPolicy] = useState<'main' | 'economy'>(def.modelPolicy ?? 'main')
  const [saving, setSaving] = useState(false)

  const models = useMemo(() => enabledModels(), [enabledModels])

  useEffect(() => {
    setModel(def.model ?? '')
    setModelPolicy(def.modelPolicy ?? 'main')
  }, [def.model, def.modelPolicy, def.name])

  const parentProviderId = parentModel?.includes(':') ? parentModel.split(':')[0] : null

  const parentLabel = useMemo(() => {
    if (!parentModel || !parentModel.includes(':')) return null
    const [pid, mid] = parentModel.split(':')
    const m = models.find((x) => x.providerId === pid && x.modelId === mid)
    return m ? (m.model?.name || m.modelId) : null
  }, [parentModel, models])

  const economyOption = useMemo(() => {
    if (!parentProviderId) return null
    return economyForProvider(parentProviderId, providers)
  }, [parentProviderId, providers])

  const selectValue = model
    ? model
    : modelPolicy === 'economy' && economyOption
      ? '__economy__'
      : '__main__'

  const [error, setError] = useState<string | null>(null)

  const onChangeModel = async (value: string) => {
    const prevModel = model
    const prevPolicy = modelPolicy
    let nextModel: string | null = null
    let nextPolicy: 'main' | 'economy' = 'main'
    if (value === '__main__') {
      nextModel = null
      nextPolicy = 'main'
    } else if (value === '__economy__') {
      nextModel = null
      nextPolicy = 'economy'
    } else {
      nextModel = value
      nextPolicy = 'main'
    }
    setModel(nextModel ?? '')
    setModelPolicy(nextPolicy)
    setError(null)
    setSaving(true)
    try {
      await sendJson(`${API_BASE}/api/subagents/types/${encodeURIComponent(def.name)}`, 'PATCH', {
        model: nextModel,
        model_policy: nextPolicy,
      })
    } catch (e) {
      setModel(prevModel)
      setModelPolicy(prevPolicy)
      setError(e instanceof Error ? e.message : '保存失败')
    }
    setSaving(false)
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md p-5 space-y-3.5 shadow-xs hover:shadow-md transition-all">
      <div className="flex items-start gap-3.5">
        <div className="w-10 h-10 rounded-xl bg-foreground/10 border border-border/40 flex items-center justify-center shrink-0 text-foreground shadow-2xs">
          <Bot className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-[15px] font-heading font-extrabold tracking-tight text-foreground truncate capitalize">
              {def.name}
            </h4>
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] font-bold px-2 py-0.5 rounded-lg border shadow-2xs gap-1 pointer-events-none',
                writes
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
              )}
            >
              {writes
                ? <><PencilLine className="w-3 h-3" />{t('capabilitiesPage.subagents.writeCapable')}</>
                : <><Lock className="w-3 h-3" />{t('capabilitiesPage.subagents.readOnly')}</>}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{def.description}</p>
        </div>
      </div>

      <div className="flex items-center gap-3.5 flex-wrap pt-1 border-t border-border/30">
        <Meta icon={Wrench}>
          {def.allowedTools === null
            ? t('capabilitiesPage.subagents.toolsAll')
            : t('capabilitiesPage.subagents.toolsCount', { n: def.allowedTools.length })}
        </Meta>

        {/* Per-persona model: follow main, follow economy (if configured), or explicit */}
        <label className="inline-flex items-center gap-1.5">
          <Cpu size={13} className="text-muted-foreground" />
          <Select value={selectValue} onValueChange={onChangeModel} disabled={saving}>
            <SelectTrigger className="w-52 h-8 text-xs rounded-xl border-border/50 bg-background/70 px-2.5 shadow-2xs">
              <SelectValue placeholder={t('capabilitiesPage.subagents.modelInherit')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__main__" className="text-xs">
                {t('capabilitiesPage.subagents.modelMain')}
                {parentLabel ? ` (${parentLabel})` : ''}
              </SelectItem>
              {economyOption && (
                <SelectItem value="__economy__" className="text-xs">
                  {t('capabilitiesPage.subagents.modelEconomy')} ({economyOption.label})
                </SelectItem>
              )}
              {models.length > 0 && <SelectSeparator />}
              {models.map((m) => (
                <SelectItem key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`} className="text-xs">
                  {m.model?.name || m.modelId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {error && (
          <span className="text-xs text-destructive font-medium">{error}</span>
        )}


        <span className="text-[11px] text-muted-foreground/70 font-mono">
          {def.permission}
        </span>
      </div>

      {handoffs.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap pt-1 text-xs">
          <ArrowRightLeft className="w-3.5 h-3.5 shrink-0 text-muted-foreground/70" />
          <span className="text-[11px] text-muted-foreground/80">
            {t('capabilitiesPage.subagents.handsOffTo')}
          </span>
          {handoffs.map((h) => (
            <span key={h} className="text-[11px] font-mono px-2 py-0.5 rounded-lg bg-muted/60 text-foreground/80 border border-border/40 font-medium">
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function SubagentsPanel() {
  const { t } = useTranslation()
  const { types, loading, fetchTypes } = useSubagentStore()
  const { loadProviders } = useModelStore()

  useEffect(() => {
    void fetchTypes()
    void loadProviders()
  }, [fetchTypes, loadProviders])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('capabilitiesPage.subagents.desc')}
        </p>
        <button
          type="button"
          onClick={() => void fetchTypes()}
          disabled={loading}
          className="p-1.5 rounded-lg border border-border/50 bg-card/60 hover:bg-card text-muted-foreground hover:text-foreground text-xs flex items-center gap-1.5 shrink-0 transition-colors shadow-2xs"
          title="Refresh"
        >
          <RotateCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          <span className="text-[11px] font-medium">刷新</span>
        </button>
      </div>


      {types.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/30 px-6 py-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mx-auto text-muted-foreground">
            <Bot className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-foreground">
            {t('capabilitiesPage.subagents.empty')}
          </h4>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            {t('capabilitiesPage.subagents.emptyHint')}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {types.map((def) => <SubagentCard key={def.name} def={def} />)}
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            {t('capabilitiesPage.subagents.howTo')}
          </p>
        </>
      )}
    </div>
  )
}

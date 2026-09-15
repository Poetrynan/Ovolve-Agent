// src/components/settings/ProviderSettings.tsx
// Minimalist & Typography-First AI Model Provider Registry
// Inspired by ZettleAgent: Clean cards (no clutter), focused editor (Base URL, API Key, Model ID, Save & Test)
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Check,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Star,
  ExternalLink,
  Trash2,
  Image as ImageIcon,
  Brain,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Switch } from '@components/ui/switch'
import { Badge } from '@components/ui/badge'
import { useModelStore, isPresetProvider } from '@store/modelStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { toast } from '@components/ui/sonner'
import { cn } from '@lib/utils'

type ProbeState = 'idle' | 'testing' | 'ok' | 'warn' | 'fail'

// A capability the user hasn't spoken about (`undefined`) must stay distinct
// from one they've explicitly turned off (`false`). That's the whole reason the
// backend keeps `supports_thinking` tri-state: "settings never opened" and
// "declared unsupported" produce DIFFERENT request bodies, so the control has
// to be able to represent "no opinion" as its own value, not fold it into off.
type TriState = boolean | undefined

/** token 数的紧凑显示：128000 → 128K。与聊天侧模型选择器的口径一致。 */
const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n))


/**
 * One capability declaration, as a 3-way segmented control: 自动 / 支持 / 不支持.
 *
 * Was a single chip that cycled 自动→支持→不支持 on click — you couldn't see the
 * other options, couldn't jump straight to one, and the label 「自动（不支持）」
 * read like a riddle. A segment group shows all three at once and the choice is
 * one tap. `undefined` (自动) stays a distinct state from `false` (不支持) because
 * the backend needs that difference; here it's just the leftmost segment.
 */
function CapabilityTri({
  label,
  hint,
  icon,
  value,
  inferred,
  onChange,
}: {
  label: string
  hint: string
  icon: ReactNode
  value: TriState
  inferred: string
  onChange: (v: TriState) => void
}) {
  const { t } = useTranslation()
  const opts: { v: TriState; text: string }[] = [
    { v: undefined, text: t('provider.cap.auto') },
    { v: true, text: t('provider.cap.on') },
    { v: false, text: t('provider.cap.off') },
  ]
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground leading-none">{label}</div>
          <div className="text-[10px] text-muted-foreground mt-1 truncate">{hint}</div>
        </div>
      </div>
      <div className="inline-flex shrink-0 rounded-lg border border-border/60 bg-background p-0.5">
        {opts.map((o) => {
          const active = value === o.v
          return (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => onChange(o.v)}
              title={o.v === undefined ? t('provider.cap.autoTitle', { inferred }) : undefined}
              className={cn(
                'px-2.5 h-6 rounded-md text-[11px] font-medium transition-colors',
                active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.text}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Direct Official API Key Links & Clean Descriptions
const PROVIDER_METAS: Record<
  string,
  {
    keyUrl?: string
    keyLabel?: string
    descriptionZh: string
    exampleModel: string
  }
> = {
  deepseek: {
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyLabel: 'provider.providers.deepseekKey',
    descriptionZh: 'provider.providers.deepseekDesc',
    exampleModel: 'deepseek-chat',
  },
  anthropic: {
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'provider.providers.anthropicKey',
    descriptionZh: 'provider.providers.anthropicDesc',
    exampleModel: 'claude-3-5-sonnet-20241022',
  },
  openai: {
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'provider.providers.openaiKey',
    descriptionZh: 'provider.providers.openaiDesc',
    exampleModel: 'gpt-4o',
  },
  gemini: {
    keyUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'provider.providers.googleKey',
    descriptionZh: 'provider.providers.googleDesc',
    exampleModel: 'gemini-2.0-flash',
  },
  siliconflow: {
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyLabel: 'provider.providers.siliconKey',
    descriptionZh: 'provider.providers.siliconDesc',
    exampleModel: 'deepseek-ai/DeepSeek-V3',
  },
  openrouter: {
    keyUrl: 'https://openrouter.ai/keys',
    keyLabel: 'provider.providers.openrouterKey',
    descriptionZh: 'provider.providers.openrouterDesc',
    exampleModel: 'deepseek/deepseek-r1',
  },
  qwen: {
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    keyLabel: 'provider.providers.dashscopeKey',
    descriptionZh: 'provider.providers.dashscopeDesc',
    exampleModel: 'qwen-max',
  },
  zhipu: {
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyLabel: 'provider.providers.zhipuKey',
    descriptionZh: 'provider.providers.zhipuDesc',
    exampleModel: 'glm-4-plus',
  },
  moonshot: {
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyLabel: 'provider.providers.moonshotKey',
    descriptionZh: 'provider.providers.moonshotDesc',
    exampleModel: 'moonshot-v1-128k',
  },
  minimax: {
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyLabel: 'provider.providers.minimaxKey',
    descriptionZh: 'provider.providers.minimaxDesc',
    exampleModel: 'abab6.5s-chat',
  },
  groq: {
    keyUrl: 'https://console.groq.com/keys',
    keyLabel: 'provider.providers.groqKey',
    descriptionZh: 'provider.providers.groqDesc',
    exampleModel: 'llama-3.3-70b-versatile',
  },
  together: {
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    keyLabel: 'provider.providers.togetherKey',
    descriptionZh: 'provider.providers.togetherDesc',
    exampleModel: 'deepseek-ai/DeepSeek-V3',
  },
  yi: {
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
    keyLabel: 'provider.providers.yiKey',
    descriptionZh: 'provider.providers.yiDesc',
    exampleModel: 'yi-large',
  },
  baichuan: {
    keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    keyLabel: 'provider.providers.baichuanKey',
    descriptionZh: 'provider.providers.baichuanDesc',
    exampleModel: 'Baichuan4',
  },
  'openai-compatible-local': {
    keyUrl: 'https://ollama.com',
    keyLabel: 'provider.providers.ollamaKey',
    descriptionZh: 'provider.providers.ollamaDesc',
    exampleModel: 'qwen2.5-coder',
  },
  custom: {
    descriptionZh: 'provider.providers.customDesc',
    exampleModel: 'gpt-4o',
  },
}

export function ProviderSettings() {
  const { t } = useTranslation()
  const providers = useModelStore((s) => s.providers)
  const loadProviders = useModelStore((s) => s.loadProviders)
  const deleteProvider = useModelStore((s) => s.deleteProvider)
  const { activeModel, setActiveModel } = useSessionConfigStore()
  const [selectedId, setSelectedId] = useState<string>('')
  const [isElectron, setIsElectron] = useState(true)

  // Focused Provider Form State
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  // Transient "✓ 已复制" acknowledgement on the copy button.
  const [keyCopied, setKeyCopied] = useState(false)
  const [baseURL, setBaseURL] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [modelId, setModelId] = useState('')
  const [economyModelId, setEconomyModelId] = useState('')
  // Tri-state capability declarations for the CURRENTLY-typed model (#151).
  // Kept per-model, not per-provider, because vision/thinking are properties of
  // the model, not the gateway in front of it.
  const [visionDecl, setVisionDecl] = useState<TriState>(undefined)
  const [thinkingDecl, setThinkingDecl] = useState<TriState>(undefined)
  const [disabledReason, setDisabledReason] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const testingRef = useRef(false)
  // Fast saves (<250ms) do NOT set disabled on the DOM button to prevent
  // losing pointer-events and causing hover/active micro-flicker.
  // Instead, `savingRef` guards against concurrent double-submits.
  const [savingSlow, setSavingSlow] = useState(false)
  const slowTimerRef = useRef<number | null>(null)
  const SLOW_SAVE_MS = 250
  // Spin the header icon only for a refresh the USER asked for. The silent
  // reload at the end of a save also flips the store's `loading`, which made
  // that icon jerk through one frame of spin on every save.
  const [manualLoading, setManualLoading] = useState(false)
  // Has the user touched this form since it was last seeded from disk? A form
  // being edited must never be overwritten by a background store update, and
  // this flag is what makes that guarantee.
  const dirtyRef = useRef(false)
  const markDirty = () => { dirtyRef.current = true }
  // The primary-model pointer, readable without being a dependency. It is
  // repointed by `reconcileActiveModel()` on any catalogue change, so depending
  // on it means a background repoint can rewrite the form under the user.
  const activeModelRef = useRef(activeModel)
  activeModelRef.current = activeModel
  const [savedOk, setSavedOk] = useState(false)
  const [probe, setProbe] = useState<ProbeState>('idle')
  // Two-step destructive action: first click arms, second click commits. A
  // dialog would be heavier than this deserves — nothing here is unrecoverable
  // (a preset resets to factory, a custom entry can be retyped).
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(() => {
    void loadProviders()
  }, [loadProviders])

  const handleManualRefresh = useCallback(async () => {
    setManualLoading(true)
    try {
      await loadProviders()
    } finally {
      setManualLoading(false)
    }
  }, [loadProviders])

  // A save that resolves after this component is gone must not leave a timer
  // behind trying to set state on it.
  useEffect(() => () => {
    if (slowTimerRef.current !== null) window.clearTimeout(slowTimerRef.current)
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.isElectron) {
      setIsElectron(false)
      return
    }
    refresh()
  }, [refresh])

  const providerIds = Object.keys(providers)

  // Default selection to active model provider. Keyed on `providers`, not on
  // `Object.keys(providers)` — that was a fresh array every render, so the dep
  // comparison always failed and this body ran on every single render, including
  // ones caused by nothing but the store's `loading` flag flipping.
  useEffect(() => {
    const ids = Object.keys(providers)
    if (ids.length > 0 && (!selectedId || !providers[selectedId])) {
      const [activePid] = (activeModel || '').split(':')
      if (activePid && providers[activePid]) {
        setSelectedId(activePid)
      } else {
        setSelectedId(ids[0])
      }
    }
  }, [providerIds, selectedId, activeModel, providers])

  // Sync state when selectedId changes.
  //
  // The key field is seeded with the REAL stored key (fetched on demand from the
  // main process) rather than left blank. A blank box after a successful save is
  // what read as 「保存后又不见了」, and the old fix — a fingerprint plus an
  // explicit 更换 button — traded that for a worse problem: 更换 wiped the field,
  // so the previous key was gone and could not be re-read or copied. Pre-filling
  // it masked, with 👁 to reveal, is what every local desktop tool does (VS Code,
  // Postman, DBeaver) and it makes the field non-destructive: nothing is lost by
  // looking at it.
  useEffect(() => {
    dirtyRef.current = false
    setKeyInput('')
    setShowKey(false)
    setKeyCopied(false)
    setSavedOk(false)
    setProbe('idle')
    if (!selectedId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await window.electronAPI?.invoke('model:revealKey', selectedId)
        // Guard on both the unmount/reselect flag and the user having started
        // typing: an in-flight fetch must never overwrite a fresh edit.
        if (cancelled || dirtyRef.current) return
        if (res?.ok && typeof res.apiKey === 'string') setKeyInput(res.apiKey)
      } catch {
        // No key to show is not an error worth surfacing — the field simply
        // stays empty and its placeholder explains what to type.
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  // Seed the editable fields from the SAVED provider. Runs when the user picks a
  // different provider AND whenever fresh data lands for the current one — the
  // store is initialised to the bare preset list, so the real catalogue always
  // arrives after the first selection and the form has to follow it.
  //
  // Two guards earn their keep:
  //   · `dirtyRef` — never overwrite a field the user is part-way through
  //     editing. Saving calls `loadProviders()`, which mutates the store twice.
  //   · no `activeModel` dependency — `reconcileActiveModel()` is subscribed to
  //     EVERY model-store mutation, including the `loading: true` tick at the
  //     start of a reload, when `providers` is still the pre-save snapshot. On
  //     the first successful save it repointed the primary model, this effect
  //     re-ran against that stale snapshot, fell through to
  //     `Object.keys(p.models)[0]` on a catalogue that was still empty, and
  //     wrote '' into the Model ID box. That is the 「保存后模型名字又不见了」
  //     report: the value was on disk the whole time; the form threw it away.
  useEffect(() => {
    if (dirtyRef.current) return
    const p = selectedId ? providers[selectedId] : undefined
    if (!p) return
    setBaseURL(p.options?.baseURL ?? '')
    setEnabled(!!p.enabled)
    setEconomyModelId(p.options?.economyModelId ?? '')

    const models = p.models ?? {}
    const shown = modelId.trim()
    // Already showing a model this provider genuinely has? Leave it. This is
    // what keeps a just-saved id in the box: a preset's catalogue is keyed in
    // preset order, so `Object.keys(...)[0]` would snap back to the stock first
    // model and silently discard what the user typed.
    if (shown && models[shown]) return

    const [activePid, activeMid] = (activeModelRef.current || '').split(':')
    if (activePid === selectedId && activeMid) {
      setModelId(activeMid)
    } else {
      // Only prefill from what's actually SAVED for this provider. Never
      // auto-fill `exampleModel` — that's a greyed placeholder hint, not a
      // value the user chose (see PROVIDER_METAS comment).
      setModelId(Object.keys(models)[0] || '')
    }
  }, [selectedId, providers, modelId])

  // Load the capability declarations for whatever model is currently in the
  // box. Separate from the effect above because `modelId` can change on its own
  // (the user types a different one) and the declarations must follow it. When
  // the typed id has no stored entry — a brand-new model — everything resets to
  // "not declared" rather than carrying the previous model's overrides onto it.
  //
  // `capKeyRef` narrows WHY it re-runs: a different model always reloads its
  // declarations, but a mere catalogue refresh (which is what a save triggers)
  // must not reset toggles the user has flipped and not yet saved.
  const capKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${selectedId}\u0000${modelId.trim()}`
    if (key === capKeyRef.current && dirtyRef.current) return
    capKeyRef.current = key
    const entry = selectedId ? providers[selectedId]?.models?.[modelId.trim()] : undefined
    const cap = entry?.capability
    setVisionDecl(cap?.supportsVision)
    setThinkingDecl(cap?.supportsThinking)
    setDisabledReason(entry?.disabledReason ?? '')
  }, [selectedId, modelId, providers])

  const currentProvider = selectedId ? providers[selectedId] : null
  /** Is a key already on disk for this provider? Drives fingerprint vs. input. */
  const keySaved = !!currentProvider?.options?.hasApiKey
  // What the app would assume with no declaration, shown inside the "inherit"
  // chip so the user can see what they'd be overriding. Read from the catalogue
  // the renderer already has rather than asking the backend — this is a label,
  // and a round-trip per keystroke to render one word isn't worth it.
  const currentModelDef = currentProvider?.models?.[modelId.trim()]
  const inferredVision = !!currentModelDef?.modalities?.input?.includes('image')
  const inferredThinking = !!currentModelDef?.reasoning?.enabled
  // 结构性容量（目录预设携带；手填的模型可能没有 → 容量行整个不显示）
  const modelCtxLimit = currentModelDef?.limit?.context
  const modelOutLimit = currentModelDef?.limit?.output
  const meta = selectedId
    ? PROVIDER_METAS[selectedId] || {
        descriptionZh: 'provider.openaiCompat',
        exampleModel: 'gpt-4o',
      }
    : null

  const handleSave = async (opts?: { silent?: boolean } | unknown): Promise<boolean> => {
    const isSilent = typeof opts === 'object' && opts !== null && 'silent' in opts ? Boolean((opts as { silent?: boolean }).silent) : false
    if (!selectedId || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    if (slowTimerRef.current !== null) window.clearTimeout(slowTimerRef.current)
    slowTimerRef.current = window.setTimeout(() => setSavingSlow(true), SLOW_SAVE_MS)
    setSavedOk(false)
    try {
      const trimmedModel = modelId.trim()
      // Filling in a key AND a model id IS the act of configuring a provider, so
      // the save enables it. Several presets ship `enabled: false` (they exist as
      // templates, not as active accounts), and the toggle mirrors that, so the
      // old behaviour saved a fully-filled-in provider as disabled — which is why
      // 「明明配置了模型，还显示没配模型」: `enabledModels()` skips every disabled
      // provider, so the chat screen saw an empty catalogue. Turning it OFF is
      // still possible; it just isn't the default outcome of configuring it.
      const keyRequired = currentProvider?.options?.apiKeyRequired !== false
      const hasKey = Boolean(
        keyInput.trim() || currentProvider?.options?.hasApiKey || currentProvider?.options?.apiKey,
      )
      const usable = trimmedModel !== '' && (!keyRequired || hasKey)
      const effectiveEnabled = enabled || usable

      // Merge the typed model into the existing catalog WITHOUT clobbering known
      // entries. Preset/catalog models keep their real metadata (context limits,
      // multimodal flags); only a genuinely NEW user-typed model gets a minimal
      // entry — and we deliberately DON'T fabricate capabilities we can't know
      // (the old code hardcoded text-only + 128k, which mislabelled gpt-4o /
      // claude / gemini as text-only after the first save).
      let patchModels = currentProvider?.models
      if (trimmedModel) {
        const prev = currentProvider?.models?.[trimmedModel]
        // Rebuild `capability` from the controls rather than spreading the old
        // one: cycling a chip back to "inherit" has to REMOVE the key, and a
        // spread would leave the stale override in place forever.
        const cap: Record<string, unknown> = {}
        if (prev?.capability?.tier !== undefined) cap.tier = prev.capability.tier
        if (prev?.capability?.costWeight !== undefined) cap.costWeight = prev.capability.costWeight
        if (prev?.capability?.supportsTools !== undefined) cap.supportsTools = prev.capability.supportsTools
        if (visionDecl !== undefined) cap.supportsVision = visionDecl
        if (thinkingDecl !== undefined) cap.supportsThinking = thinkingDecl
        const reason = disabledReason.trim()
        patchModels = {
          ...(currentProvider?.models ?? {}),
          [trimmedModel]: {
            ...(prev ?? { name: trimmedModel }),
            ...(Object.keys(cap).length > 0 ? { capability: cap } : { capability: undefined }),
            ...(reason ? { disabledReason: reason } : { disabledReason: undefined }),
          },
        }
      }
      const trimmedEconomy = economyModelId.trim()
      if (trimmedEconomy) {
        const prevEcon = currentProvider?.models?.[trimmedEconomy]
        patchModels = {
          ...(patchModels ?? currentProvider?.models ?? {}),
          [trimmedEconomy]: prevEcon ?? { name: trimmedEconomy },
        }
      }

      const res = await window.electronAPI?.invoke('model:saveProvider', selectedId, {
        enabled: effectiveEnabled,
        options: { baseURL, apiKey: keyInput, economyModelId: trimmedEconomy },
        ...(patchModels ? { models: patchModels } : {}),
      })
      // The IPC handler returns { ok: false, error } on failure instead of rejecting.
      if (res && res.ok === false) {
        throw new Error(res.error || t('provider.saveFail'))
      }
      // Reflect the auto-enable locally so the toggle doesn't snap back to
      // 「已停用」 until the next refresh lands.
      if (effectiveEnabled && !enabled) setEnabled(true)
      // What's on screen now IS what's on disk, so the form is no longer dirty
      // and the reload below is allowed to re-seed it from persisted truth. The
      // key field keeps its value — it holds the plaintext key that was just
      // saved, which is exactly what the (masked) field should show afterwards.
      dirtyRef.current = false
      setSavedOk(true)
      if (!isSilent) {
        toast.success(t('provider.saved'), { id: 'provider-save' })
      }
      setTimeout(() => setSavedOk(false), 2000)
      refresh()
      return true
    } catch (err) {
      if (!isSilent) {
        toast.error(t('provider.saveFailWith', { msg: err instanceof Error ? err.message : String(err) }), { id: 'provider-save' })
      }
      return false
    } finally {
      if (slowTimerRef.current !== null) {
        window.clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }
      setSavingSlow(false)
      setSaving(false)
      savingRef.current = false
    }
  }

  const handleTestConnection = async () => {
    if (!selectedId || probe === 'testing' || testingRef.current) return
    testingRef.current = true
    setProbe('testing')
    // Dismiss any existing save toast to avoid multi-card clutter, and show unified test toast
    toast.dismiss('provider-save')
    toast.loading(t('provider.testing'), { id: 'provider-test' })
    try {
      if (dirtyRef.current) {
        const saved = await handleSave({ silent: true })
        if (!saved) {
          setProbe('idle')
          toast.error(t('provider.saveFail'), { id: 'provider-test' })
          return
        }
      }
      const r = await window.electronAPI?.invoke('model:testConnection', selectedId)
      if (r?.ok) {
        // Connectivity ✓ is not the same as usable. `probe()` only pings
        // {baseURL}/models; it can't know whether the model id the user typed
        // actually exists, and it says nothing about whether the provider is
        // enabled. Report the reachable-but-not-ready cases instead of a bare
        // 「连接成功」 that the user reads as 「可以用了」.
        if (!modelId.trim()) {
          setProbe('idle')
          toast.warning(t('provider.testOkNoModel', { status: r.status || 200 }), { id: 'provider-test' })
        } else {
          setProbe('idle')
          toast.success(t('provider.testOk', { status: r.status || 200 }), { id: 'provider-test' })
        }
      } else {
        setProbe('idle')
        toast.error(t('provider.testFail', { msg: r?.error ?? `HTTP ${r?.status ?? t('provider.testException')}` }), { id: 'provider-test' })
      }
    } catch (err) {
      // Without this, a rejected invoke leaves probe stuck on 'testing' forever
      // (spinner never resolves, button permanently disabled).
      setProbe('idle')
      toast.error(t('provider.testError', { msg: err instanceof Error ? err.message : String(err) }), { id: 'provider-test' })
    } finally {
      testingRef.current = false
    }
  }

  const handleSetPrimary = () => {
    if (!selectedId) return
    const mid = modelId.trim()
    // No silent substitution: setting a primary model the user never typed is
    // worse than doing nothing. The button is disabled in this state anyway.
    if (!mid) {
      toast.warning(t('provider.fillModelId'), { id: 'provider-primary' })
      return
    }
    setActiveModel(`${selectedId}:${mid}`)
    toast.success(t('provider.currentPrimary', { mid }), { id: 'provider-primary' })
  }

  const handleDeleteProvider = async () => {
    if (!selectedId) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      // Auto-disarm after 3s if the user doesn't commit — prevents a stale
      // "confirm?" badge that becomes a surprise instant-delete hours later.
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    setDeleting(true)
    const ok = await deleteProvider(selectedId)
    setDeleting(false)
    setConfirmDelete(false)
    if (ok) {
      // After delete, jump to the first available provider so the editor isn't
      // pointing at a stale entry. The catalogue is already refreshed inside
      // deleteProvider → loadProviders.
      const nextIds = Object.keys(useModelStore.getState().providers)
      if (nextIds.length > 0) setSelectedId(nextIds[0])
    }
  }

  // Reset confirm-delete badge whenever the user switches to a different
  // provider — otherwise the red badge travels with the focus and surprises.
  useEffect(() => { setConfirmDelete(false) }, [selectedId])

  if (!isElectron) {
    return (
      <Card className="rounded-2xl border border-border/50 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="text-base font-bold">{t('provider.title')}</CardTitle>
          <CardDescription>{t('provider.electronOnly')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const [currentActivePid, currentActiveMid] = (activeModel || '').split(':')
  const isCurrentActive = currentActivePid === selectedId

  return (
    <Card className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <CardHeader className="border-b border-border/40 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-bold text-foreground">
              {t('provider.gatewayTitle')}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {t('provider.gatewaySubtitle')}
            </CardDescription>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleManualRefresh}
            className="h-8 px-2.5 rounded-lg text-xs text-muted-foreground hover:text-foreground"
            title={t('provider.refreshList')}
          >
            <RefreshCw size={13} className={cn('mr-1.5', manualLoading && 'animate-spin')} />
            {t('provider.refresh')}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="flex flex-col lg:flex-row">
          {/* Master list — providers down the side (console layout). A dot per
              row carries state at a glance: enabled (success), configured but
              off (warning), untouched (muted). Selection is a quiet accent fill,
              not a ring+shadow+scale card, so scanning 16 rows stays calm. */}
          <aside className="lg:w-56 lg:shrink-0 border-b lg:border-b-0 lg:border-r border-border/40 p-3 space-y-0.5 lg:max-h-[560px] overflow-y-auto no-scrollbar">
            <div className="px-2 pb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('provider.selectProvider', { count: providerIds.length })}
              </span>
            </div>
            {Object.entries(providers).map(([id, p]) => {
              const isSelected = selectedId === id
              const isPrimary = currentActivePid === id
              const configured = !!p.options?.hasApiKey || Object.keys(p.models ?? {}).length > 0
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedId(id)}
                  className={cn(
                    'group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'shrink-0 w-1.5 h-1.5 rounded-full',
                      p.enabled ? 'bg-success' : configured ? 'bg-warning' : 'bg-muted-foreground/30',
                    )}
                    title={p.enabled ? t('provider.enabled') : configured ? t('provider.disabled') : ''}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium truncate">{p.name}</span>
                    <span className="block text-[10px] font-mono text-muted-foreground/60 truncate">{id}</span>
                  </span>
                  {isPrimary && <Star className="shrink-0 w-3 h-3 text-primary fill-primary" />}
                </button>
              )
            })}
          </aside>

          {/* Detail editor */}
          <div className="flex-1 min-w-0 p-5">
        {currentProvider && (
          <div className="space-y-5 animate-fade-in">
            {/* Identity row. The 获取 Key link is a text link, not a filled
                pill — it leaves the app, so it must not outrank 保存 / 测试. */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground truncate">{currentProvider.name}</h3>
                  <Badge variant="outline" className="text-[10px] py-0 font-mono text-muted-foreground">
                    {currentProvider.kind}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                  {meta?.descriptionZh ? t(meta.descriptionZh) : t('provider.compatFallback')}
                </p>
              </div>

              {meta?.keyUrl && (
                <a
                  href={meta.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 shrink-0 text-xs font-medium text-primary hover:underline underline-offset-2"
                >
                  <span>{t('provider.getKey', { name: currentProvider.name })}</span>
                  <ExternalLink className="w-3 h-3 opacity-70" />
                </a>
              )}
            </div>

            {/* Status row */}
            <div className="flex items-center justify-between gap-3 py-3 border-y border-border/40">
              <div className="flex items-center gap-2.5">
                <Switch checked={enabled} onCheckedChange={(v) => { markDirty(); setEnabled(v) }} aria-label={t('provider.enableAria')} />
                <span className="text-xs font-medium text-foreground">
                  {enabled ? t('provider.enabled') : t('provider.disabled')}
                </span>
              </div>

              <Button
                size="sm"
                variant={isCurrentActive ? 'secondary' : 'outline'}
                onClick={handleSetPrimary}
                disabled={!enabled || (!currentProvider.options.hasApiKey && !keyInput && selectedId !== 'openai-compatible-local')}
                className="rounded-lg h-8 px-3 text-xs font-medium"
              >
                <Star className={cn('w-3.5 h-3.5 mr-1.5', isCurrentActive ? 'text-primary fill-primary' : 'opacity-60')} />
                {isCurrentActive ? t('provider.currentPrimary', { mid: currentActiveMid || modelId }) : t('provider.setPrimary')}
              </Button>
            </div>
            {/* Connection. Base URL and key are one concern, stacked full width:
                a mono URL and a mono key both overflow a half-column at this
                card width, and a truncated endpoint is a support ticket. */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('provider.baseUrlLabel')}
                </label>
                <Input
                  value={baseURL}
                  onChange={(e) => { markDirty(); setBaseURL(e.target.value) }}
                  className="h-9 rounded-lg bg-background border-border/60 text-xs font-mono"
                  placeholder={t('provider.baseUrlPlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('provider.apiKeyLabel')}
                </label>
                {/* One always-editable field, pre-filled with the stored key and
                    masked by `type="password"`. 👁 reveals it so the user can
                    verify or copy it. Nothing here destroys the stored value: an
                    empty field on save means "keep what's on disk" (see
                    modelHandlers `keepKey`), so opening this page cannot lose a
                    key the way the old 更换 button did. */}
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={keyInput}
                    onChange={(e) => { markDirty(); setKeyInput(e.target.value) }}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(
                      'h-9 rounded-lg bg-background border-border/60 text-xs font-mono',
                      keyInput ? 'pr-16' : 'pr-10',
                    )}
                    placeholder={
                      selectedId === 'openai-compatible-local'
                        ? t('provider.keyLocalHint')
                        : t('provider.keyPlaceholder')
                    }
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                    {keyInput && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(keyInput)
                            setKeyCopied(true)
                            window.setTimeout(() => setKeyCopied(false), 1500)
                          } catch { /* clipboard denied — the field stays selectable */ }
                        }}
                        aria-label={t('provider.keyCopy')}
                        title={t('provider.keyCopy')}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {keyCopied
                          ? <Check className="w-3.5 h-3.5 text-success" />
                          : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      aria-label={showKey ? t('provider.keyHide') : t('provider.keyShow')}
                      title={showKey ? t('provider.keyHide') : t('provider.keyShow')}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                {/* Fallback fingerprint: a key IS on disk but the reveal call
                    didn't return one (non-Electron preview, or a keychain the OS
                    refused to unlock). Without this the empty box would read as
                    「没保存」 — the exact confusion this field exists to avoid. */}
                {keySaved && !keyInput && (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Check className="w-3 h-3 shrink-0 text-success" />
                    {t('provider.keyStored', { last4: currentProvider.options.apiKeyLast4 ?? '••••' })}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('provider.modelIdLabel')}
                </label>
                <Input
                  value={modelId}
                  onChange={(e) => { markDirty(); setModelId(e.target.value) }}
                  placeholder={meta?.exampleModel ? t('provider.modelIdPlaceholderTpl', { example: meta.exampleModel }) : t('provider.modelIdPlaceholderFallback')}
                  className="h-9 rounded-lg bg-background border-border/60 text-xs font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('provider.economyModelIdLabel')}
                </label>
                <Input
                  value={economyModelId}
                  onChange={(e) => { markDirty(); setEconomyModelId(e.target.value) }}
                  placeholder={t('provider.economyModelIdPlaceholder')}
                  className="h-9 rounded-lg bg-background border-border/60 text-xs font-mono"
                />
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  {t('provider.economyModelIdHint')}
                </p>
              </div>
            </div>
            {/* Capability declaration for the model above (#151). Tri-state, so
                "never touched" stays distinct from "explicitly unsupported" —
                the backend needs that difference to decide between inferring
                from the model family and obeying the user.

                No inner card: this used to be a bordered box inside a bordered
                box inside the card, which made the third level of nesting read
                as a modal. A label plus hairlines carries the same grouping. */}
            <div className="space-y-1 pt-1">
              <div className="pb-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('provider.cap.title')}
                </span>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  {t('provider.cap.subtitle')}
                </p>
              </div>

              {/* 容量行：这两个数字解释「为什么我的对话折得比别人早」。目录预设之外的
                  手填模型拿不到目录值 → 整行不显示，避免把猜测当成规格。 */}
              {typeof modelCtxLimit === 'number' && modelCtxLimit > 0 && (
                <p className="text-[11px] text-muted-foreground/80">
                  {t('provider.cap.ctxLine',
                    '上下文容量 ≈{{ctx}} tokens · 单次回复上限 ≈{{out}} tokens（容量决定多长的对话才开始折叠整理）',
                    { ctx: fmtK(modelCtxLimit), out: modelOutLimit ? fmtK(modelOutLimit) : '—' })}
                </p>
              )}

              <div className="divide-y divide-border/40 border-y border-border/40">
                <CapabilityTri
                  label={t('provider.cap.vision')}
                  hint={t('provider.cap.visionHint')}
                  icon={<ImageIcon className="w-3.5 h-3.5 opacity-70" />}
                  value={visionDecl}
                  inferred={inferredVision ? t('provider.cap.on') : t('provider.cap.off')}
                  onChange={(v) => { markDirty(); setVisionDecl(v) }}
                />

                <CapabilityTri
                  label={t('provider.cap.thinking')}
                  hint={t('provider.cap.thinkingHint')}
                  icon={<Brain className="w-3.5 h-3.5 opacity-70" />}
                  value={thinkingDecl}
                  inferred={inferredThinking ? t('provider.cap.on') : t('provider.cap.off')}
                  onChange={(v) => { markDirty(); setThinkingDecl(v) }}
                />
              </div>

              {/* 「停用」 is a switch, not a text box. Before, the ONLY way to mark
                  a model unusable was to type prose into a 停用原因 field, which
                  asked the user to compose a sentence in order to flip a boolean.
                  The reason string is still the stored value (the model list
                  shows it), so turning the switch on seeds a default and reveals
                  the field for anyone who wants to say more. */}
              <div className="pt-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">{t('provider.cap.disable')}</div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t('provider.cap.disableHint')}</p>
                  </div>
                  <Switch
                    checked={disabledReason.trim() !== ''}
                    onCheckedChange={(on) => {
                      markDirty()
                      setDisabledReason(on ? t('provider.cap.disableDefault') : '')
                    }}
                    aria-label={t('provider.cap.disable')}
                  />
                </div>
                {disabledReason.trim() !== '' && (
                  <Input
                    value={disabledReason}
                    onChange={(e) => { markDirty(); setDisabledReason(e.target.value) }}
                    placeholder={t('provider.cap.disableReasonPh')}
                    className="mt-2 h-8 rounded-lg bg-background border-border/60 text-xs"
                  />
                )}
              </div>
            </div>
            {/* Action bar. Probe results are delivered as floating toasts to
                prevent cumulative layout shifts (CLS) that push the action buttons down. */}
            <div className="pt-2">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={savingSlow}
                  // Fast saves (<250ms) do NOT set disabled on the DOM button to prevent
                  // the browser from stripping :hover/:active states (which causes bright color flicker).
                  // min-w-[116px] maintains a strictly stable width across both "保存配置" and
                  // "已保存配置" so the adjacent buttons never move.
                  className="rounded-lg px-4 h-8 min-w-[116px] text-xs font-semibold bg-foreground hover:bg-foreground/90 text-background select-none transition-colors"
                >
                  {savingSlow ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin shrink-0" />
                  ) : savedOk ? (
                    <Check className="w-3.5 h-3.5 mr-1.5 shrink-0" />
                  ) : null}
                  <span>{savedOk ? t('provider.saved') : t('provider.saveConfig')}</span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={probe === 'testing'}
                  className="rounded-lg px-3 h-8 text-xs font-medium"
                >
                  {probe === 'testing' ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      {t('provider.testing')}
                    </>
                  ) : (
                    t('provider.testConn')
                  )}
                </Button>

                {/* Destructive action, pushed to the far edge and last in tab
                    order. Label differs by kind because the OUTCOME differs: a
                    preset provider is re-seeded from FALLBACK_PROVIDERS on the
                    next load, so this can only clear its key/models back to
                    factory — calling that "delete" would be a lie. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDeleteProvider}
                  disabled={deleting}
                  title={
                    isPresetProvider(selectedId)
                      ? t('provider.resetHint')
                      : t('provider.deleteHint')
                  }
                  className={cn(
                    'ml-auto rounded-lg px-2.5 h-8 text-xs font-medium',
                    confirmDelete
                      ? 'text-destructive bg-destructive/10 hover:bg-destructive/15'
                      : 'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
                  )}
                >
                  {deleting ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {confirmDelete
                    ? t('provider.confirmDelete')
                    : isPresetProvider(selectedId)
                      ? t('provider.resetConfig')
                      : t('provider.deleteProvider')}
                </Button>
              </div>
            </div>
          </div>
        )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

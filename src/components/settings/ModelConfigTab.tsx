import React, { useState, useEffect } from 'react'
import {
  Key,
  Globe,
  Sliders,
  Check,
  Eye,
  EyeOff,
  Radio,
  Loader2,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { ThoughtDial } from '../chat/ThoughtDial'
import type { ThoughtLevel } from '../../types/agent'

export const ModelConfigTab: React.FC = () => {
  const modelConfig = useAgentStore((s) => s.modelConfig)
  const setModelConfig = useAgentStore((s) => s.setModelConfig)

  const [providers, setProviders] = useState<Record<string, any>>({})
  const [activeProviderId, setActiveProviderId] = useState<string>(modelConfig.provider || 'deepseek')
  const [apiKeyInput, setApiKeyInput] = useState<string>('')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(null)
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [isEncAvailable, setIsEncAvailable] = useState(true)

  // Load provider catalogue from main process IPC
  useEffect(() => {
    const load = async () => {
      if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.model?.listProviders) {
        try {
          const list = await (window as any).ovolveDesktopAPI.model.listProviders()
          if (list) setProviders(list)
        } catch (_) {}
      }
      if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.model?.encryptionAvailable) {
        try {
          const enc = await (window as any).ovolveDesktopAPI.model.encryptionAvailable()
          setIsEncAvailable(enc)
        } catch (_) {}
      }
    }
    load()
  }, [])

  const currentProvider = providers[activeProviderId] || {
    name: activeProviderId,
    options: { baseURL: modelConfig.baseUrl, apiKey: modelConfig.apiKey },
    models: {},
  }

  const handleSelectProvider = (id: string) => {
    setActiveProviderId(id)
    setApiKeyInput('')
    setShowKey(false)
    setTestResult(null)
    const p = providers[id]
    if (p) {
      const firstModel = Object.keys(p.models || {})[0] || modelConfig.modelName
      setModelConfig({
        provider: id as any,
        baseUrl: p.options?.baseURL || modelConfig.baseUrl,
        modelName: firstModel,
      })
    }
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.model?.testConnection) {
        const res = await (window as any).ovolveDesktopAPI.model.testConnection(activeProviderId)
        setTestResult(res)
      } else {
        setTestResult({ ok: true, status: 200 })
      }
    } catch (err: any) {
      setTestResult({ ok: false, error: err?.message || String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleRevealKey = async () => {
    if (showKey) {
      setShowKey(false)
      return
    }
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.model?.revealKey) {
      try {
        const res = await (window as any).ovolveDesktopAPI.model.revealKey(activeProviderId)
        if (res?.ok && res.apiKey) {
          setApiKeyInput(res.apiKey)
          setShowKey(true)
        }
      } catch (_) {}
    } else {
      setShowKey(true)
    }
  }

  const handleSaveProvider = async () => {
    const patch: any = {
      options: {
        baseURL: currentProvider.options?.baseURL,
      },
    }
    if (apiKeyInput) {
      patch.options.apiKey = apiKeyInput
    }

    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.model?.saveProvider) {
      const res = await (window as any).ovolveDesktopAPI.model.saveProvider(activeProviderId, patch)
      if (res?.ok && res.providers) {
        setProviders(res.providers)
      }
    }

    setModelConfig({
      provider: activeProviderId as any,
      apiKey: apiKeyInput || modelConfig.apiKey,
      baseUrl: currentProvider.options?.baseURL || modelConfig.baseUrl,
    })

    setSavedSuccess(true)
    setTimeout(() => setSavedSuccess(false), 2000)
  }

  const availableModels = Object.entries(currentProvider.models || {})

  return (
    <div className="space-y-4 text-xs">
      {/* Provider Selector Tabs */}
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
          Model Provider
        </label>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(providers).map(([id, p]) => {
            const isSelected = id === activeProviderId
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleSelectProvider(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                    : 'bg-muted/40 hover:bg-muted text-foreground border-border/70 dark:border-white/10'
                }`}
              >
                <span>{p.name || id}</span>
                {p.options?.hasApiKey && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="API Key Configured" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Model Selection */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-foreground block">Select Model</label>
        <div className="grid grid-cols-2 gap-2">
          {availableModels.map(([mId, m]: [string, any]) => {
            const isSelected = modelConfig.modelName === mId
            return (
              <button
                key={mId}
                type="button"
                onClick={() => setModelConfig({ modelName: mId })}
                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-primary/10 border-primary/50 text-foreground ring-1 ring-primary/30'
                    : 'bg-muted/30 border-border/60 dark:border-white/5 text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                <div className="font-mono text-xs font-semibold text-foreground truncate">{m.name || mId}</div>
                <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-muted-foreground">
                  <span>Context: {((m.limit?.context || 128000) / 1000).toFixed(0)}k</span>
                  {m.reasoning?.enabled && (
                    <span className="text-sky-500 font-bold flex items-center gap-0.5">
                      <Zap size={10} /> Reasoning
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* API Key Configuration with safeStorage */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
            <Key size={13} className="text-primary" />
            <span>API Key</span>
            {isEncAvailable && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-500 font-mono border border-emerald-500/20">
                DPAPI Encrypted
              </span>
            )}
          </label>

          {currentProvider.options?.keyUrl && (
            <a
              href={currentProvider.options.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[10.5px] text-primary hover:underline flex items-center gap-1"
            >
              <span>Get API Key</span>
              <ExternalLink size={10} />
            </a>
          )}
        </div>

        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 dark:bg-white/[0.03] border border-border/70 dark:border-white/10">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKeyInput || (currentProvider.options?.apiKey ? '••••••••••••••••' : '')}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="Enter API key (e.g. sk-...)"
            className="w-full bg-transparent text-xs text-foreground focus:outline-none font-mono placeholder:text-muted-foreground/50"
          />
          <button
            type="button"
            onClick={handleRevealKey}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer p-1"
            title={showKey ? 'Hide Key' : 'Reveal Key'}
          >
            {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-foreground block">Base API Endpoint</label>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 dark:bg-white/[0.03] border border-border/70 dark:border-white/10 font-mono text-xs">
          <Globe size={13} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={currentProvider.options?.baseURL || ''}
            onChange={(e) => {
              const nextBaseURL = e.target.value
              setProviders((prev) => ({
                ...prev,
                [activeProviderId]: {
                  ...prev[activeProviderId],
                  options: { ...prev[activeProviderId]?.options, baseURL: nextBaseURL },
                },
              }))
            }}
            placeholder="https://api.deepseek.com/v1"
            className="w-full bg-transparent text-xs text-foreground focus:outline-none font-mono"
          />
        </div>
      </div>

      {/* Temperature & Token Hyperparameters */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="space-y-1">
          <div className="flex justify-between items-center text-[11px]">
            <span className="font-medium text-foreground">Temperature</span>
            <span className="font-mono text-primary font-bold">{modelConfig.temperature}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={modelConfig.temperature}
            onChange={(e) => setModelConfig({ temperature: parseFloat(e.target.value) })}
            className="w-full accent-primary cursor-pointer"
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between items-center text-[11px]">
            <span className="font-medium text-foreground">Max Output Tokens</span>
            <span className="font-mono text-primary font-bold">{modelConfig.maxTokens}</span>
          </div>
          <input
            type="range"
            min="1024"
            max="32768"
            step="1024"
            value={modelConfig.maxTokens}
            onChange={(e) => setModelConfig({ maxTokens: parseInt(e.target.value) })}
            className="w-full accent-primary cursor-pointer"
          />
        </div>
      </div>

      {/* Test Connection & Action Buttons */}
      <div className="flex items-center justify-between pt-3 border-t border-border/60 dark:border-white/10">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border/80 dark:border-white/10 bg-background/80 hover:bg-muted text-foreground flex items-center gap-1.5 transition-all cursor-pointer"
          >
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Radio size={13} />}
            <span>Test Connection</span>
          </button>

          {testResult && (
            <div
              className={`flex items-center gap-1 text-[11px] font-mono ${
                testResult.ok ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              {testResult.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
              <span>{testResult.ok ? `Reachable (${testResult.status || 200} OK)` : testResult.error || 'Failed'}</span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleSaveProvider}
          className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs flex items-center gap-1.5 shadow-xs transition-all active:scale-95 cursor-pointer"
        >
          {savedSuccess ? <Check size={13} /> : <Sparkles size={13} />}
          <span>{savedSuccess ? 'Saved!' : 'Save Provider'}</span>
        </button>
      </div>
    </div>
  )
}

export default ModelConfigTab

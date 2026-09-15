// src/store/modelStore.ts
// Model provider registry. Loaded from Electron IPC (model:listProviders),
// with an in-memory working copy and complete 16+ preset fallbacks.
import { create } from 'zustand'

export interface ModelDef {
  name?: string
  // Optional on purpose: a model ID the user types by hand has UNKNOWN
  // capabilities. Fabricating "text-only / 128k" for it used to overwrite the
  // catalog's real metadata and mislabel gpt-4o / claude / gemini as text-only.
  // Absent means "unknown" — consumers must guard (see ModelSelector).
  limit?: { context: number; output?: number }
  modalities?: { input: string[]; output: string[] }
  reasoning?: { enabled: boolean; variants: string[]; defaultVariant: string }
  // Explicit capability declaration (#151). Each flag is TRI-STATE: absent =
  // "not declared, let the backend infer from the model family", true/false =
  // "the user said so, override the inference". A plain boolean cannot express
  // that — `false` and "never configured" would be the same value, and every
  // model would render as explicitly incapable on first load.
  capability?: {
    supportsVision?: boolean
    supportsThinking?: boolean
    supportsTools?: boolean
    tier?: number
    costWeight?: number
  }
  // Why this model is unselectable. Shown next to it instead of hiding it, so a
  // model missing from the picker is never a silent mystery.
  disabledReason?: string
  priority?: number
}

export interface ProviderDef {
  name: string
  kind: 'anthropic' | 'openai-compatible'
  options: {
    apiKey: string
    baseURL: string
    apiKeyRequired?: boolean
    hasApiKey?: boolean
    /**
     * Last 4 characters of the stored key, or undefined when none is stored.
     *
     * The renderer never receives the real key, which is correct — but it left
     * the settings form unable to show anything except an empty box, and an
     * empty box after a save reads as 「保存后又不见了」. A fingerprint is the
     * standard way out (Stripe, GitHub and AWS all show the last 4): enough to
     * confirm WHICH key is stored, useless to anyone who steals it.
     */
    apiKeyLast4?: string
    keyUrl?: string
    /** Optional lighter model on the same API (Settings → economy model). */
    economyModelId?: string
  }
  enabled: boolean
  models: Record<string, ModelDef>
  systemDisabledReason?: string
}

const TEXT_ONLY = { input: ['text'], output: ['text'] }
const TEXT_VISION = { input: ['text', 'image'], output: ['text'] }
const REASONING_TOGGLE = {
  enabled: true,
  variants: ['off', 'low', 'high', 'max'],
  defaultVariant: 'high',
}

export const FALLBACK_PROVIDERS: Record<string, ProviderDef> = {
  longcat: {
    name: 'LongCat (美团)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.longcat.chat/openai/v1',
      apiKeyRequired: true,
      keyUrl: 'https://longcat.chat',
    },
    enabled: false,
    models: {
      'LongCat-2.0': {
        name: 'LongCat 2.0',
        limit: { context: 1000000, output: 8192 },
        modalities: TEXT_ONLY,
        reasoning: REASONING_TOGGLE,
        priority: 310,
      },
    },
  },

  deepseek: {
    name: 'DeepSeek',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.deepseek.com/api_keys',
    },
    enabled: false,
    models: {
      'deepseek-chat': {
        name: 'DeepSeek Chat (V3)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 300,
      },
      'deepseek-reasoner': {
        name: 'DeepSeek Reasoner (R1)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        reasoning: REASONING_TOGGLE,
        priority: 301,
      },
    },
  },

  anthropic: {
    name: 'Anthropic Claude',
    kind: 'anthropic',
    options: {
      apiKey: '',
      baseURL: 'https://api.anthropic.com',
      apiKeyRequired: true,
      keyUrl: 'https://console.anthropic.com/settings/keys',
    },
    enabled: false,
    models: {
      'claude-3-5-sonnet-20241022': {
        name: 'Claude 3.5 Sonnet',
        limit: { context: 200000, output: 8192 },
        modalities: TEXT_VISION,
        reasoning: REASONING_TOGGLE,
        priority: 250,
      },
      'claude-3-5-haiku-20241022': {
        name: 'Claude 3.5 Haiku',
        limit: { context: 200000, output: 8192 },
        modalities: TEXT_VISION,
        priority: 240,
      },
      'claude-3-opus-20240229': {
        name: 'Claude 3 Opus',
        limit: { context: 200000, output: 4096 },
        modalities: TEXT_VISION,
        priority: 230,
      },
    },
  },

  openai: {
    name: 'OpenAI',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.openai.com/api-keys',
    },
    enabled: false,
    models: {
      'gpt-4o': {
        name: 'GPT-4o',
        limit: { context: 128000, output: 16384 },
        modalities: TEXT_VISION,
        priority: 200,
      },
      'gpt-4o-mini': {
        name: 'GPT-4o Mini',
        limit: { context: 128000, output: 16384 },
        modalities: TEXT_VISION,
        priority: 190,
      },
      'o1': {
        name: 'o1',
        limit: { context: 200000, output: 100000 },
        modalities: TEXT_VISION,
        reasoning: REASONING_TOGGLE,
        priority: 210,
      },
      'o3-mini': {
        name: 'o3-mini',
        limit: { context: 200000, output: 100000 },
        modalities: TEXT_VISION,
        reasoning: REASONING_TOGGLE,
        priority: 205,
      },
    },
  },

  gemini: {
    name: 'Google Gemini',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyRequired: true,
      keyUrl: 'https://aistudio.google.com/apikey',
    },
    enabled: false,
    models: {
      'gemini-2.0-flash': {
        name: 'Gemini 2.0 Flash',
        limit: { context: 1048576, output: 8192 },
        modalities: TEXT_VISION,
        priority: 220,
      },
      'gemini-1.5-pro': {
        name: 'Gemini 1.5 Pro',
        limit: { context: 2097152, output: 8192 },
        modalities: TEXT_VISION,
        priority: 215,
      },
      'gemini-1.5-flash': {
        name: 'Gemini 1.5 Flash',
        limit: { context: 1048576, output: 8192 },
        modalities: TEXT_VISION,
        priority: 210,
      },
    },
  },

  siliconflow: {
    name: '硅基流动 (SiliconFlow)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.siliconflow.cn/v1',
      apiKeyRequired: true,
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    },
    enabled: false,
    models: {
      'deepseek-ai/DeepSeek-V3': {
        name: 'DeepSeek V3 (SiliconFlow)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 180,
      },
      'deepseek-ai/DeepSeek-R1': {
        name: 'DeepSeek R1 (SiliconFlow)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        reasoning: REASONING_TOGGLE,
        priority: 185,
      },
      'Qwen/Qwen2.5-72B-Instruct': {
        name: 'Qwen 2.5 72B',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 170,
      },
    },
  },

  openrouter: {
    name: 'OpenRouter',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyRequired: true,
      keyUrl: 'https://openrouter.ai/keys',
    },
    enabled: false,
    models: {
      'deepseek/deepseek-r1': {
        name: 'DeepSeek R1',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        reasoning: REASONING_TOGGLE,
        priority: 160,
      },
      'anthropic/claude-3.5-sonnet': {
        name: 'Claude 3.5 Sonnet',
        limit: { context: 200000, output: 8192 },
        modalities: TEXT_VISION,
        priority: 155,
      },
      'openai/gpt-4o': {
        name: 'GPT-4o',
        limit: { context: 128000, output: 16384 },
        modalities: TEXT_VISION,
        priority: 150,
      },
    },
  },

  qwen: {
    name: '通义千问 (Qwen / 阿里云)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyRequired: true,
      keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    },
    enabled: false,
    models: {
      'qwen-max': {
        name: 'Qwen Max',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 140,
      },
      'qwen-plus': {
        name: 'Qwen Plus',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 135,
      },
      'qwen-turbo': {
        name: 'Qwen Turbo',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 130,
      },
      'qwen2.5-coder-32b-instruct': {
        name: 'Qwen 2.5 Coder 32B',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 145,
      },
    },
  },

  zhipu: {
    name: '智谱 AI (GLM)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyRequired: true,
      keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    },
    enabled: false,
    models: {
      'glm-4-plus': {
        name: 'GLM-4 Plus',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_VISION,
        priority: 120,
      },
      'glm-4-air': {
        name: 'GLM-4 Air',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 115,
      },
      'glm-4-flash': {
        name: 'GLM-4 Flash (免费)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 110,
      },
    },
  },

  moonshot: {
    name: '月之暗面 (Moonshot / Kimi)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.moonshot.cn/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    },
    enabled: false,
    models: {
      'moonshot-v1-128k': {
        name: 'Moonshot v1 128k',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 100,
      },
      'moonshot-v1-32k': {
        name: 'Moonshot v1 32k',
        limit: { context: 32768, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 95,
      },
    },
  },

  minimax: {
    name: 'MiniMax',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.minimax.chat/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    },
    enabled: false,
    models: {
      'abab6.5s-chat': {
        name: 'Abab 6.5s Chat',
        limit: { context: 245000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 90,
      },
      'MiniMax-Text-01': {
        name: 'MiniMax Text 01',
        limit: { context: 1000000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 92,
      },
    },
  },

  groq: {
    name: 'Groq (极速推理)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKeyRequired: true,
      keyUrl: 'https://console.groq.com/keys',
    },
    enabled: false,
    models: {
      'llama-3.3-70b-versatile': {
        name: 'Llama 3.3 70B',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 85,
      },
      'llama-3.1-8b-instant': {
        name: 'Llama 3.1 8B Instant',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 80,
      },
    },
  },

  together: {
    name: 'Together AI',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.together.xyz/v1',
      apiKeyRequired: true,
      keyUrl: 'https://api.together.xyz/settings/api-keys',
    },
    enabled: false,
    models: {
      'deepseek-ai/DeepSeek-V3': {
        name: 'DeepSeek V3 (Together)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 75,
      },
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': {
        name: 'Llama 3.3 70B Turbo',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 70,
      },
    },
  },

  yi: {
    name: '零一万物 (01.AI / Yi)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.lingyiwanwu.com/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
    },
    enabled: false,
    models: {
      'yi-large': {
        name: 'Yi Large',
        limit: { context: 32768, output: 4096 },
        modalities: TEXT_ONLY,
        priority: 65,
      },
      'yi-spark': {
        name: 'Yi Spark',
        limit: { context: 16384, output: 4096 },
        modalities: TEXT_ONLY,
        priority: 60,
      },
    },
  },

  baichuan: {
    name: '百川智能 (Baichuan)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.baichuan-ai.com/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    },
    enabled: false,
    models: {
      'Baichuan4': {
        name: 'Baichuan 4',
        limit: { context: 32768, output: 4096 },
        modalities: TEXT_ONLY,
        priority: 55,
      },
      'Baichuan3-Turbo': {
        name: 'Baichuan 3 Turbo',
        limit: { context: 32768, output: 4096 },
        modalities: TEXT_ONLY,
        priority: 50,
      },
    },
  },

  'openai-compatible-local': {
    name: 'Ollama / 本地自建',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyRequired: false,
      keyUrl: 'https://ollama.com',
    },
    enabled: false,
    models: {
      'deepseek-r1': {
        name: 'DeepSeek R1 (Local)',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        reasoning: REASONING_TOGGLE,
        priority: 45,
      },
      'qwen2.5-coder': {
        name: 'Qwen 2.5 Coder',
        limit: { context: 32768, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 40,
      },
      'llama3.1': {
        name: 'Llama 3.1',
        limit: { context: 128000, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 35,
      },
    },
  },

  custom: {
    name: '自定义 / 中转站 (Proxy)',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: '',
      apiKeyRequired: true,
    },
    enabled: false,
    // Deliberately EMPTY, and must stay in sync with the same entry in
    // electron/ipc/modelCatalog.ts. A placeholder model here is not harmless:
    // `mergeWithFallbacks` re-seeds presets over the saved config on every load,
    // so the placeholder always comes back; it carried a `priority` while a model
    // the user types carries none, so `enabledModels()` sorted it first,
    // `reconcileActiveModel` adopted it as the active model, and the settings form
    // re-seeded its input from that — making the id the user had just saved look
    // like it reverted on its own. A proxy's model id is only knowable by the user.
    models: {},
  },
}

/**
 * Model ids that older builds seeded as placeholders. They must never reach the
 * model picker: the picker is a list of models you can actually call, and
 * `custom-model` was never callable anywhere — it was filler so the 中转站
 * provider's list wouldn't look empty.
 *
 * Filtered here as well as in the Electron main process on purpose. Main cleans
 * the file on disk, but the renderer is the last gate before the dropdown, and it
 * also owns the offline `FALLBACK_PROVIDERS` path. One stale packaged bundle or
 * one config read that skips main should not be able to put a phantom model back
 * in front of the user.
 */
const DEAD_PLACEHOLDER_MODELS = new Set(['custom-model'])

function withoutPlaceholders(models?: Record<string, ModelDef>): Record<string, ModelDef> {
  const out: Record<string, ModelDef> = {}
  for (const [mid, def] of Object.entries(models || {})) {
    if (DEAD_PLACEHOLDER_MODELS.has(mid)) continue
    out[mid] = def
  }
  return out
}

function mergeWithFallbacks(incoming: Record<string, ProviderDef>): Record<string, ProviderDef> {
  const result: Record<string, ProviderDef> = JSON.parse(JSON.stringify(FALLBACK_PROVIDERS))
  for (const [id, p] of Object.entries(incoming || {})) {
    const incomingModels = withoutPlaceholders(p.models)
    if (result[id]) {
      result[id] = {
        ...result[id],
        ...p,
        options: {
          ...result[id].options,
          ...p.options,
        },
        models: {
          ...withoutPlaceholders(result[id].models),
          ...incomingModels,
        },
      }
    } else {
      result[id] = { ...p, models: incomingModels }
    }
  }
  return result
}

/**
 * Is this provider one of the built-in presets?
 *
 * Matters for delete UX: `mergeWithFallbacks` re-seeds every preset on each
 * load, so "deleting" a preset can only ever RESET it to factory defaults
 * (disabled, no key, stock model list). Only a provider the user added from
 * scratch can actually disappear. The UI must say which of the two it's doing,
 * or the button lies.
 */
export function isPresetProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(FALLBACK_PROVIDERS, id)
}

/** Same distinction, one level down: preset models come back after a reload. */
export function isPresetModel(providerId: string, modelId: string): boolean {
  return Boolean(FALLBACK_PROVIDERS[providerId]?.models?.[modelId])
}

interface ModelState {
  providers: Record<string, ProviderDef>
  loading: boolean
  error: string | null
  loadProviders: () => Promise<void>
  /**
   * Remove a provider from config.json. For a preset this is a RESET (the
   * fallback definition returns on the next load); for a user-added provider
   * it is a real delete.
   */
  deleteProvider: (id: string) => Promise<boolean>
  /** Drop one model from a provider's catalogue. */
  removeModel: (providerId: string, modelId: string) => Promise<boolean>
  enabledModels: () => Array<{ providerId: string; modelId: string; provider: ProviderDef; model: ModelDef }>
}

export const useModelStore = create<ModelState>((set, get) => ({
  providers: FALLBACK_PROVIDERS,
  loading: false,
  error: null,

  loadProviders: async () => {
    set({ loading: true, error: null })
    try {
      const data = await window.electronAPI?.invoke('model:listProviders')
      set({ providers: mergeWithFallbacks(data ?? {}), loading: false })
    } catch (e: any) {
      set({ error: e?.message ?? 'failed', loading: false })
    }
  },

  deleteProvider: async (id: string) => {
    try {
      const res = await window.electronAPI?.invoke('model:deleteProvider', id)
      if (res && res.ok === false) {
        set({ error: res.error ?? 'delete failed' })
        return false
      }
      // Re-read rather than patching locally: the merge with presets is the
      // authority on what a provider looks like after a reset, and duplicating
      // that logic here is how the two copies drift.
      await get().loadProviders()
      return true
    } catch (e: any) {
      set({ error: e?.message ?? 'delete failed' })
      return false
    }
  },

  removeModel: async (providerId: string, modelId: string) => {
    const p = get().providers[providerId]
    if (!p || !p.models?.[modelId]) return false
    const models = { ...p.models }
    delete models[modelId]
    try {
      // `model:saveProvider` shallow-merges the patch over the stored entry, so
      // handing it the reduced map replaces the catalogue wholesale — which is
      // exactly the removal we want.
      const res = await window.electronAPI?.invoke('model:saveProvider', providerId, {
        enabled: p.enabled,
        options: { baseURL: p.options?.baseURL ?? '', apiKey: '' },
        models,
      })
      if (res && res.ok === false) {
        set({ error: res.error ?? 'remove failed' })
        return false
      }
      await get().loadProviders()
      return true
    } catch (e: any) {
      set({ error: e?.message ?? 'remove failed' })
      return false
    }
  },

  enabledModels: () => {
    const { providers } = get()
    const list: Array<{ providerId: string; modelId: string; provider: ProviderDef; model: ModelDef }> = []
    for (const [pid, p] of Object.entries(providers)) {
      if (!p.enabled) continue
      const keyRequired = p.options?.apiKeyRequired !== false
      const hasKey = Boolean(p.options?.hasApiKey || (p.options?.apiKey && p.options.apiKey.trim()))
      if (keyRequired && !hasKey) continue

      for (const [mid, m] of Object.entries(p.models || {})) {
        list.push({ providerId: pid, modelId: mid, provider: p, model: m })
      }
    }
    list.sort((a, b) => (b.model.priority ?? 0) - (a.model.priority ?? 0))
    return list
  },
}))

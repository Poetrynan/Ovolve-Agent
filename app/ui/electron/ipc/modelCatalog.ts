// electron/ipc/modelCatalog.ts
// Comprehensive Seed provider catalog. Shipped empty-keyed; the user fills API keys in
// Settings → 模型供应商. Context windows come from each vendor's public docs.

export interface CatalogModel {
  name?: string
  limit: { context: number; output?: number }
  modalities: { input: string[]; output: string[] }
  reasoning?: {
    enabled: boolean
    variants: string[]
    defaultVariant: string
  }
  priority?: number
}

export interface CatalogProvider {
  name: string
  kind: 'anthropic' | 'openai-compatible'
  options: { apiKey: string; baseURL: string; apiKeyRequired?: boolean; keyUrl?: string }
  enabled: boolean
  models: Record<string, CatalogModel>
}

const TEXT_ONLY = { input: ['text'], output: ['text'] }
const TEXT_VISION = { input: ['text', 'image'], output: ['text'] }
const REASONING_TOGGLE = {
  enabled: true,
  variants: ['off', 'low', 'high', 'max'],
  defaultVariant: 'high',
}

export const DEFAULT_PROVIDER_CATALOG: Record<string, CatalogProvider> = {
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
    // Deliberately EMPTY. There used to be a placeholder model called
    // `custom-model` here, and it caused a real bug: presets are re-merged over
    // the user's saved config on every load, so the placeholder always came
    // back. Worse, it carried a `priority`, and the model a user types carries
    // none — so `reconcileActiveModel` picked the placeholder as "best", the
    // settings form re-seeded its input from the active model, and the model id
    // the user had just typed and saved appeared to revert to `custom-model` on
    // its own. A proxy's model id is only knowable by the user; inventing one
    // here can only ever be wrong.
    models: {},
  },
}

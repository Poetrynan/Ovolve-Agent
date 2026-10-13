// electron/ipc/modelCatalog.ts
// Comprehensive Seed provider catalog. Context windows from public docs.

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
  deepseek: {
    name: 'DeepSeek',
    kind: 'openai-compatible',
    options: {
      apiKey: '',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyRequired: true,
      keyUrl: 'https://platform.deepseek.com/api_keys',
    },
    enabled: true,
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
      'qwen2.5-coder-32b-instruct': {
        name: 'Qwen 2.5 Coder 32B',
        limit: { context: 131072, output: 8192 },
        modalities: TEXT_ONLY,
        priority: 145,
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
    models: {},
  },
}

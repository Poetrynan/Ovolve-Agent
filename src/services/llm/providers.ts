export interface LLMProviderSpec {
  id: string
  name: string
  defaultBaseUrl: string
  defaultModel: string
  supportsReasoning: boolean
  supportsPromptCaching: boolean
  format: 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'
}

export const SUPPORTED_PROVIDERS: Record<string, LLMProviderSpec> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-reasoner',
    supportsReasoning: true,
    supportsPromptCaching: true,
    format: 'openai-compatible',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    supportsReasoning: true,
    supportsPromptCaching: true,
    format: 'openai-compatible',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-7-sonnet-20250219',
    supportsReasoning: true,
    supportsPromptCaching: true,
    format: 'anthropic',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro',
    supportsReasoning: true,
    supportsPromptCaching: true,
    format: 'gemini',
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'deepseek-r1:8b',
    supportsReasoning: true,
    supportsPromptCaching: false,
    format: 'openai-compatible',
  },
}

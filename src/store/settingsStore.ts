import { create } from 'zustand';

export interface SettingsState {
  apiKey: string;
  baseUrl: string;
  temperature: number;
  confirmRiskyCommands: boolean;
  sandboxIsolation: boolean;

  // Cache settings
  cacheSemanticEnabled: boolean;
  cacheSemanticThreshold: number;
  cacheAttentionSinkEnabled: boolean;
  cacheAttentionSinkKeepFirst: number;
  cacheAttentionSinkKeepRecent: number;
  cachePromptEnabled: boolean;
  cachePromptPrefixTurns: number;

  setApiKey: (key: string) => void;
  setBaseUrl: (url: string) => void;
  setTemperature: (temp: number) => void;
  setConfirmRiskyCommands: (val: boolean) => void;
  setSandboxIsolation: (val: boolean) => void;
  setCacheSemanticEnabled: (val: boolean) => void;
  setCacheSemanticThreshold: (val: number) => void;
  setCacheAttentionSinkEnabled: (val: boolean) => void;
  setCacheAttentionSinkKeepFirst: (val: number) => void;
  setCacheAttentionSinkKeepRecent: (val: number) => void;
  setCachePromptEnabled: (val: boolean) => void;
  setCachePromptPrefixTurns: (val: number) => void;
  saveSettings: () => void;
}

const STORAGE_KEY = 'ovolve_agent_settings';

function loadInitialSettings() {
  const DEFAULT_KEY = (import.meta as any).env?.VITE_SILICONFLOW_API_KEY || '';
  const DEFAULT_URL = (import.meta as any).env?.VITE_SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...parsed,
        apiKey: parsed.apiKey && parsed.apiKey.trim() ? parsed.apiKey.trim() : DEFAULT_KEY,
        baseUrl: parsed.baseUrl && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_URL,
      };
    }
  } catch {
    // Ignore
  }
  return {
    apiKey: DEFAULT_KEY,
    baseUrl: DEFAULT_URL,
    temperature: 0.2,
    confirmRiskyCommands: true,
    sandboxIsolation: true,
    // Cache defaults
    cacheSemanticEnabled: true,
    cacheSemanticThreshold: 0.85,
    cacheAttentionSinkEnabled: true,
    cacheAttentionSinkKeepFirst: 2,
    cacheAttentionSinkKeepRecent: 4,
    cachePromptEnabled: true,
    cachePromptPrefixTurns: 3,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const initial = loadInitialSettings();

  const persist = (partial: Partial<SettingsState>) => {
    try {
      const current = get();
      const next = { ...current, ...partial };
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          apiKey: next.apiKey,
          baseUrl: next.baseUrl,
          temperature: next.temperature,
          confirmRiskyCommands: next.confirmRiskyCommands,
          sandboxIsolation: next.sandboxIsolation,
          // Cache settings
          cacheSemanticEnabled: next.cacheSemanticEnabled,
          cacheSemanticThreshold: next.cacheSemanticThreshold,
          cacheAttentionSinkEnabled: next.cacheAttentionSinkEnabled,
          cacheAttentionSinkKeepFirst: next.cacheAttentionSinkKeepFirst,
          cacheAttentionSinkKeepRecent: next.cacheAttentionSinkKeepRecent,
          cachePromptEnabled: next.cachePromptEnabled,
          cachePromptPrefixTurns: next.cachePromptPrefixTurns,
        })
      );
    } catch {
      // Ignore
    }
  };

  return {
    apiKey: initial.apiKey,
    baseUrl: initial.baseUrl,
    temperature: initial.temperature,
    confirmRiskyCommands: initial.confirmRiskyCommands,
    sandboxIsolation: initial.sandboxIsolation,

    // Cache state
    cacheSemanticEnabled: initial.cacheSemanticEnabled ?? true,
    cacheSemanticThreshold: initial.cacheSemanticThreshold ?? 0.85,
    cacheAttentionSinkEnabled: initial.cacheAttentionSinkEnabled ?? true,
    cacheAttentionSinkKeepFirst: initial.cacheAttentionSinkKeepFirst ?? 2,
    cacheAttentionSinkKeepRecent: initial.cacheAttentionSinkKeepRecent ?? 4,
    cachePromptEnabled: initial.cachePromptEnabled ?? true,
    cachePromptPrefixTurns: initial.cachePromptPrefixTurns ?? 3,

    setApiKey: (apiKey) => {
      set({ apiKey });
      persist({ apiKey });
    },
    setBaseUrl: (baseUrl) => {
      set({ baseUrl });
      persist({ baseUrl });
    },
    setTemperature: (temperature) => {
      set({ temperature });
      persist({ temperature });
    },
    setConfirmRiskyCommands: (confirmRiskyCommands) => {
      set({ confirmRiskyCommands });
      persist({ confirmRiskyCommands });
    },
    setSandboxIsolation: (sandboxIsolation) => {
      set({ sandboxIsolation });
      persist({ sandboxIsolation });
    },

    // Cache setters
    setCacheSemanticEnabled: (cacheSemanticEnabled) => {
      set({ cacheSemanticEnabled });
      persist({ cacheSemanticEnabled });
    },
    setCacheSemanticThreshold: (cacheSemanticThreshold) => {
      set({ cacheSemanticThreshold });
      persist({ cacheSemanticThreshold });
    },
    setCacheAttentionSinkEnabled: (cacheAttentionSinkEnabled) => {
      set({ cacheAttentionSinkEnabled });
      persist({ cacheAttentionSinkEnabled });
    },
    setCacheAttentionSinkKeepFirst: (cacheAttentionSinkKeepFirst) => {
      set({ cacheAttentionSinkKeepFirst });
      persist({ cacheAttentionSinkKeepFirst });
    },
    setCacheAttentionSinkKeepRecent: (cacheAttentionSinkKeepRecent) => {
      set({ cacheAttentionSinkKeepRecent });
      persist({ cacheAttentionSinkKeepRecent });
    },
    setCachePromptEnabled: (cachePromptEnabled) => {
      set({ cachePromptEnabled });
      persist({ cachePromptEnabled });
    },
    setCachePromptPrefixTurns: (cachePromptPrefixTurns) => {
      set({ cachePromptPrefixTurns });
      persist({ cachePromptPrefixTurns });
    },

    saveSettings: () => {
      persist({});
    },
  };
});

export { useAgentStore } from './agentStore';
// Agent 领域类型随 R1 重构迁到了 types/agent.ts，这里统一从新家转出，
// 避免消费方各自记住“这个类型到底在 store 还是在 types”。
export type {
  Role,
  ToolStatus,
  ThoughtLevel,
  Message,
  ToolCall,
  ModelConfig,
  WorkspaceFolder,
} from '../types/agent';
export type { ReasoningPhase } from '../components/chat/ReasoningBlock';
// 注：ConnectionStatus / TurnStatus / SubAgent 曾在此转出，但 /src 内已无任何
// 定义与引用（随 agentStore 精简一并消失），继续保留只会让 barrel 导出不存在
// 的名字，故移除。

export { useSessionStore } from './sessionStore';
export type {
  Session,
  Workspace,
  SessionActivityState,
} from './sessionStore';

export { useThemeStore } from './themeStore';
export type { ThemeMode } from './themeStore';

export { useSettingsStore } from './settingsStore';
export type { SettingsState } from './settingsStore';

export { useLocaleStore, useI18n } from '../i18n';
export type { Locale, TranslationKey } from '../i18n';

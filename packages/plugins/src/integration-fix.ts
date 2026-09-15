/**
 * @oa/plugins — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type {
  IPlugin,
  PluginContext,
  HookPoint,
  RiskLevel,
  HookHandler,
  HookControl,
  PluginManifest,
  PluginManagerConfig,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  IPlugin,
  PluginContext,
  HookHandler,
  HookControl,
  PluginManifest,
  PluginManagerConfig,
};

export { HookPoint, RiskLevel } from './types';

// ---------------------------------------------------------------------------
// RiskLevel constants and helpers
// ---------------------------------------------------------------------------

export const RISK_LEVELS = {
  LOW: RiskLevel.LOW,
  MEDIUM: RiskLevel.MEDIUM,
  HIGH: RiskLevel.HIGH,
  CRITICAL: RiskLevel.CRITICAL,
} as const;

/**
 * Risk ordering for comparison.
 * Higher number = higher risk.
 */
export const RISK_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

/**
 * Compare two risk levels.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

/**
 * Check if a risk level exceeds a threshold.
 */
export function exceedsRiskLevel(level: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER[level] > RISK_ORDER[threshold];
}

/**
 * Parse a risk level from a string.
 */
export function parseRiskLevel(value: string): RiskLevel {
  const upper = value.toUpperCase();
  if (upper in RISK_LEVELS) {
    return RISK_LEVELS[upper as keyof typeof RISK_LEVELS];
  }
  throw new Error(`Invalid RiskLevel: ${value}`);
}

// ---------------------------------------------------------------------------
// HookPoint constants and helpers
// ---------------------------------------------------------------------------

export const HOOK_POINTS = {
  PRE_TOOL_USE: HookPoint.PRE_TOOL_USE,
  POST_TOOL_USE: HookPoint.POST_TOOL_USE,
  PRE_LLM_REQUEST: HookPoint.PRE_LLM_REQUEST,
  POST_LLM_RESPONSE: HookPoint.POST_LLM_RESPONSE,
  PRE_FOLD: HookPoint.PRE_FOLD,
  POST_FOLD: HookPoint.POST_FOLD,
  SESSION_START: HookPoint.SESSION_START,
  SESSION_END: HookPoint.SESSION_END,
  SUBAGENT_STOP: HookPoint.SUBAGENT_STOP,
} as const;

/**
 * Check if a string is a valid HookPoint.
 */
export function isHookPoint(value: string): value is HookPoint {
  return Object.values(HookPoint).includes(value as HookPoint);
}

/**
 * Parse a HookPoint from a string.
 */
export function parseHookPoint(value: string): HookPoint {
  if (isHookPoint(value)) {
    return value;
  }
  throw new Error(`Invalid HookPoint: ${value}`);
}

// ---------------------------------------------------------------------------
// Plugin factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a simple plugin from a manifest and register function.
 * Useful for creating lightweight plugins without defining a full class.
 */
export function createSimplePlugin(
  manifest: PluginManifest,
  registerFn: (registry: import('./types').HookRegistry, context: PluginContext) => Promise<void> | void
): IPlugin {
  return {
    manifest,
    async register(registry, context) {
      await registerFn(registry, context);
    },
  };
}

/**
 * Create a no-op plugin for testing.
 */
export function createNoOpPlugin(name: string): IPlugin {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: 'No-op plugin for testing',
    },
    register() {
      // No-op
    },
  };
}

// ---------------------------------------------------------------------------
// Type bridges for tool package integration
// ---------------------------------------------------------------------------

/**
 * Bridge type: ToolDefinition as expected by the plugins system.
 * The tools package uses a richer ToolDefinition; this is a simplified view.
 */
export interface PluginToolDefinition {
  name: string;
  description: string;
  riskLevel: RiskLevel;
}

/**
 * Bridge type: Tool call payload for hook handlers.
 */
export interface ToolCallPayload {
  toolName: string;
  args: Record<string, unknown>;
  scope?: string;
}

/**
 * Create a hook control that blocks an operation.
 */
export function blockOperation(reason: string): HookControl {
  return { blocked: true, reason };
}

/**
 * Create a hook control that allows an operation.
 */
export function allowOperation(): HookControl {
  return { blocked: false };
}

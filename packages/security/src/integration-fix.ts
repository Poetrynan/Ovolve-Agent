/**
 * @oa/security — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type { RiskLevel } from '@oa/plugins';
import type {
  SecurityPipelineConfig,
  PipelineResult,
  LayerResult,
  SecurityContext,
  PermissionMode,
  Verdict,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  SecurityPipelineConfig,
  PipelineResult,
  LayerResult,
  SecurityContext,
};

export { PermissionMode, Verdict } from './types';

// ---------------------------------------------------------------------------
// RiskLevel bridge — security package uses the same values as plugins package
// ---------------------------------------------------------------------------

/**
 * RiskLevel re-export from plugins package.
 * The security package defines its own RiskLevel enum with identical values.
 * This bridge ensures type compatibility.
 */
export type { RiskLevel } from '@oa/plugins';

/**
 * Convert security package RiskLevel to plugins package RiskLevel.
 * They have identical values, but TypeScript treats them as distinct types.
 */
export function toPluginsRiskLevel(level: RiskLevel): import('@oa/plugins').RiskLevel {
  return level as unknown as import('@oa/plugins').RiskLevel;
}

/**
 * Convert plugins package RiskLevel to security package RiskLevel.
 */
export function fromPluginsRiskLevel(level: import('@oa/plugins').RiskLevel): RiskLevel {
  return level as unknown as RiskLevel;
}

// ---------------------------------------------------------------------------
// ToolCall bridge
// ---------------------------------------------------------------------------

/**
 * Convert security package ToolCall to tools package ToolCall format.
 */
export function toToolsPackageToolCall(
  securityCall: import('./types').ToolCall
): import('@oa/tools').ToolCall {
  return {
    id: securityCall.id,
    name: securityCall.name,
    args: securityCall.arguments,
    timestamp: new Date(),
    status: 'PENDING' as import('@oa/tools').ToolCallStatus,
    context: securityCall.sessionId
      ? { sessionId: securityCall.sessionId }
      : undefined,
  };
}

/**
 * Convert tools package ToolCall to security package ToolCall format.
 */
export function fromToolsPackageToolCall(
  toolsCall: import('@oa/tools').ToolCall,
  sessionId: string
): import('./types').ToolCall {
  return {
    id: toolsCall.id,
    name: toolsCall.name,
    arguments: toolsCall.args,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// SecurityPipelineConfig helpers
// ---------------------------------------------------------------------------

/**
 * Default SecurityPipelineConfig.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityPipelineConfig = {
  permissionMode: PermissionMode.CONFIRM,
  workspaceRoot: process.cwd(),
  userHome: process.env.HOME ?? process.env.USERPROFILE ?? '',
  isRoot: process.getuid ? process.getuid() === 0 : false,
};

/**
 * Create a SecurityPipelineConfig with defaults.
 */
export function createSecurityConfig(
  overrides?: Partial<SecurityPipelineConfig>
): SecurityPipelineConfig {
  return {
    ...DEFAULT_SECURITY_CONFIG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PipelineResult helpers
// ---------------------------------------------------------------------------

/**
 * Check if a pipeline result allows execution.
 */
export function isAllowed(result: PipelineResult): boolean {
  return result.allowed && result.verdict === Verdict.ALLOW;
}

/**
 * Check if a pipeline result requires confirmation.
 */
export function needsConfirmation(result: PipelineResult): boolean {
  return result.verdict === Verdict.CONFIRM;
}

/**
 * Check if a pipeline result denies execution.
 */
export function isDenied(result: PipelineResult): boolean {
  return result.verdict === Verdict.DENY;
}

/**
 * Create a PipelineResult that allows execution.
 */
export function allowPipelineResult(
  riskLevel: RiskLevel = 'LOW' as RiskLevel,
  message: string = 'Operation allowed'
): PipelineResult {
  return {
    allowed: true,
    verdict: Verdict.ALLOW,
    riskLevel,
    layerResults: [],
    message,
    elapsedMs: 0,
  };
}

/**
 * Create a PipelineResult that denies execution.
 */
export function denyPipelineResult(
  riskLevel: RiskLevel = 'CRITICAL' as RiskLevel,
  message: string = 'Operation denied'
): PipelineResult {
  return {
    allowed: false,
    verdict: Verdict.DENY,
    riskLevel,
    layerResults: [],
    message,
    elapsedMs: 0,
  };
}

// ---------------------------------------------------------------------------
// SecurityContext helpers
// ---------------------------------------------------------------------------

/**
 * Create a SecurityContext with defaults.
 */
export function createSecurityContext(
  sessionId: string,
  overrides?: Partial<SecurityContext>
): SecurityContext {
  return {
    permissionMode: PermissionMode.CONFIRM,
    workspaceRoot: process.cwd(),
    userHome: process.env.HOME ?? process.env.USERPROFILE ?? '',
    isRoot: process.getuid ? process.getuid() === 0 : false,
    sessionId,
    previousResults: [],
    permissionRules: [],
    ...overrides,
  };
}

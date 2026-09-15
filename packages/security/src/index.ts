/**
 * @oa/security — Public exports
 * 
 * Ovolve's 7-layer defense-in-depth security system.
 * Layers: Sanitizer → Risk Controller → Tool Hooks → Output Guard → Danger Classifier → Path Guard
 */

// Types
export {
  RiskLevel,
  PermissionMode,
  Verdict,
  ToolCall,
  SecurityResult,
  PipelineResult,
  LayerResult,
  SecurityLayer,
  SecurityContext,
  PermissionRule,
  PathGuardConfig,
  DangerClassifierConfig,
  InterpreterType,
  ClassifierRule,
  RiskControllerConfig,
  OutputGuardConfig,
  SanitizerConfig,
  ToolHooksConfig,
  SecurityPipelineConfig,
  HookEvent,
  HookHandler,
  HookResult,
} from './types';

// Security layers
export { Sanitizer } from './layers/sanitizer';
export { RiskController } from './layers/risk-controller';
export { ToolHooks } from './layers/tool-hooks';
export { OutputGuard } from './layers/output-guard';
export { DangerClassifier } from './layers/danger-classifier';
export { PathGuard } from './layers/path-guard';

// Main SecurityPipeline class and factory
export { SecurityPipeline, createSecurityPipeline } from './security-pipeline';

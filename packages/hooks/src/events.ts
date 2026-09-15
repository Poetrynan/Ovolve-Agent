/**
 * @oa/hooks — Supported hook events
 *
 * Defines the 9 hook points in the agent lifecycle where external
 * scripts can be executed to observe or modify behavior.
 */

/**
 * The 9 supported hook events in the OvolveAgent lifecycle.
 *
 * - SessionStart: Fired when a new session begins
 * - UserPromptSubmit: Fired when the user submits a prompt
 * - PreToolUse: Fired before a tool is invoked
 * - PermissionRequest: Fired when permission is needed for a tool
 * - PostToolUse: Fired after a tool completes successfully
 * - PostToolUseFailure: Fired after a tool fails
 * - PreCompact: Fired before context compaction
 * - SubagentStop: Fired when a subagent completes
 * - Stop: Fired when the agent finishes its response
 */
export const HookEvent = {
  /** Session is starting — initialize resources, validate environment */
  SessionStart: 'SessionStart',
  /** User submitted a prompt — validate/modify input */
  UserPromptSubmit: 'UserPromptSubmit',
  /** About to execute a tool — approve/block/modify */
  PreToolUse: 'PreToolUse',
  /** Tool requires permission — approve/deny */
  PermissionRequest: 'PermissionRequest',
  /** Tool completed successfully — process results */
  PostToolUse: 'PostToolUse',
  /** Tool failed — handle error, suggest retry */
  PostToolUseFailure: 'PostToolUseFailure',
  /** About to compact context — preserve important info */
  PreCompact: 'PreCompact',
  /** Subagent finished — process subagent results */
  SubagentStop: 'SubagentStop',
  /** Agent finished response — cleanup, logging */
  Stop: 'Stop',
} as const;

/** Hook event type (union of all event string literals) */
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

/** All hook event names as an array */
export const ALL_HOOK_EVENTS: HookEvent[] = [
  HookEvent.SessionStart,
  HookEvent.UserPromptSubmit,
  HookEvent.PreToolUse,
  HookEvent.PermissionRequest,
  HookEvent.PostToolUse,
  HookEvent.PostToolUseFailure,
  HookEvent.PreCompact,
  HookEvent.SubagentStop,
  HookEvent.Stop,
];

/**
 * Check if a string is a valid hook event name.
 */
export function isHookEvent(value: string): value is HookEvent {
  return ALL_HOOK_EVENTS.includes(value as HookEvent);
}

/**
 * Get a human-readable description of a hook event.
 */
export function getEventDescription(event: HookEvent): string {
  switch (event) {
    case HookEvent.SessionStart:
      return 'Fired when a new session begins';
    case HookEvent.UserPromptSubmit:
      return 'Fired when the user submits a prompt';
    case HookEvent.PreToolUse:
      return 'Fired before a tool is invoked';
    case HookEvent.PermissionRequest:
      return 'Fired when permission is needed for a tool';
    case HookEvent.PostToolUse:
      return 'Fired after a tool completes successfully';
    case HookEvent.PostToolUseFailure:
      return 'Fired after a tool fails';
    case HookEvent.PreCompact:
      return 'Fired before context compaction';
    case HookEvent.SubagentStop:
      return 'Fired when a subagent completes';
    case HookEvent.Stop:
      return 'Fired when the agent finishes its response';
    default:
      return 'Unknown event';
  }
}

/**
 * Events that receive tool-specific context.
 */
export const TOOL_EVENTS: HookEvent[] = [
  HookEvent.PreToolUse,
  HookEvent.PermissionRequest,
  HookEvent.PostToolUse,
  HookEvent.PostToolUseFailure,
];

/**
 * Events that receive session context.
 */
export const SESSION_EVENTS: HookEvent[] = [
  HookEvent.SessionStart,
  HookEvent.UserPromptSubmit,
  HookEvent.Stop,
];

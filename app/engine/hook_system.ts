/**
 * hook_system.ts — Hook system (7 events).
 *
 * Ported from `app/backend/hook_system.py` (88 lines).
 *
 * Allows plugins to hook into key lifecycle events.
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（event_bus / result 已移植 → 静态 import）。
 *   §2  Result.failure(string) 单参调用保留（TS 签名的 meta 可选）。
 *   §4  naming: hook_system.py → hook_system.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { Result } from "./result.js";
import { getEventBus, type Event } from "./event_bus.js";

export class HookSystem {
  /** Hook system for 7 key events.
   *
   * Events:
   *   1. session_start             - When a new session starts
   *   2. session_end               - When a session ends
   *   3. tool_call                 - Before a tool is called
   *   4. tool_result               - After a tool returns
   *   5. pre_tool_use              - Before tool execution (risk control)
   *   6. output                    - Before output to user (guard)
   *   7. session_before_compact    - Before history compaction
   */
  static readonly EVENTS = [
    "session_start",
    "session_end",
    "tool_call",
    "tool_result",
    "pre_tool_use",
    "output",
    "session_before_compact",
  ] as const;

  bus = getEventBus();
  _hooks: Record<string, Array<(event: Event) => unknown>>;

  constructor() {
    this._hooks = {};
    for (const e of HookSystem.EVENTS) {
      this._hooks[e] = [];
    }
  }

  /** Register a hook for an event. */
  register(
    event_name: string,
    handler: (event: Event) => unknown,
    priority = 0
  ): Result<string> {
    if (!(HookSystem.EVENTS as readonly string[]).includes(event_name)) {
      return Result.failure(`Unknown event: ${event_name}`);
    }
    this._hooks[event_name]!.push(handler);
    this.bus.on(event_name, handler, priority);
    return Result.success(`Registered hook for: ${event_name}`);
  }

  /** Unregister a hook. */
  unregister(event_name: string, handler: (event: Event) => unknown): void {
    if (event_name in this._hooks) {
      this._hooks[event_name] = this._hooks[event_name]!.filter((h) => h !== handler);
      this.bus.off(event_name, handler);
    }
  }

  /** Trigger a hook event. */
  async trigger(event_name: string, payload?: Record<string, unknown>): Promise<Event> {
    return await this.bus.emit(event_name, payload);
  }

  /** Get registered hooks. */
  get_hooks(event_name?: string): Record<string, unknown> {
    if (event_name) {
      return { [event_name]: this._hooks[event_name] ?? [] };
    }
    return { ...this._hooks };
  }

  async on_session_start(session_id: string, user_info?: Record<string, unknown> | null): Promise<Event> {
    return await this.trigger("session_start", {
      session_id,
      user_info: user_info ?? {},
      timestamp: Date.now() / 1000,
    });
  }

  async on_session_end(session_id: string): Promise<Event> {
    return await this.trigger("session_end", {
      session_id,
      timestamp: Date.now() / 1000,
    });
  }

  async on_tool_call(tool_name: string, args: Record<string, unknown>): Promise<Event> {
    return await this.trigger("tool_call", {
      tool_name,
      args,
      timestamp: Date.now() / 1000,
    });
  }

  async on_tool_result(tool_name: string, result: unknown): Promise<Event> {
    return await this.trigger("tool_result", {
      tool_name,
      result: String(result).slice(0, 1000),
      timestamp: Date.now() / 1000,
    });
  }

  async on_pre_tool_use(
    tool_name: string,
    args: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<Event> {
    return await this.trigger("pre_tool_use", {
      tool_name,
      args,
      context,
    });
  }

  async on_output(text: string, user_intent: string): Promise<Event> {
    return await this.trigger("output", {
      text,
      user_intent,
      timestamp: Date.now() / 1000,
    });
  }

  async on_session_before_compact(session_id: string): Promise<Event> {
    return await this.trigger("session_before_compact", {
      session_id,
      timestamp: Date.now() / 1000,
    });
  }
}

let _hooks: HookSystem | null = null;

export function get_hook_system(): HookSystem {
  if (_hooks === null) {
    _hooks = new HookSystem();
  }
  return _hooks;
}

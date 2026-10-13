/**
 * prompt_cache_planner.ts — Prompt 缓存断点规划器 (TS port).
 *
 * 把「哪些字节稳定、哪些字节易变」的认知，变成 provider 的 cache_control
 * 断点。目标是让 provider 的 prefix cache 尽量命中：上一轮已经算过的稳定
 * 前缀和历史对话，这一轮不该再按全价重新计费。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { CACHE_CLASS_STABLE, PLACEMENT_SYSTEM } from "./prompt_layers.js";

export const CACHE_BREAKPOINT_KINDS: ReadonlySet<string> = new Set(["anthropic", "oauth"]);
export const CACHE_TTLS: ReadonlySet<string> = new Set(["", "1h"]);

export const REGISTRY_MAX_ENTRIES = 32;
export const REGISTRY_MAX_TOTAL_CHARS = 512 * 1024;

export interface CacheMarker {
  cache_control: {
    type: string;
    ttl?: string;
  };
}

export function _cache_marker(ttl = ""): CacheMarker {
  const marker: { type: string; ttl?: string } = { type: "ephemeral" };
  if (ttl) {
    marker.ttl = ttl;
  }
  return { cache_control: marker };
}

export interface CachePlan {
  readonly messages: any[];
  readonly breakpoints: readonly string[];
}

export class StablePrefixRegistry {
  private _maxEntries: number;
  private _maxTotalChars: number;
  private _entries: Map<string, string>;
  private _totalChars: number;

  constructor(
    maxEntries: number = REGISTRY_MAX_ENTRIES,
    maxTotalChars: number = REGISTRY_MAX_TOTAL_CHARS,
  ) {
    this._maxEntries = maxEntries;
    this._maxTotalChars = maxTotalChars;
    this._entries = new Map();
    this._totalChars = 0;
  }

  public register(key: string, prefix = ""): void {
    if (!key) return;
    const p = prefix || "";
    if (this._entries.has(key)) {
      this._totalChars -= this._entries.get(key)!.length;
      this._entries.delete(key);
    }
    this._entries.set(key, p);
    this._totalChars += p.length;

    while (this._entries.size > this._maxEntries) {
      const oldestKey = this._entries.keys().next().value;
      if (oldestKey !== undefined) {
        this._totalChars -= this._entries.get(oldestKey)!.length;
        this._entries.delete(oldestKey);
      }
    }

    while (this._totalChars > this._maxTotalChars && this._entries.size > 1) {
      const oldestKey = this._entries.keys().next().value;
      if (oldestKey !== undefined) {
        this._totalChars -= this._entries.get(oldestKey)!.length;
        this._entries.delete(oldestKey);
      }
    }
  }

  public get(key: string): string {
    return this._entries.get(key) ?? "";
  }

  public longest_match(text: string): [string, string] {
    let bestKey = "";
    let bestPrefix = "";
    if (!text) return [bestKey, bestPrefix];

    for (const [k, pfx] of this._entries.entries()) {
      if (pfx && text.startsWith(pfx)) {
        if (pfx.length > bestPrefix.length) {
          bestKey = k;
          bestPrefix = pfx;
        }
      }
    }
    return [bestKey, bestPrefix];
  }

  public size(): number {
    return this._entries.size;
  }
}

let _GLOBAL_REGISTRY: StablePrefixRegistry | null = null;

export function get_stable_prefix_registry(): StablePrefixRegistry {
  if (!_GLOBAL_REGISTRY) {
    _GLOBAL_REGISTRY = new StablePrefixRegistry(REGISTRY_MAX_ENTRIES, REGISTRY_MAX_TOTAL_CHARS);
  }
  return _GLOBAL_REGISTRY;
}

export function _split_system_prefix(
  msgs: any[],
  prefix: string,
): [any | null, string | null] {
  if (!msgs || msgs.length === 0) return [null, null];
  const first = msgs[0];
  if (!first || first.role !== "system") return [null, null];
  const content = first.content;
  if (typeof content !== "string") return [null, null];
  if (!prefix || !content.startsWith(prefix) || prefix.length >= content.length) {
    return [null, null];
  }
  return [first, content.slice(prefix.length)];
}

export function _apply_block_marker(msg: any, blockIndex: number, ttl = ""): any {
  if (!msg || typeof msg !== "object") return msg;
  const content = msg.content;
  let blocks: any[];
  if (typeof content === "string") {
    blocks = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    blocks = content.map((b: any) => ({ ...b }));
  } else {
    return msg;
  }

  const idx = blockIndex < 0 ? blocks.length + blockIndex : blockIndex;
  if (idx < 0 || idx >= blocks.length) {
    return msg;
  }

  const marker = _cache_marker(ttl);
  blocks[idx] = { ...blocks[idx], ...marker };
  return { ...msg, content: blocks };
}

export interface PlanCacheBreakpointsOptions {
  system_prefix?: string;
  kind?: string;
  system_tail?: boolean;
  scope?: string;
  ttl?: string;
}

export function plan_cache_breakpoints(
  msgs: any[],
  options: PlanCacheBreakpointsOptions = {},
): CachePlan {
  const system_prefix = options.system_prefix ?? "";
  const kind = (options.kind ?? "").toLowerCase();
  const system_tail = options.system_tail ?? false;
  const ttl = options.ttl ?? "";

  if (!CACHE_BREAKPOINT_KINDS.has(kind) || !CACHE_TTLS.has(ttl)) {
    return { messages: msgs, breakpoints: [] };
  }

  const marker = _cache_marker(ttl);
  const out = [...msgs];
  const placed: string[] = [];

  // 1. system 静态前缀断点
  if (system_prefix) {
    const [, rest] = _split_system_prefix(out, system_prefix);
    if (rest !== null) {
      out[0] = {
        role: "system",
        content: [
          { type: "text", text: system_prefix, ...marker },
          { type: "text", text: rest },
        ],
      };
      placed.push("system_prefix");
    }
  }

  // 2. system 末尾断点（可选）
  if (system_tail && out.length > 0 && out[0]?.role === "system") {
    const first = out[0];
    const content = first.content;
    if (typeof content === "string") {
      out[0] = {
        ...first,
        content: [{ type: "text", text: content, ...marker }],
      };
      placed.push("system_tail");
    } else if (Array.isArray(content) && content.length > 0) {
      const blocks = content.map((b: any) => ({ ...b }));
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...marker };
      out[0] = { ...first, content: blocks };
      placed.push("system_tail");
    }
  }

  // 3. 对话尾部断点
  const nonSystemIndices: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]?.role !== "system") {
      nonSystemIndices.push(i);
    }
  }

  if (nonSystemIndices.length >= 3) {
    const idx1 = nonSystemIndices[nonSystemIndices.length - 3]!;
    const idx2 = nonSystemIndices[nonSystemIndices.length - 2]!;
    for (const idx of [idx1, idx2]) {
      const item = out[idx];
      if (item && typeof item === "object") {
        out[idx] = _apply_block_marker(item, -1, ttl);
        placed.push(`tail:${idx}`);
      }
    }
  }

  return { messages: out, breakpoints: Object.freeze(placed) };
}

export function resolve_cache_scope(sessionId: string, lineageRoot?: string | null): string {
  return lineageRoot || sessionId || "";
}

export function resolve_effective_system_prefix(
  msgs: any[],
  explicitPrefix = "",
): string {
  const prefix = explicitPrefix || "";
  if (prefix && msgs && msgs.length > 0 && msgs[0]?.role === "system") {
    const content = msgs[0].content;
    if (typeof content === "string" && content.startsWith(prefix)) {
      return prefix;
    }
  }

  if (msgs && msgs.length > 0 && msgs[0]?.role === "system") {
    const content = msgs[0].content;
    if (typeof content === "string") {
      const [, matched] = get_stable_prefix_registry().longest_match(content);
      if (matched) {
        return matched;
      }
    }
  }

  return prefix;
}

export function stable_prefix_from_sections(sections?: any[] | null): string {
  const parts: string[] = [];
  for (const section of sections ?? []) {
    const placement = String(section?.placement ?? PLACEMENT_SYSTEM);
    if (placement !== PLACEMENT_SYSTEM) {
      continue;
    }
    const cache_class = String(section?.cache_class ?? "");
    if (cache_class !== CACHE_CLASS_STABLE) {
      break;
    }
    const body = String(section?.content ?? "").trim();
    if (body) {
      parts.push(body);
    }
  }
  return parts.join("\n\n");
}

export interface PlanSectionCacheBreakpointsOptions {
  kind: string;
  ttl?: string;
  scope?: string;
  system_tail?: boolean;
}

export function plan_section_cache_breakpoints(
  msgs: any[],
  sections: any[] | undefined | null,
  options: PlanSectionCacheBreakpointsOptions,
): CachePlan {
  return plan_cache_breakpoints(msgs, {
    system_prefix: stable_prefix_from_sections(sections),
    kind: options.kind,
    system_tail: options.system_tail ?? false,
    scope: options.scope ?? "",
    ttl: options.ttl ?? "",
  });
}

// CamelCase aliases
export const planCacheBreakpoints = plan_cache_breakpoints;
export const resolveEffectiveSystemPrefix = resolve_effective_system_prefix;
export const stablePrefixFromSections = stable_prefix_from_sections;
export const planSectionCacheBreakpoints = plan_section_cache_breakpoints;
export const getStablePrefixRegistry = get_stable_prefix_registry;

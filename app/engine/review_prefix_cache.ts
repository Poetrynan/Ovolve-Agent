/**
 * review_prefix_cache.ts — 评审 fork 的 prefix cache 策略
 *
 * Ported from `app/backend/review_prefix_cache.py` (45 lines).
 *
 * 同模型全文重放走 cache 读；异模型走摘要前缀，避免冷写整段历史。
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（prompt_cache_planner 是 SPLIT 单元 → computed-specifier
 *       动态 import，缺席时 scope 退化为 session_id 直用 —— 与源的
 *       ImportError 行为等价的降级，不改变返回形状）。
 *   §4  naming: review_prefix_cache.py → review_prefix_cache.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import type { JsonDict } from "./storage/storage_types.js";

/** prompt_cache_planner.resolve_cache_scope 的结构形状（SPLIT，未移植）。 */
type ResolveCacheScope = (session_id: string, lineage_root: string | null) => string;

async function resolve_cache_scope(session_id: string, lineage_root: string | null): Promise<string> {
  try {
    const spec = "./prompt_cache_planner" + ".js";
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
      resolve_cache_scope: ResolveCacheScope;
    };
    return mod.resolve_cache_scope(session_id, lineage_root);
  } catch {
    // ImportError-equivalent degrade: reuse the session id as scope.
    return session_id || "";
  }
}

export function same_model(source_model: string, review_model: string): boolean {
  return (source_model || "").trim().toLowerCase() === (review_model || "").trim().toLowerCase();
}

export async function plan_review_messages(kwargs: {
  source_model_id: string;
  review_model_id: string;
  messages: JsonDict[];
  cache_prefix: string;
  summary?: string;
  lineage_root?: string;
  session_id?: string;
}): Promise<[string, JsonDict[]]> {
  /** Return (effective_cache_prefix, messages_for_review). */
  const {
    source_model_id,
    review_model_id,
    messages,
    cache_prefix,
    summary = "",
    lineage_root = "",
    session_id = "",
  } = kwargs;
  const scope = await resolve_cache_scope(session_id, lineage_root || null);
  if (same_model(source_model_id, review_model_id) && cache_prefix.length >= 64) {
    return [cache_prefix, [...messages]];
  }
  if (summary) {
    const condensed: JsonDict[] = [
      { role: "system", content: `## Prior context summary\n${summary}` },
    ];
    condensed.push(...messages.slice(-6));
    return [`review:${scope}:summary`, condensed];
  }
  return [`review:${scope}`, messages.slice(-12)];
}

/** Fork 后 compactor 应锚定的谱系根（复用源会话 cache scope）。 */
export function lineage_for_fork(source_session_id: string): string {
  return source_session_id || "";
}

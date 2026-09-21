"""review_prefix_cache.py — 评审 fork 的 prefix cache 策略

同模型全文重放走 cache 读；异模型走摘要前缀，避免冷写整段历史。
"""
from __future__ import annotations

from typing import Optional

from prompt_cache_planner import resolve_cache_scope


def same_model(source_model: str, review_model: str) -> bool:
    return (source_model or "").strip().lower() == (review_model or "").strip().lower()


def plan_review_messages(
    *,
    source_model_id: str,
    review_model_id: str,
    messages: list[dict],
    cache_prefix: str,
    summary: str = "",
    lineage_root: str = "",
    session_id: str = "",
) -> tuple[str, list[dict]]:
    """Return (effective_cache_prefix, messages_for_review)."""
    scope = resolve_cache_scope(session_id, lineage_root or None)
    if same_model(source_model_id, review_model_id) and len(cache_prefix) >= 64:
        return cache_prefix, list(messages)
    if summary:
        condensed = [{"role": "system", "content": f"## Prior context summary\n{summary}"}]
        condensed.extend(messages[-6:])
        return f"review:{scope}:summary", condensed
    return f"review:{scope}", messages[-12:]


def lineage_for_fork(source_session_id: str) -> str:
    """Fork 后 compactor 应锚定的谱系根（复用源会话 cache scope）。"""
    return source_session_id or ""

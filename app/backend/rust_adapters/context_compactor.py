"""
rust_adapters/context_compactor.py - Drop-in replacement for backend/context_compactor.py.

Routes to ovolve_core.context_compactor when available, falls back to pure Python.
All public APIs are 100% compatible with the original module.
"""
from __future__ import annotations
from typing import Dict, List, Optional, Tuple

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import context_compactor as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

__all__ = [
    "estimate_tokens",
    "estimate_tokens_multi",
    "total_tokens",
    "usage_ratio",
    "should_fold",
    "find_turn_boundaries",
    "split_for_fold",
    "key_identifiers",
    "heuristic_summary",
    "audit_summary_quality",
    "compute_adaptive_chunk_ratio",
    "replace_oversized",
    "FoldLimitReached",
]


class FoldLimitReached(RuntimeError):
    """Too many consecutive folds."""
    pass


def _msg_content(msg) -> str:
    """Extract content from message (dict or Row)."""
    if isinstance(msg, dict):
        content = msg.get("content", "")
        if isinstance(content, list):
            # Multi-part content
            return " ".join(
                p.get("text", "") if isinstance(p, dict) else str(p)
                for p in content
            )
        return str(content) if content else ""
    return str(getattr(msg, "content", ""))


def estimate_tokens(text: str) -> int:
    """Estimate token count — delegates to token_estimate, the backend's
    single source of truth (wide chars x1 + ceil(rest/4), empty text = 0).

    token_estimate itself probes the Rust extension, so the Rust path is
    taken there; keeping this delegation (instead of a local copy) is what
    guarantees the numbers can never drift from the canonical algorithm.
    """
    import token_estimate as _te
    return _te.estimate_tokens(text)


def estimate_tokens_multi(messages: list) -> int:
    """Estimate total tokens for multiple messages."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        return _rust.estimate_tokens_multi(dict_msgs)

    return sum(estimate_tokens(_msg_content(m)) for m in messages)


def total_tokens(messages: list) -> int:
    """Calculate total token count."""
    return estimate_tokens_multi(messages)


def usage_ratio(messages: list, token_limit: int = 8192) -> float:
    """Calculate usage ratio given token limit."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        return _rust.usage_ratio(dict_msgs, token_limit)
    
    if token_limit <= 0:
        return 0.0
    return min(total_tokens(messages) / token_limit, 1.0)


def should_fold(messages: list, token_limit: int = 8192, threshold: float = 0.8) -> Tuple[bool, str]:
    """Check if folding is needed based on token usage."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        return _rust.should_fold(dict_msgs, token_limit, threshold)
    
    ratio = usage_ratio(messages, token_limit)
    if ratio >= threshold:
        return (True, f"usage={ratio:.0%} >= threshold={threshold:.0%}")
    return (False, f"usage={ratio:.0%} < threshold={threshold:.0%}")


def find_turn_boundaries(messages: list) -> List[int]:
    """Find turn start indices."""
    if _HAS_RUST:
        dict_msgs = [{"role": str(m.get("role", "")) if isinstance(m, dict) else str(getattr(m, "role", ""))} for m in messages]
        return _rust.find_turn_boundaries(dict_msgs)
    
    return [
        i for i, m in enumerate(messages)
        if (isinstance(m, dict) and m.get("role") == "user") or
           (hasattr(m, "role") and getattr(m, "role") == "user")
    ]


def split_for_fold(messages: list, keep_last_n: int = 4) -> Tuple[list, list]:
    """Split messages into [foldable_prefix, keep_tail]."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        prefix, tail = _rust.split_for_fold(dict_msgs, keep_last_n)
        # Convert back - but since we passed dicts, we get dicts back
        # Need to remap to original messages
        split_point = len(messages) - len(tail)
        return (messages[:split_point], messages[split_point:])
    
    if len(messages) <= keep_last_n:
        return ([], messages)
    split_point = len(messages) - keep_last_n
    return (messages[:split_point], messages[split_point:])


def key_identifiers(text: str, cap: int = 40) -> set:
    """Extract key identifiers (paths, URLs, etc)."""
    if _HAS_RUST:
        return set(_rust.key_identifiers(text, cap))
    
    ids = set()
    for word in text.split():
        if word.startswith('/') or word.startswith('http') or '\\' in word:
            ids.add(word)
        if len(ids) >= cap:
            break
    return ids


def heuristic_summary(messages: list) -> str:
    """Generate heuristic summary from messages."""
    if _HAS_RUST:
        dict_msgs = [
            {
                "role": str(m.get("role", "")) if isinstance(m, dict) else str(getattr(m, "role", "")),
                "content": _msg_content(m),
            }
            for m in messages
        ]
        return _rust.heuristic_summary(dict_msgs)
    
    parts = ["# Session Summary"]
    
    user_msgs = [
        _msg_content(m) for m in messages
        if (isinstance(m, dict) and m.get("role") == "user") or
           (hasattr(m, "role") and getattr(m, "role") == "user")
    ]
    
    if user_msgs:
        parts.append("## Topics discussed:")
        for i, msg in enumerate(user_msgs[:5]):
            preview = msg[:80] if len(msg) > 80 else msg
            parts.append(f"{i+1}. {preview}")
    
    all_text = " ".join(_msg_content(m) for m in messages)
    ids = key_identifiers(all_text, 20)
    if ids:
        parts.append("\n## Key references:")
        for id in list(ids)[:10]:
            parts.append(f"- {id}")
    
    return "\n".join(parts)


def audit_summary_quality(summary: str, original_messages: list) -> dict:
    """Check summary quality by verifying key identifier preservation."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in original_messages]
        return dict(_rust.audit_summary_quality(summary, dict_msgs))
    
    all_text = " ".join(_msg_content(m) for m in original_messages)
    original_ids = key_identifiers(all_text, 40)
    preserved = {id for id in original_ids if id in summary}
    
    coverage = len(preserved) / len(original_ids) if original_ids else 1.0
    
    return {
        "coverage": f"{coverage:.2f}",
        "preserved_count": str(len(preserved)),
        "total_count": str(len(original_ids)),
        "status": "pass" if coverage >= 0.8 else "warn",
    }


def compute_adaptive_chunk_ratio(messages: list, token_limit: int = 8192) -> float:
    """Calculate adaptive chunk ratio based on message sizes."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        return _rust.compute_adaptive_chunk_ratio(dict_msgs, token_limit)
    
    if not messages or token_limit <= 0:
        return 0.3
    
    avg_share = (total_tokens(messages) / len(messages)) / token_limit
    
    min_r, max_r = 0.15, 0.40
    min_s, max_s = 0.005, 0.10
    
    if avg_share <= min_s:
        return min_r
    elif avg_share >= max_s:
        return max_r
    t = (avg_share - min_s) / (max_s - min_s)
    return min_r + t * (max_r - min_r)


def replace_oversized(messages: list, max_tokens: int = 1000) -> Tuple[list, int]:
    """Replace oversized messages with placeholder notes."""
    if _HAS_RUST:
        dict_msgs = [{"content": _msg_content(m)} for m in messages]
        result, count = _rust.replace_oversized(dict_msgs, max_tokens)
        # Reconstruct with original message format
        replaced = []
        for i, r in enumerate(result):
            if estimate_tokens(_msg_content(messages[i])) > max_tokens:
                new_msg = dict(messages[i]) if isinstance(messages[i], dict) else {"content": _msg_content(messages[i])}
                new_msg["content"] = r.get("content", "")
                replaced.append(new_msg)
            else:
                replaced.append(messages[i])
        return (replaced, count)
    
    result = []
    count = 0
    for msg in messages:
        content = _msg_content(msg)
        if estimate_tokens(content) > max_tokens:
            new_msg = dict(msg) if isinstance(msg, dict) else {"content": content}
            new_msg["content"] = f"[Oversized content: {estimate_tokens(content)} tokens]"
            result.append(new_msg)
            count += 1
        else:
            result.append(msg)
    return (result, count)

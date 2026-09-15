"""
rust_adapters/storage_engine.py - Drop-in acceleration for storage.py performance functions.

Provides Rust-backed implementations of CPU-intensive storage operations:
- cosine_similarity: Vector similarity for semantic search
- keyword_score: Keyword matching for lexical search
- decode_embedding: Embedding blob decoding
- trust_of: Confidence extraction with bounds checking
- normalize_scores: Min-max normalization for score fusion
- fuse_scores: Weighted-sum fusion for hybrid search

Falls back to pure Python when Rust extension is unavailable.
All public APIs are 100% compatible with the original storage.py methods.
"""
from __future__ import annotations
import json
from typing import Any, Dict, List, Optional, Tuple

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import storage_engine as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

__all__ = [
    "cosine_similarity",
    "batch_cosine_similarity",
    "keyword_score",
    "decode_embedding",
    "trust_of",
    "normalize_scores",
    "fuse_scores",
]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length float vectors.
    
    Rust-backed when available for 5-10x speedup on large vectors.
    """
    if _HAS_RUST:
        return _rust.cosine_similarity(a, b)
    
    # Python fallback
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def batch_cosine_similarity(
    query: list[float], vectors: list[list[float]]
) -> list[tuple[int, float]]:
    """Compare query against multiple vectors, return sorted (index, score) pairs."""
    if _HAS_RUST:
        return _rust.batch_cosine_similarity(query, vectors)
    
    # Python fallback
    results = []
    for i, v in enumerate(vectors):
        score = cosine_similarity(query, v)
        if score > 0:
            results.append((i, score))
    results.sort(key=lambda x: -x[1])
    return results


def keyword_score(content: str, keywords: list[str]) -> int:
    """Count how many distinct keywords appear in content (case-insensitive)."""
    if _HAS_RUST:
        return _rust.keyword_score(content, keywords)
    
    # Python fallback
    if not content or not keywords:
        return 0
    low = content.lower()
    return sum(1 for kw in keywords if kw and kw.lower() in low)


def decode_embedding(blob: Any) -> Optional[list[float]]:
    """Decode a stored embedding blob back into a list of floats.
    
    Handles bytes (JSON string), str (JSON), and list/tuple inputs.
    """
    if _HAS_RUST:
        return _rust.decode_embedding(blob)
    
    # Python fallback
    if not blob:
        return None
    try:
        if isinstance(blob, (bytes, bytearray)):
            return json.loads(bytes(blob).decode("utf-8"))
        if isinstance(blob, str):
            return json.loads(blob)
        if isinstance(blob, (list, tuple)):
            return list(blob)
    except (ValueError, UnicodeDecodeError):
        return None
    return None


def trust_of(row: Optional[dict] = None, confidence: Optional[float] = None) -> float:
    """Extract confidence value from a row, with bounds checking.
    
    Returns 0.5 for missing/invalid values (the "don't know" midpoint).
    Accepts either a raw confidence value or a dict row.
    """
    if _HAS_RUST:
        if confidence is not None:
            return _rust.trust_of(confidence)
        elif row is not None:
            try:
                v = float(row.get("confidence"))
                return _rust.trust_of(v)
            except (TypeError, ValueError):
                return 0.5
        return _rust.trust_of(None)
    
    # Python fallback
    try:
        if confidence is not None:
            v = float(confidence)
        elif row is not None:
            v = float(row.get("confidence"))
        else:
            return 0.5
    except (TypeError, ValueError):
        return 0.5
    return v if 0.0 < v <= 1.0 else 0.5


def normalize_scores(
    scores: dict[str, float], higher_is_better: bool = True
) -> dict[str, float]:
    """Min-max normalize a score map into 0..1."""
    if _HAS_RUST:
        return dict(_rust.normalize_scores_py(scores, higher_is_better))
    
    # Python fallback
    if not scores:
        return {}
    vals = list(scores.values())
    min_v, max_v = min(vals), max(vals)
    range_v = max_v - min_v
    if range_v < 1e-10:
        return {k: 0.5 for k in scores}
    return {
        k: (v - min_v) / range_v if higher_is_better else (max_v - v) / range_v
        for k, v in scores.items()
    }


def fuse_scores(
    dense_scores: dict[str, float],
    sparse_scores: dict[str, float],
    dense_weight: float = 0.7,
    sparse_weight: float = 0.3,
    limit: Optional[int] = None,
) -> list[tuple[str, float, dict[str, float]]]:
    """Weighted-sum fusion over the union of both channels' candidate ids.
    
    Returns list of (id, fused_score, {"vec": v, "kw": w}) sorted by fused desc.
    """
    if _HAS_RUST:
        result = _rust.fuse_scores(dense_scores, sparse_scores, dense_weight, sparse_weight)
        if limit:
            return result[:limit]
        return result
    
    # Python fallback
    all_ids = set(dense_scores) | set(sparse_scores)
    fused = []
    for id in all_ids:
        d = dense_scores.get(id, 0.0)
        s = sparse_scores.get(id, 0.0)
        score = dense_weight * d + sparse_weight * s
        fused.append((id, score, {"vec": d, "kw": s}))
    fused.sort(key=lambda x: -x[1])
    if limit:
        return fused[:limit]
    return fused

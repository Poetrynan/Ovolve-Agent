"""
rust_adapters/memory_retrieval.py - Drop-in replacement for backend/memory_retrieval.py.

Routes to ovolve_core.memory_retrieval when available, falls back to pure Python.
All public APIs are 100% compatible with the original module.
"""
from __future__ import annotations
from typing import Dict, List, Optional, Sequence, Tuple

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import memory_retrieval as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

# Keep the nominal split in sync with backend/memory_retrieval.py (0.7/0.3).
# Literals instead of an import so this adapter stays dependency-free when the
# canonical module is unavailable.
_DEFAULT_VECTOR_WEIGHT = 0.7
_DEFAULT_KEYWORD_WEIGHT = 0.3

__all__ = [
    "is_cjk",
    "cjk_bigrams",
    "fts_document",
    "sanitize_term",
    "build_fts_query",
    "token_len",
    "split_sentences",
    "chunk_text",
    "normalize_scores",
    "fuse",
    "declare_channels",
    "describe_channels",
    "retrieval_trace",
]


def is_cjk(ch: str) -> bool:
    """True when a single character belongs to a CJK/Hangul block."""
    if _HAS_RUST:
        return _rust.is_cjk(ch)
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF or
        0x3400 <= cp <= 0x4DBF or
        0x20000 <= cp <= 0x2A6DF or
        0xF900 <= cp <= 0xFAFF or
        0xAC00 <= cp <= 0xD7AF or
        0x1100 <= cp <= 0x11FF or
        0x3040 <= cp <= 0x309F or
        0x30A0 <= cp <= 0x30FF
    )


def cjk_bigrams(text: str) -> List[str]:
    """Overlapping character bigrams for each CJK run in text."""
    if _HAS_RUST:
        return _rust.cjk_bigrams(text)

    result = []
    chars = list(text)
    i = 0
    while i < len(chars):
        if is_cjk(chars[i]):
            start = i
            while i < len(chars) and is_cjk(chars[i]):
                i += 1
            run = chars[start:i]
            for j in range(len(run) - 1):
                result.append(run[j] + run[j + 1])
        else:
            i += 1
    return result


def fts_document(text: str) -> str:
    """Render text into FTS5 document format."""
    if _HAS_RUST:
        return _rust.fts_document(text)

    bigrams = cjk_bigrams(text)
    if not bigrams:
        return text
    return f"{text} {' '.join(bigrams)}"


def sanitize_term(term: str) -> str:
    """Strip FTS5 operators from a term."""
    if _HAS_RUST:
        return _rust.sanitize_term(term)

    return ''.join(c for c in term if c not in '"*():^-+').strip()


def build_fts_query(text: str, keywords: Optional[Sequence[str]] = None) -> str:
    """Build an FTS5 MATCH expression from free text + optional keywords."""
    if _HAS_RUST:
        kw = list(keywords) if keywords else None
        return _rust.build_fts_query(text, kw)

    terms = []
    for word in sanitize_term(text).split():
        if any(is_cjk(c) for c in word):
            for bg in cjk_bigrams(word):
                terms.append(f'"{bg}"')
        elif word:
            terms.append(f'"{word}"')

    if keywords:
        for kw in keywords:
            s = sanitize_term(kw)
            if s:
                terms.append(f'"{s}"')

    return " OR ".join(terms) if terms else '""'


def token_len(text: str) -> int:
    """Token estimate for chunk budgeting."""
    if _HAS_RUST:
        return _rust.token_len(text)

    count = 0
    in_cjk = in_word = False
    for ch in text:
        if is_cjk(ch):
            count += 1
            in_cjk = in_word = True
        elif ch.isspace():
            in_cjk = in_word = False
        else:
            if not in_word:
                count += 1
                in_word = True
            in_cjk = False
    return max(count, 1)


def split_sentences(text: str) -> List[str]:
    """Split into sentence-ish spans."""
    if _HAS_RUST:
        return _rust.split_sentences(text)

    delimiters = set('。！？!?\n；;.')
    sentences = []
    current = []
    for ch in text:
        current.append(ch)
        if ch in delimiters:
            s = ''.join(current).strip()
            if s:
                sentences.append(s)
            current = []
    if current:
        s = ''.join(current).strip()
        if s:
            sentences.append(s)
    if not sentences and text:
        sentences.append(text)
    return sentences


def chunk_text(
    text: str,
    max_tokens: int = 256,
    overlap: int = 1,
) -> List[str]:
    """Split text into overlapping chunks at sentence boundaries."""
    if _HAS_RUST:
        return _rust.chunk_text(text, max_tokens, overlap)

    sentences = split_sentences(text)
    if not sentences:
        return []

    chunks = []
    current_chunk = []
    current_tokens = 0
    for sent in sentences:
        sent_tokens = token_len(sent)
        if current_tokens + sent_tokens > max_tokens and current_chunk:
            chunks.append(' '.join(current_chunk))
            overlap_start = max(0, len(current_chunk) - overlap)
            current_chunk = current_chunk[overlap_start:]
            current_tokens = sum(token_len(s) for s in current_chunk)
        current_chunk.append(sent)
        current_tokens += sent_tokens

    if current_chunk:
        chunks.append(' '.join(current_chunk))

    return chunks


def normalize_scores(
    scores: Dict[str, float],
    higher_is_better: bool = True,
) -> Dict[str, float]:
    """Min-max normalize scores into 0..1.

    Mirrors backend/memory_retrieval.normalize_scores: a single candidate, or a
    set where every score ties, normalizes to 1.0 — "the only thing I found"
    should not be scored 0.5 just because there is nothing to compare it
    against.
    """
    if _HAS_RUST:
        return dict(_rust.normalize_scores(scores, higher_is_better))

    if not scores:
        return {}

    vals = list(scores.values())
    min_v, max_v = min(vals), max(vals)
    range_v = max_v - min_v

    if range_v < 1e-10:
        return {k: 1.0 for k in scores}

    return {
        k: (v - min_v) / range_v if higher_is_better else (max_v - v) / range_v
        for k, v in scores.items()
    }


def _valid_fused(result) -> bool:
    """Shape-check a candidate fuse() return: [(id, score, {…}), …]."""
    return (
        isinstance(result, list)
        and all(
            isinstance(t, (tuple, list)) and len(t) == 3 and isinstance(t[2], dict)
            for t in result
        )
    )


def fuse(
    vector_scores: Dict[str, float],
    keyword_scores: Dict[str, float],
    vector_weight: float = _DEFAULT_VECTOR_WEIGHT,
    keyword_weight: float = _DEFAULT_KEYWORD_WEIGHT,
) -> List[Tuple[str, float, Dict[str, float]]]:
    """Weighted-sum fusion over the union of both channels' candidate ids.

    100% compatible with ``backend/memory_retrieval.fuse``: each channel is
    min-max normalized first, the weights renormalize when only one channel
    produced anything, and the return is ``[(id, fused, {"vec":…, "kw":…}), …]``
    sorted best-first — the per-channel breakdown storage.py re-ranks on and
    prints in its retrieval trace.
    """
    if _HAS_RUST:
        try:
            rust_out = _rust.fuse(vector_scores, keyword_scores, vector_weight, keyword_weight)
        except Exception:
            rust_out = None
        if _valid_fused(rust_out):
            return [(t[0], t[1], dict(t[2])) for t in rust_out]

    nv = normalize_scores(vector_scores, higher_is_better=True)
    nk = normalize_scores(keyword_scores, higher_is_better=True)

    wv, wk = vector_weight, keyword_weight
    if not nv and not nk:
        return []
    if not nv:
        wv, wk = 0.0, 1.0
    elif not nk:
        wv, wk = 1.0, 0.0
    else:
        total = wv + wk
        if total > 0:
            wv, wk = wv / total, wk / total

    out: List[Tuple[str, float, Dict[str, float]]] = []
    for key in set(nv) | set(nk):
        v = nv.get(key, 0.0)
        k = nk.get(key, 0.0)
        out.append((key, wv * v + wk * k, {"vec": v, "kw": k}))
    out.sort(key=lambda t: -t[1])
    return out


def declare_channels(
    vector_scores: Dict[str, float],
    keyword_scores: Dict[str, float],
    vector_weight: float = _DEFAULT_VECTOR_WEIGHT,
    keyword_weight: float = _DEFAULT_KEYWORD_WEIGHT,
    embedded_rows: int = None,
    total_rows: int = None,
) -> Dict[str, object]:
    """Which channels actually contributed to this search, and at what weight.

    100% compatible with ``backend/memory_retrieval.declare_channels``: the
    nominal 0.7/0.3 split is reported as a fact of the run (mode, effective
    weights, embedding coverage) rather than assumed from config.
    """
    if _HAS_RUST:
        try:
            rep = _rust.declare_channels(
                vector_scores, keyword_scores, vector_weight, keyword_weight,
                embedded_rows, total_rows,
            )
        except Exception:
            rep = None
        if isinstance(rep, dict) and "mode" in rep:
            return dict(rep)

    vec_live = bool(vector_scores)
    kw_live = bool(keyword_scores)
    wv, wk = vector_weight, keyword_weight
    if not vec_live and not kw_live:
        wv = wk = 0.0
        mode = "none"
    elif not vec_live:
        wv, wk = 0.0, 1.0
        mode = "keyword_only"
    elif not kw_live:
        wv, wk = 1.0, 0.0
        mode = "vector_only"
    else:
        total = wv + wk
        if total > 0:
            wv, wk = wv / total, wk / total
        mode = "hybrid"

    report: Dict[str, object] = {
        "mode": mode,
        "vectorLive": vec_live,
        "keywordLive": kw_live,
        "vectorCandidates": len(vector_scores),
        "keywordCandidates": len(keyword_scores),
        "effectiveVectorWeight": round(wv, 4),
        "effectiveKeywordWeight": round(wk, 4),
        "nominalVectorWeight": round(vector_weight, 4),
        "nominalKeywordWeight": round(keyword_weight, 4),
        "degraded": mode != "hybrid",
    }
    if total_rows is not None:
        report["rows"] = int(total_rows)
        report["embeddedRows"] = int(embedded_rows or 0)
        report["embeddingCoverage"] = (
            round((embedded_rows or 0) / total_rows, 4) if total_rows else 0.0
        )
        # The distinction the panel needs: a query that simply had no semantic
        # neighbours, versus a corpus that was never embedded at all.
        report["vectorUnavailable"] = not (embedded_rows or 0)
    return report


def describe_channels(report: Dict[str, object]) -> str:
    """One-line, human-readable form of :func:`declare_channels`."""
    if not report:
        return ""
    parts = [
        f"mode={report.get('mode')}",
        "vec={}({} cand, w={})".format(
            "on" if report.get("vectorLive") else "off",
            report.get("vectorCandidates", 0),
            report.get("effectiveVectorWeight", 0.0),
        ),
        "kw={}({} cand, w={})".format(
            "on" if report.get("keywordLive") else "off",
            report.get("keywordCandidates", 0),
            report.get("effectiveKeywordWeight", 0.0),
        ),
    ]
    if "embeddedRows" in report:
        parts.append(
            f"embedded={report['embeddedRows']}/{report.get('rows', 0)}"
        )
    return "channels: " + " ".join(parts)


def retrieval_trace(
    fused: Sequence[Tuple[str, float, Dict[str, float]]],
    limit: int = 10,
    channels: Dict[str, object] = None,
) -> List[str]:
    """Human-readable lines explaining why each candidate ranked where it did.

    100% compatible with ``backend/memory_retrieval.retrieval_trace``: takes
    the fused ``[(id, score, parts), …]`` list plus an optional channel
    declaration, and prints one "why" line per candidate.
    """
    if _HAS_RUST:
        try:
            tr = _rust.retrieval_trace(fused, limit, channels)
        except Exception:
            tr = None
        if isinstance(tr, list):
            return [str(x) for x in tr]

    lines: List[str] = []
    if channels:
        head = describe_channels(channels)
        if head:
            lines.append(head)
    for rank, (key, score, parts) in enumerate(fused[:limit], start=1):
        origin = (
            "both" if parts["vec"] > 0 and parts["kw"] > 0
            else "vector-only" if parts["vec"] > 0
            else "keyword-only"
        )
        lines.append(
            f"#{rank} {key} fused={score:.3f} "
            f"vec={parts['vec']:.3f} kw={parts['kw']:.3f} ({origin})"
        )
    return lines

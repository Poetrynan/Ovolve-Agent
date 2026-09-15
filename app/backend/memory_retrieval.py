"""C2 — Hybrid retrieval: dense vectors + FTS5 keyword search.

Why hybrid at all
-----------------
Dense embeddings and lexical search fail in *opposite* directions, which is
exactly why fusing them beats either alone:

- **Vectors miss exact tokens.** A query for ``ERR_MODULE_NOT_FOUND`` or
  ``router.py:1341`` embeds into roughly the same region as any other error
  string; cosine similarity cannot tell you the identifier matched verbatim.
  Rare, high-information tokens are precisely what embeddings smooth away.
- **Keywords miss paraphrase.** "怎么让它别再问我确认" and "关闭工具授权弹窗"
  share almost no tokens but mean the same thing. BM25 scores that pair at 0.

So: run both channels, normalize each to a comparable 0..1 range, then combine
with fixed weights. 0.7 vector / 0.3 keyword because paraphrase robustness is
the more common need in conversation. The 0.3 lexical weight is deliberately a
*tie-breaker and booster*, not an override: with min-max normalization the top
semantic doc always scores >= 0.7, so a keyword match cannot by itself vault a
semantically-irrelevant row to the top. What it does do is lift a row that is
*both* plausibly on-topic and an exact-token hit above an equally-semantic row
that missed the token — which is exactly the identifier case embeddings blur.

Why the CJK bigram trick
------------------------
SQLite's FTS5 ``unicode61`` tokenizer splits on Unicode whitespace/punctuation
categories. Han characters carry none of those, so an entire Chinese sentence
becomes **one token**. Searching "授权" against a document tokenized as
"关闭工具授权弹窗" matches nothing — the index holds one opaque 7-char term.

The fix used by every SQLite-based CJK search implementation is to index
overlapping character bigrams: "关闭工具授权" → "关闭 闭工 工具 具授 授权".
A query is bigram-ized the same way, so "授权" → "授权" hits the bigram that the
document also produced. It roughly triples index size for CJK text, which is an
easy trade for search that actually works.

ASCII words are left intact (bigramming "router" into "ro ou ut te er" would
destroy precision and explode the index), so the two schemes coexist in one
column: ASCII is tokenized normally, CJK runs are expanded to bigrams.

Chunking
--------
400-token chunks with 80-token (20%) overlap. Two reasons for chunking at all:

1. A 3000-token memory embedded as a single vector has its distinctive parts
   averaged into mush — the classic "one vector cannot represent a document"
   problem. Chunk-level vectors keep local meaning retrievable.
2. Overlap exists because a fact split across a chunk boundary is invisible to
   both chunks. 20% is the usual compromise: enough that a sentence-sized fact
   survives any single boundary, small enough that storage does not double.
"""

from __future__ import annotations

import math
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from token_estimate import estimate_tokens as _shared_estimate

# ---------------------------------------------------------------------------
# Fusion weights & retrieval parameters
# ---------------------------------------------------------------------------

#: Weight on the dense (embedding) channel. See module docstring for the 0.7/0.3
#: rationale. Must sum to 1.0 with ``KEYWORD_WEIGHT`` so the fused score stays
#: in 0..1 and is comparable against thresholds across queries.
VECTOR_WEIGHT = 0.7

#: Weight on the lexical (FTS5/BM25) channel.
KEYWORD_WEIGHT = 0.3

#: Over-sampling factor per channel before fusion. Each channel fetches
#: ``limit * OVERSAMPLE`` rows. Fusion can only rank what it was handed: if the
#: keyword channel only returned `limit` rows, a document ranked #6 lexically but
#: #1 semantically would never appear in the keyword score map and would lose
#: its 0.3 contribution entirely — turning "hybrid" back into "vector-only with
#: extra steps".
OVERSAMPLE = 4

#: Target chunk size in estimated tokens.
CHUNK_TOKENS = 400

#: Overlap between consecutive chunks, in estimated tokens (20% of CHUNK_TOKENS).
CHUNK_OVERLAP_TOKENS = 80

#: Below this fused score a candidate is dropped rather than injected. A memory
#: that matches nothing is worse than no memory: it spends context budget AND
#: actively misleads, because the model assumes anything injected is relevant.
MIN_FUSED_SCORE = 0.02

#: Han / Hiragana / Katakana / Hangul ranges. Anything here gets bigrammed.
_CJK_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+"
)

#: ASCII word run (letters, digits, underscore). Kept whole for FTS.
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")

#: FTS5 treats these as query syntax; they must never reach MATCH unquoted.
_FTS_SPECIAL = set('"*():^-+,')


def is_cjk(ch: str) -> bool:
    """True when a single character belongs to a CJK/Hangul block."""
    return bool(_CJK_RE.match(ch))


def cjk_bigrams(text: str) -> List[str]:
    """Overlapping character bigrams for each CJK run in ``text``.

    A run of length 1 yields itself (otherwise a single-character memory would
    be unindexable); runs of length >= 2 yield ``len - 1`` bigrams.

    >>> cjk_bigrams("关闭授权")
    ['关闭', '闭授', '授权']
    """
    out: List[str] = []
    for run in _CJK_RE.findall(text or ""):
        if len(run) == 1:
            out.append(run)
            continue
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
    return out


def fts_document(text: str) -> str:
    """Render ``text`` into the token soup stored in the FTS5 content column.

    ASCII words pass through lowercased; CJK runs are replaced by their bigrams.
    The result is intentionally *not* human-readable — it exists only to be
    tokenized by unicode61, and the original text stays in ``memory_entries``.
    """
    if not text:
        return ""
    words = [w.lower() for w in _WORD_RE.findall(text)]
    return " ".join(words + cjk_bigrams(text))


def _sanitize_term(term: str) -> str:
    """Strip FTS5 operators from a term so user text can never be query syntax.

    Without this, a memory query containing a bare ``-`` or an unbalanced quote
    raises ``sqlite3.OperationalError: fts5: syntax error`` and recall returns
    nothing — a user typing "cost-cap" would silently lose memory injection.
    """
    return "".join(ch for ch in term if ch not in _FTS_SPECIAL).strip()


def build_fts_query(text: str, keywords: Optional[Sequence[str]] = None) -> str:
    """Build an FTS5 MATCH expression from free text plus optional keywords.

    Terms are OR-joined, not AND-joined: memory recall wants *recall* (find
    anything related) and lets fusion + re-ranking handle precision. AND-joining
    is how the pre-C2 keyword search managed to return zero rows for any query
    longer than two words.

    Each term is double-quoted so it is treated as a literal phrase — this is
    the second half of the injection defence, since quoting neutralizes anything
    ``_sanitize_term`` did not strip.
    """
    terms: List[str] = []
    for w in _WORD_RE.findall(text or ""):
        if len(w) > 1:
            terms.append(w.lower())
    terms.extend(cjk_bigrams(text))
    for kw in keywords or ():
        cleaned = _sanitize_term(str(kw))
        if len(cleaned) > 1:
            terms.append(cleaned.lower())

    seen: set = set()
    quoted: List[str] = []
    for t in terms:
        t = _sanitize_term(t)
        if not t or t in seen:
            continue
        seen.add(t)
        quoted.append(f'"{t}"')
    return " OR ".join(quoted)


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def _token_len(text: str) -> int:
    """Token estimate for chunk budgeting.

    Used to be a hand-copied clone of ``memory_tiers.estimate_tokens`` so this
    module wouldn't depend on the tier system. Both now defer to
    ``token_estimate``, which has no dependencies at all — so the clone bought
    nothing and cost a divergence every time one copy was tuned.
    """
    return _shared_estimate(text)


#: Sentence boundaries used to avoid slicing mid-sentence. ASCII ``.`` only
#: terminates when followed by whitespace or end-of-string, so ``router.py`` and
#: ``0.75`` survive intact — the same fix D1's summary splitter needed.
_SENTENCE_END = re.compile(r"(?<=[。！？；\n])|(?<=[.!?;])(?=\s)")


def split_sentences(text: str) -> List[str]:
    """Split into sentence-ish spans, preserving all original characters."""
    if not text:
        return []
    parts = [p for p in _SENTENCE_END.split(text) if p]
    return parts or [text]


def chunk_text(
    text: str,
    chunk_tokens: int = CHUNK_TOKENS,
    overlap_tokens: int = CHUNK_OVERLAP_TOKENS,
) -> List[Dict]:
    """Split ``text`` into overlapping chunks at sentence boundaries.

    Returns dicts with ``index`` / ``text`` / ``tokens`` / ``start``.

    Packing is greedy over sentences: accumulate until adding the next sentence
    would exceed ``chunk_tokens``, emit, then re-seed the next chunk with
    trailing sentences worth up to ``overlap_tokens``. A single sentence longer
    than the budget is emitted alone rather than hard-sliced — cutting a long
    code block or stack trace mid-token produces a chunk that matches nothing.
    """
    if not text or not text.strip():
        return []
    total = _token_len(text)
    if total <= chunk_tokens:
        return [{"index": 0, "text": text, "tokens": total, "start": 0}]

    sentences = split_sentences(text)
    chunks: List[Dict] = []
    buf: List[str] = []
    buf_tokens = 0
    cursor = 0          # char offset of buf[0] within `text`
    consumed = 0        # char offset just past the last consumed sentence

    def flush() -> None:
        nonlocal buf, buf_tokens, cursor
        if not buf:
            return
        body = "".join(buf)
        chunks.append({
            "index": len(chunks),
            "text": body,
            "tokens": buf_tokens,
            "start": cursor,
        })
        # Re-seed with the tail of this chunk so a fact spanning the boundary
        # is fully present in at least one chunk.
        tail: List[str] = []
        tail_tokens = 0
        for s in reversed(buf):
            t = _token_len(s)
            if tail_tokens + t > overlap_tokens and tail:
                break
            tail.insert(0, s)
            tail_tokens += t
        cursor = consumed - len("".join(tail))
        buf = list(tail)
        buf_tokens = tail_tokens

    for sent in sentences:
        st = _token_len(sent)
        if buf and buf_tokens + st > chunk_tokens:
            flush()
        buf.append(sent)
        buf_tokens += st
        consumed += len(sent)
        if buf_tokens >= chunk_tokens:
            flush()

    if buf:
        body = "".join(buf)
        # After a flush the buffer may hold only re-seeded overlap, which is
        # already fully contained in the previous chunk. Emitting it would be a
        # pure duplicate that then competes with its own parent during fusion.
        if not chunks or body not in chunks[-1]["text"]:
            chunks.append({
                "index": len(chunks),
                "text": body,
                "tokens": buf_tokens,
                "start": cursor,
            })
    return chunks


# ---------------------------------------------------------------------------
# Score normalization & fusion
# ---------------------------------------------------------------------------

def normalize_scores(scores: Dict[str, float], higher_is_better: bool = True) -> Dict[str, float]:
    """Min-max normalize a score map into 0..1.

    Required because the two channels are not on the same scale: cosine
    similarity lives in roughly 0..1 while FTS5 ``bm25()`` returns *negative*
    numbers of unbounded magnitude (more negative = better). Weighting raw
    values would let BM25's magnitude swamp the vector channel entirely,
    regardless of the weights.

    A single candidate, or a set where every score ties, normalizes to 1.0 —
    "the only thing I found" should not be scored 0 just because there is
    nothing to compare it against.
    """
    if not scores:
        return {}
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if math.isclose(lo, hi):
        return {k: 1.0 for k in scores}
    span = hi - lo
    if higher_is_better:
        return {k: (v - lo) / span for k, v in scores.items()}
    return {k: (hi - v) / span for k, v in scores.items()}


def fuse(
    vector_scores: Dict[str, float],
    keyword_scores: Dict[str, float],
    vector_weight: float = VECTOR_WEIGHT,
    keyword_weight: float = KEYWORD_WEIGHT,
) -> List[Tuple[str, float, Dict[str, float]]]:
    """Weighted-sum fusion over the union of both channels' candidate ids.

    Returns ``[(id, fused, {"vec":…, "kw":…}), …]`` sorted best-first. The
    per-channel breakdown is kept because "why was this recalled?" is otherwise
    unanswerable, and a fused score alone makes tuning the weights guesswork.

    Union, not intersection: a document found by only one channel keeps that
    channel's contribution and scores 0 on the other. Intersecting would throw
    away exactly the cases hybrid retrieval exists to catch — the verbatim
    identifier match that embeddings missed, and the paraphrase that BM25 could
    not see.

    Degenerate inputs are handled by renormalizing the weights rather than
    silently halving every score: when only one channel produced anything, that
    channel is the entire signal and its results should span the full 0..1
    range, not top out at 0.7.
    """
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
    vector_weight: float = VECTOR_WEIGHT,
    keyword_weight: float = KEYWORD_WEIGHT,
    embedded_rows: int = None,
    total_rows: int = None,
) -> Dict[str, object]:
    """Which channels actually contributed to this search, and at what weight.

    The nominal 0.7 / 0.3 split describes the *design*, not necessarily the run.
    If no row in the workspace carries an embedding, the dense channel returns
    nothing and :func:`fuse` renormalizes to pure lexical — correct behaviour,
    but until now completely invisible: the panel showed "hybrid retrieval, 0.7
    vector" while the vector channel had never scored a single document, and MMR
    diversity re-ranking was silently inert for the same reason.

    So the fusion result is reported as a fact rather than assumed from config.
    ``embedded_rows`` / ``total_rows`` are optional and turn "the vector channel
    found nothing for this query" into the more useful "there is nothing for it
    to find", which points at a backfill instead of at the query.
    """
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

    Mirrors B4's audit trail: a retrieval you cannot explain is a retrieval you
    cannot debug when the model starts citing an irrelevant memory.

    When ``channels`` is supplied its declaration leads the trace, because "this
    ranking came out of the lexical channel alone" reframes every line under it.
    """
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

"""
rust_adapters/wiki_engine.py - Drop-in acceleration for wiki_store.py text processing.

Provides Rust-backed implementations of text processing operations:
- normalize_text: Case-fold + whitespace-collapse
- subject_predicate_key: Stable grouping key generation
- has_negation: Negation marker detection
- triple_from_text: SPO triple extraction from natural language
- detect_conflicts: Two-stage contradiction detection

Falls back to pure Python when Rust extension is unavailable.
All public APIs are 100% compatible with the original wiki_store.py functions.
"""
from __future__ import annotations
import re
from typing import List, Optional, Tuple

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import wiki_engine as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

__all__ = [
    "normalize_text",
    "subject_predicate_key",
    "has_negation",
    "triple_from_text",
    "detect_conflicts",
]

# Python fallback patterns (from wiki_store.py)
_WS = re.compile(r"\s+")

# Negation markers
_NEGATION_MARKERS = [
    "not ", "no ", "don't", "doesn't", "didn't", "won't", "can't",
    "never", "neither", "nobody", "nothing", "nowhere",
    "不", "没", "没有", "不是", "别", "未", "无", "非",
]

# Triple extraction patterns
_TRIPLE_PATTERNS = tuple(
    (subj, pred, re.compile(pat, re.IGNORECASE))
    for subj, pred, pat in (
        ("用户", "名字", r"\s*my name is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "名字", r"\s*我(?:的名字)?(?:不|并不)?(?:就)?叫\s*(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "工作单位", r"\s*i (?:don't |do not )?work at\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "工作单位", r"\s*我(?:不|没|没有|已经不)?在\s*(.{1,40}?)\s*工作\s*[.。!！]?\s*"),
        ("用户", "时区", r"\s*my timezone is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "时区", r"\s*我(?:的)?时区(?:不)?是\s*(.{1,40}?)\s*[.。!！]?\s*"),
    )
)

# Object reject pattern (half-sentence detection)
_OBJECT_REJECT = re.compile(r"[，,。；;！!？?\n、]")


def normalize_text(text: str) -> str:
    """Case-fold + whitespace-collapse. Used for subject/predicate key generation.
    
    Deliberately does NOT stem or expand synonyms.
    """
    if _HAS_RUST:
        return _rust.normalize_text(text)
    
    # Python fallback
    if not text:
        return ""
    return _WS.sub(" ", text.strip().casefold())


def subject_predicate_key(subject: str, predicate: str) -> str:
    """Stable hash used as the "same attribute" grouping key."""
    if _HAS_RUST:
        return _rust.subject_predicate_key(subject, predicate)
    
    # Python fallback
    s = normalize_text(subject)
    p = normalize_text(predicate)
    return f"{s}::{p}"


def has_negation(text: str) -> bool:
    """True when text contains any of the tracked negation markers.
    
    Case-insensitive for ASCII, exact for CJK.
    """
    if _HAS_RUST:
        return _rust.has_negation(text)
    
    # Python fallback
    if not text:
        return False
    low = text.casefold()
    return any(m in low for m in _NEGATION_MARKERS)


def triple_from_text(text: str) -> Optional[tuple[str, str, str]]:
    """Parse a sentence into (subject, predicate, object) triple.
    
    Returns None if no pattern matches.
    Uses full-match with length limits and half-sentence rejection.
    """
    if _HAS_RUST:
        return _rust.triple_from_text(text)
    
    # Python fallback
    s = str(text or "").strip()
    if not s:
        return None
    for subject, predicate, pat in _TRIPLE_PATTERNS:
        m = pat.fullmatch(s)
        if not m:
            continue
        obj = (m.group(1) or "").strip(" \t、，,：:")
        if not obj or _OBJECT_REJECT.search(obj):
            continue
        return subject, predicate, obj
    return None


def detect_conflicts(
    new_object: str,
    new_statement: str,
    peers: list[tuple[str, str, str]],
) -> list[str]:
    """Two-stage contradiction check (structural -> textual).
    
    Args:
        new_object: Object value of the new claim
        new_statement: Full statement text (for negation detection)
        peers: List of (object, statement, id) tuples for existing claims
    
    Returns:
        List of peer IDs that conflict with the new claim
    """
    if _HAS_RUST:
        return _rust.detect_conflicts(new_object, new_statement, peers)
    
    # Python fallback
    conflicts = []
    new_obj_norm = normalize_text(new_object)
    new_negated = has_negation(new_statement)
    
    for peer_obj, peer_stmt, peer_id in peers:
        peer_obj_norm = normalize_text(peer_obj)
        # Structural: same s+p, different object (both non-empty)
        if new_obj_norm and peer_obj_norm and new_obj_norm != peer_obj_norm:
            conflicts.append(peer_id)
            continue
        # Textual: negation mismatch
        if new_negated != has_negation(peer_stmt):
            conflicts.append(peer_id)
    
    return conflicts

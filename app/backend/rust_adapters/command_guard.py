"""
rust_adapters/command_guard.py - Drop-in acceleration for command_classifier.py primitives.

Provides Rust-backed implementations of the shell command security
grading primitives:
- split_segments: Split command text by control operators (|, &, ;, newlines)
- tokenize: Tokenize one segment (whitespace split + shell-meta stripping)
- fetch_pipe_exec: Detect remote fetch-and-execute shape inside one segment
- extract_hosts: Extract IPv4/domain hosts in order of first appearance
- domain_suffix_match: Full-label suffix match against allow/deny lists

Falls back to pure Python when the Rust extension is unavailable.
The fallback is semantically identical to the Rust implementation
(app/backend/rust_core/src/command_guard/mod.rs) — same separators,
same meta characters, same regexes — so grading verdicts are stable
across backends.
"""
from __future__ import annotations

import re
from typing import Iterable, List, Optional, Sequence

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import command_guard as _rust
    _HAS_RUST = True
except ImportError:
    try:
        from ovolve_core import command_guard as _rust
        _HAS_RUST = True
    except ImportError:
        _rust = None
        _HAS_RUST = False

__all__ = [
    "split_segments",
    "tokenize",
    "fetch_pipe_exec",
    "extract_hosts",
    "domain_suffix_match",
]

#: Shell metacharacters stripped from token edges (mirrors TOKEN_META in Rust).
_TOKEN_META = "\"'`$(){}<>|;&\\"

#: IPv4 literal pattern (mechanical: no octet range validation — same as Rust).
_RE_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

#: Domain pattern: dot-joined labels ending in an alphabetic TLD (same as Rust).
_RE_DOMAIN = re.compile(r"\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b", re.I)


def split_segments(text: str) -> List[str]:
    """Split command text into segments by shell control operators.

    Separators: ``|``, ``&``, ``;``, newlines (covers ``||``/``&&`` as
    repeated chars). Whitespace-only segments are dropped. Redirections
    are NOT separators — they belong to a command.
    """
    if _HAS_RUST:
        return _rust.split_segments(text)

    # Python fallback — identical semantics
    return [
        seg.strip()
        for seg in re.split(r"[|&;\n\r]", text)
        if seg.strip()
    ]


def tokenize(segment: str) -> List[str]:
    """Tokenize one command segment: whitespace split + shell meta stripping.

    ``sh -c "$(curl x)"`` → ["sh", "-c", "curl", "x"]. Does not lowercase.
    """
    if _HAS_RUST:
        return _rust.tokenize(segment)

    # Python fallback — identical semantics
    tokens = []
    for raw in segment.split():
        t = raw.strip(_TOKEN_META)
        if t:
            tokens.append(t)
    return tokens


def fetch_pipe_exec(
    segment: str,
    fetchers: Sequence[str],
    executors: Sequence[str],
) -> bool:
    """Detect the "remote fetch then direct execute" shape inside ONE segment.

    True when the segment contains both a fetcher token and an executor
    token (case-insensitive). Pipelines are split into separate segments
    by split_segments; what remains in a single segment is command
    substitution / process substitution — exactly this shape.
    """
    if _HAS_RUST:
        return _rust.fetch_pipe_exec(segment, list(fetchers), list(executors))

    # Python fallback — identical semantics
    lowered = [t.lower() for t in tokenize(segment)]
    fetchers_l = {str(f).lower() for f in fetchers}
    executors_l = {str(e).lower() for e in executors}
    has_fetcher = any(t in fetchers_l for t in lowered)
    has_executor = any(t in executors_l for t in lowered)
    return has_fetcher and has_executor


def extract_hosts(text: str) -> List[str]:
    """Extract hosts (IPv4 literals + domain names) from command text.

    Order of first appearance, deduplicated, lowercased. Conservative by
    design: version-like tokens may surface as hosts — an egress false
    positive raises REVIEW, a missed host never does.
    """
    if _HAS_RUST:
        return _rust.extract_hosts(text)

    # Python fallback — identical semantics
    found: list[tuple[int, str]] = []
    for m in _RE_IPV4.finditer(text):
        found.append((m.start(), m.group(0).lower()))
    for m in _RE_DOMAIN.finditer(text):
        found.append((m.start(), m.group(0).lower()))
    found.sort(key=lambda x: x[0])

    hosts: List[str] = []
    for _, h in found:
        if h not in hosts:
            hosts.append(h)
    return hosts


def domain_suffix_match(host: str, domains: Iterable[str]) -> Optional[str]:
    """Match a host against domain-suffix rules (allow/deny lists).

    Returns the matched rule (truthy) or None. Full-label suffix
    semantics: ``sub.evil.com`` matches rule ``evil.com``;
    ``notevil.com`` does NOT match rule ``evil.com``.
    """
    domains = list(domains)
    if _HAS_RUST:
        return _rust.domain_suffix_match(host, domains)

    # Python fallback — identical semantics
    h = host.strip().strip(".").lower()
    for d in domains:
        d = str(d).strip().strip(".").lower()
        if not d:
            continue
        if h == d or h.endswith("." + d):
            return d
    return None

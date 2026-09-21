"""aider_parser.py — SEARCH/REPLACE parsing + indentation-tolerant matching.

基于
hardened for the agent runtime. The harness version only understood a bare

    <<<<<<< SEARCH ... ======= ... >>>>>>>

fence and gave the model exactly one second chance (``search_chunk.strip()``),
which silently fails on the single most common LLM defect: the SEARCH body is
correct but its *leading indentation* drifted (model re-indents to column 0, or
adds one level because it thinks the hunk lives inside a class).

What this module adds on top of the harness logic:

  * ``{path}`` header capture, so one response can edit several files, with
    ``` fences and backticks tolerated around the path line.
  * Indentation-drift realignment: the SEARCH body is dedented, matched against
    a dedented window of the file, and the REPLACE body is re-indented to the
    *file's* actual indentation before being spliced back in.
  * Levenshtein similarity scoring identical to ``crates/ovolve_core``
    (``levenshtein_distance`` / ``compute_similarity`` / ``replace_file_content_fast``),
    used as the last-resort tolerant match above a similarity threshold.

Backend: the Rust extension is used when ``ovolve_core`` is importable and
exposes the matcher. It is NOT built on most dev machines, so every code path
here degrades to the pure-Python implementation below — same algorithm, same
numbers, just slower.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Optional

#: Below this similarity a tolerant match is refused rather than guessed at.
DEFAULT_SIMILARITY_THRESHOLD = 0.8

#: Auto-diagnosis candidate lines are reported down to this similarity so the
#: model can self-heal in one step (mirrors the 0.55 gate in ovolve_core).
DIAGNOSTIC_SIMILARITY_FLOOR = 0.55


# ── Rust backend resolution (graceful degradation) ────────────────────────

def _load_rust_core():
    """Return the ovolve_core extension if it exposes the matcher, else None."""
    try:
        import ovolve_core as mod
    except Exception:
        return None
    if hasattr(mod, "replace_file_content_fast"):
        return mod
    return None


_RUST_CORE = _load_rust_core()


def rust_available() -> bool:
    """True when the ovolve_core Rust matcher can actually be called."""
    return _RUST_CORE is not None


def backend_name() -> str:
    """Name of the active similarity backend, for structured tool results."""
    return "ovolve_core" if _RUST_CORE is not None else "python-levenshtein"


# ── Similarity primitives (mirror crates/ovolve_core/src/lib.rs) ──────────

def levenshtein_distance(s1: str, s2: str) -> int:
    """Edit distance over code points. Two-row DP: O(min(n,m)) memory."""
    if s1 == s2:
        return 0
    a = list(s1)
    b = list(s2)
    if not a:
        return len(b)
    if not b:
        return len(a)
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[len(b)]


def compute_similarity(s1: str, s2: str) -> float:
    """Whitespace-insensitive similarity in [0,1] — same rules as the Rust core.

    Whitespace is stripped before comparing precisely because indentation drift
    is what we are trying to see through; containment scores 0.85 so a correct
    line that merely gained a trailing comment still ranks above noise.
    """
    clean1 = re.sub(r"\s+", "", s1)
    clean2 = re.sub(r"\s+", "", s2)
    if not clean1 or not clean2:
        return 0.0
    if clean1 == clean2:
        return 1.0
    if clean1 in clean2 or clean2 in clean1:
        return 0.85
    max_len = max(len(clean1), len(clean2))
    if max_len == 0:
        return 1.0
    if _RUST_CORE is not None:
        try:
            dist = int(_RUST_CORE.levenshtein_distance(clean1, clean2))
        except Exception:
            dist = levenshtein_distance(clean1, clean2)
    else:
        dist = levenshtein_distance(clean1, clean2)
    return max(0.0, 1.0 - dist / max_len)


# ── Block parsing ─────────────────────────────────────────────────────────

@dataclass
class AiderBlock:
    """One SEARCH/REPLACE edit, optionally addressed at a specific file."""

    search: str
    replace: str
    path: str = ""
    index: int = 0


_SEARCH_FENCE = re.compile(r"^\s*<{5,9}\s*SEARCH\s*$")
_DIVIDER_FENCE = re.compile(r"^\s*={5,9}\s*$")
_REPLACE_FENCE = re.compile(r"^\s*>{5,9}\s*(?:REPLACE)?\s*$")
_CODE_FENCE = re.compile(r"^\s*`{3,}[\w+.-]*\s*$")
_PATH_CHARS = re.compile(r"^[\w./\\@:+~-]+$")


def _clean_path_candidate(line: str) -> str:
    """Return a plausible file path from a header line, or "" if it isn't one."""
    s = line.strip().strip("`").strip().rstrip(":").strip()
    if not s or len(s) > 400:
        return ""
    # Markdown noise ("### file:", "Here is the fix") is not a path.
    if not _PATH_CHARS.match(s):
        return ""
    if "." not in s and "/" not in s and "\\" not in s:
        return ""
    return s


def parse_aider_blocks(text: str) -> list[AiderBlock]:
    """Parse every SEARCH/REPLACE block in ``text``.

    Line-based rather than one big DOTALL regex: the harness regex could not
    tell a ``{path}`` header from prose, and a greedy ``.*?`` across several
    blocks silently welds them together when a divider is missing.
    """
    if not text:
        return []
    blocks: list[AiderBlock] = []
    path_candidate = ""
    state = "idle"
    search_lines: list[str] = []
    replace_lines: list[str] = []
    current_path = ""

    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if state == "idle":
            if _SEARCH_FENCE.match(raw):
                state = "search"
                search_lines = []
                replace_lines = []
                current_path = path_candidate
                continue
            if _CODE_FENCE.match(raw):
                # A fence between the path line and the SEARCH marker is normal
                # Aider output; keep the candidate alive across it.
                continue
            cand = _clean_path_candidate(raw)
            if cand:
                path_candidate = cand
            continue
        if state == "search":
            if _DIVIDER_FENCE.match(raw):
                state = "replace"
                continue
            search_lines.append(raw)
            continue
        # state == "replace"
        if _REPLACE_FENCE.match(raw):
            blocks.append(
                AiderBlock(
                    search="\n".join(search_lines),
                    replace="\n".join(replace_lines),
                    path=current_path,
                    index=len(blocks),
                )
            )
            state = "idle"
            path_candidate = ""
            continue
        replace_lines.append(raw)

    # Unterminated trailing block: keep it rather than dropping the edit
    # silently — the caller can still match it and will hear about failures.
    if state == "replace":
        blocks.append(
            AiderBlock(
                search="\n".join(search_lines),
                replace="\n".join(replace_lines),
                path=current_path,
                index=len(blocks),
            )
        )
    return blocks


def has_aider_block(text: str) -> bool:
    """Cheap probe: does this text contain a SEARCH/REPLACE fence at all?"""
    if not text:
        return False
    return any(_SEARCH_FENCE.match(ln) for ln in text.splitlines())


# ── Indentation helpers ───────────────────────────────────────────────────

def _leading_ws(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


def common_indent(lines: Iterable[str]) -> str:
    """Longest leading-whitespace prefix shared by all non-blank lines."""
    prefix: Optional[str] = None
    for line in lines:
        if not line.strip():
            continue
        ws = _leading_ws(line)
        if prefix is None:
            prefix = ws
            continue
        i = 0
        limit = min(len(prefix), len(ws))
        while i < limit and prefix[i] == ws[i]:
            i += 1
        prefix = prefix[:i]
        if not prefix:
            break
    return prefix or ""


def dedent_block(lines: list[str]) -> tuple[list[str], str]:
    """Remove the common indentation; return (dedented lines, removed prefix)."""
    prefix = common_indent(lines)
    if not prefix:
        return list(lines), ""
    out = []
    for line in lines:
        out.append(line[len(prefix):] if line.startswith(prefix) else line.lstrip())
    return out, prefix


def reindent_block(text: str, from_indent: str, to_indent: str) -> str:
    """Re-align ``text`` written at ``from_indent`` to sit at ``to_indent``.

    Blank lines stay blank (a line of pure spaces is churn in every diff), and
    relative nesting inside the block is preserved because only the shared
    prefix is swapped.
    """
    if from_indent == to_indent:
        return text
    lines = text.split("\n")
    out = []
    for line in lines:
        if not line.strip():
            out.append("")
            continue
        if from_indent and line.startswith(from_indent):
            out.append(to_indent + line[len(from_indent):])
        else:
            out.append(to_indent + line.lstrip() if not from_indent else to_indent + line)
    return "\n".join(out)


# ── Matching ──────────────────────────────────────────────────────────────

@dataclass
class MatchRegion:
    """Where a SEARCH body was found, and how much trust that match deserves."""

    start: int
    end: int
    similarity: float
    strategy: str
    file_indent: str = ""
    search_indent: str = ""
    line_number: int = 0


@dataclass
class ReplaceOutcome:
    """Structured result of one replace attempt."""

    ok: bool
    content: str = ""
    similarity: float = 0.0
    strategy: str = ""
    backend: str = ""
    replaced_count: int = 0
    line_number: int = 0
    error: str = ""
    diagnostics: str = ""
    candidates: list[dict] = field(default_factory=list)


def _line_offsets(content: str) -> tuple[list[str], list[int]]:
    """Split into lines (no endings) plus the char offset of each line start."""
    lines: list[str] = []
    offsets: list[int] = []
    pos = 0
    for piece in content.splitlines(keepends=True):
        offsets.append(pos)
        stripped = piece.rstrip("\n")
        if stripped.endswith("\r"):
            stripped = stripped[:-1]
        lines.append(stripped)
        pos += len(piece)
    offsets.append(pos)
    return lines, offsets


def _region_end(lines: list[str], offsets: list[int], start_idx: int, count: int) -> int:
    """End offset of the [start_idx, start_idx+count) line window, sans newline."""
    last = start_idx + count - 1
    return offsets[last] + len(lines[last])


def find_match(
    content: str,
    search: str,
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> Optional[MatchRegion]:
    """Locate ``search`` in ``content``, escalating through four strategies.

    exact -> trailing-whitespace-insensitive -> indentation-realigned ->
    Levenshtein-fuzzy above ``threshold``. Returns None when nothing clears
    the bar, which is deliberately a hard failure: a wrong region silently
    rewritten is far more expensive than a refused edit.
    """
    if not search:
        return None

    # 1. Exact substring — the only strategy that can match mid-line.
    idx = content.find(search)
    if idx >= 0:
        return MatchRegion(
            start=idx,
            end=idx + len(search),
            similarity=1.0,
            strategy="exact",
            line_number=content.count("\n", 0, idx) + 1,
        )

    lines, offsets = _line_offsets(content)
    search_lines = search.split("\n")
    n = len(search_lines)
    if n == 0 or len(lines) < n:
        return None

    search_rstrip = [s.rstrip() for s in search_lines]
    dedented_search, search_indent = dedent_block(search_lines)
    dedented_rstrip = [s.rstrip() for s in dedented_search]
    search_joined = "\n".join(search_lines)

    best: Optional[MatchRegion] = None
    for i in range(0, len(lines) - n + 1):
        window = lines[i:i + n]

        # 2. Trailing whitespace only.
        if [w.rstrip() for w in window] == search_rstrip:
            return MatchRegion(
                start=offsets[i],
                end=_region_end(lines, offsets, i, n),
                similarity=1.0,
                strategy="rstrip",
                file_indent=common_indent(window),
                search_indent=search_indent,
                line_number=i + 1,
            )

        # 3. Indentation drift: same code, different column.
        dedented_window, window_indent = dedent_block(window)
        if [w.rstrip() for w in dedented_window] == dedented_rstrip:
            return MatchRegion(
                start=offsets[i],
                end=_region_end(lines, offsets, i, n),
                similarity=1.0,
                strategy="reindent",
                file_indent=window_indent,
                search_indent=search_indent,
                line_number=i + 1,
            )

        # 4. Fuzzy — typos, renamed locals, reflowed comments.
        sim = compute_similarity(search_joined, "\n".join(window))
        if sim >= threshold and (best is None or sim > best.similarity):
            best = MatchRegion(
                start=offsets[i],
                end=_region_end(lines, offsets, i, n),
                similarity=sim,
                strategy="fuzzy",
                file_indent=window_indent,
                search_indent=search_indent,
                line_number=i + 1,
            )
    return best


def build_diagnostics(content: str, search: str) -> tuple[str, list[dict]]:
    """Near-miss report for a failed match, matching ovolve_core's wording."""
    lines = content.split("\n")
    first = (search.split("\n")[0] or "").strip()
    candidates: list[dict] = []
    if first:
        target_line_count = len(search.split("\n"))
        for idx, line in enumerate(lines):
            sim = compute_similarity(first, line)
            if sim < DIAGNOSTIC_SIMILARITY_FLOOR:
                continue
            start_ctx = max(0, idx - 2)
            end_ctx = min(len(lines), idx + target_line_count + 2)
            preview = "\n".join(
                f"{i + 1:4d} | {lines[i]}" for i in range(start_ctx, end_ctx)
            )
            candidates.append(
                {"line_number": idx + 1, "similarity": round(sim, 4), "preview": preview}
            )
            if len(candidates) >= 3:
                break
    if not candidates:
        return "", []
    hints = "\n---\n".join(
        f"Near Line {c['line_number']} (similarity {c['similarity']:.2f}):\n{c['preview']}"
        for c in candidates
    )
    msg = (
        "Auto-Diagnosis: the SEARCH text was not found (check whitespace/indentation/typo). "
        f"Closest candidate line(s):\n{hints}\n"
        "Adjust the SEARCH text to match the exact lines above."
    )
    return msg, candidates


def replace_once(
    content: str,
    search: str,
    replace: str,
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    allow_multiple: bool = False,
) -> ReplaceOutcome:
    """Replace one (or all exact) occurrence(s) of ``search`` with ``replace``.

    Tries the Rust ``replace_file_content_fast`` first when available — it is
    exact-match-only, so a miss there just falls through to the tolerant
    Python path rather than aborting.
    """
    backend = backend_name()
    if not search:
        return ReplaceOutcome(ok=False, content=content, backend=backend,
                              error="empty SEARCH text")

    if _RUST_CORE is not None:
        rust = _try_rust_replace(content, search, replace, allow_multiple)
        if rust is not None and rust.ok:
            return rust

    if allow_multiple:
        count = content.count(search)
        if count > 1:
            return ReplaceOutcome(
                ok=True,
                content=content.replace(search, replace),
                similarity=1.0,
                strategy="exact",
                backend=backend,
                replaced_count=count,
                line_number=content.count("\n", 0, content.find(search)) + 1,
            )

    region = find_match(content, search, threshold)
    if region is None:
        diag, candidates = build_diagnostics(content, search)
        return ReplaceOutcome(
            ok=False,
            content=content,
            backend=backend,
            error=(
                "SEARCH text not found and no candidate reached the similarity "
                f"threshold {threshold:.2f}"
            ),
            diagnostics=diag,
            candidates=candidates,
        )

    if region.strategy == "exact" and not allow_multiple:
        occurrences = content.count(search)
        if occurrences > 1:
            return ReplaceOutcome(
                ok=False,
                content=content,
                similarity=1.0,
                strategy="exact",
                backend=backend,
                error=(
                    f"SEARCH text appears {occurrences} times; add surrounding "
                    "context or set allow_multiple=true"
                ),
            )

    replacement = replace
    if region.strategy in ("reindent", "fuzzy") and region.file_indent != region.search_indent:
        replacement = reindent_block(replace, region.search_indent, region.file_indent)

    new_content = content[: region.start] + replacement + content[region.end:]
    return ReplaceOutcome(
        ok=True,
        content=new_content,
        similarity=region.similarity,
        strategy=region.strategy,
        backend=backend,
        replaced_count=1,
        line_number=region.line_number,
    )


def _try_rust_replace(
    content: str, search: str, replace: str, allow_multiple: bool
) -> Optional[ReplaceOutcome]:
    """Call the Rust matcher, tolerating either a dict or an object result."""
    try:
        raw = _RUST_CORE.replace_file_content_fast(content, search, replace, allow_multiple)
    except Exception:
        return None

    def _get(key, default=None):
        if isinstance(raw, dict):
            return raw.get(key, default)
        return getattr(raw, key, default)

    if not _get("success"):
        return None
    return ReplaceOutcome(
        ok=True,
        content=str(_get("content") or ""),
        similarity=1.0,
        strategy="exact",
        backend="ovolve_core",
        replaced_count=int(_get("replaced_count") or 1),
        line_number=content.count("\n", 0, max(content.find(search), 0)) + 1,
    )


def apply_aider_blocks(
    content: str,
    blocks_or_text,
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> ReplaceOutcome:
    """Apply every parsed block in order; the first failure aborts the whole set.

    All-or-nothing on purpose: a half-applied multi-block edit leaves the file
    in a state neither the model nor the user asked for, and the model's next
    SEARCH bodies were written against the pre-edit file anyway.
    """
    blocks = (
        parse_aider_blocks(blocks_or_text)
        if isinstance(blocks_or_text, str)
        else list(blocks_or_text)
    )
    if not blocks:
        return ReplaceOutcome(
            ok=False, content=content, backend=backend_name(),
            error="no SEARCH/REPLACE block found",
        )

    current = content
    applied = 0
    worst = 1.0
    strategies: list[str] = []
    for block in blocks:
        outcome = replace_once(current, block.search, block.replace, threshold)
        if not outcome.ok:
            return ReplaceOutcome(
                ok=False,
                content=content,
                backend=outcome.backend,
                replaced_count=applied,
                error=f"block #{block.index + 1} failed: {outcome.error}",
                diagnostics=outcome.diagnostics,
                candidates=outcome.candidates,
            )
        current = outcome.content
        applied += 1
        worst = min(worst, outcome.similarity)
        strategies.append(outcome.strategy)

    return ReplaceOutcome(
        ok=True,
        content=current,
        similarity=worst,
        strategy="+".join(dict.fromkeys(strategies)),
        backend=backend_name(),
        replaced_count=applied,
    )

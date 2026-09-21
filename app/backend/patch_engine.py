"""patch_engine.py — Hunk-level unified diff apply (FastApply pattern).

Parses standard unified diff hunks and applies them with context-line matching.
Falls back to fuzzy whitespace-normalized matching when exact context fails.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class Hunk:
    old_start: int
    new_start: int
    lines: list[str]


@dataclass
class PatchResult:
    ok: bool
    content: str = ""
    error: str = ""
    hunks_applied: int = 0


_HUNK_RE = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


def _parse_hunks(patch: str) -> list[Hunk]:
    hunks: list[Hunk] = []
    current: Optional[Hunk] = None
    for raw in patch.splitlines():
        if raw.startswith(("diff ", "--- ", "+++ ", "index ")):
            continue
        m = _HUNK_RE.match(raw)
        if m:
            if current:
                hunks.append(current)
            current = Hunk(old_start=int(m.group(1)), new_start=int(m.group(3)), lines=[])
            continue
        if current is not None and raw and raw[0] in " +-":
            current.lines.append(raw)
    if current:
        hunks.append(current)
    return hunks


def _strip_nl(s: str) -> str:
    return s.rstrip("\r\n")


def _norm(s: str) -> str:
    return _strip_nl(s).replace("\t", "    ")


def _find_hunk_pos(lines: list[str], hunk: Hunk) -> Optional[int]:
    """Return 0-based line index where this hunk's pre-image matches.

    The pre-image of a hunk is its context (" ") AND deletion ("-") lines in
    order — matching only the context lines contiguously fails whenever a
    deletion sits between two context lines, which is the common case.
    """
    ctx = [_strip_nl(ln[1:]) for ln in hunk.lines if ln[0] in " -"]
    if not ctx:
        return max(0, hunk.old_start - 1)
    hint = max(0, hunk.old_start - 1)
    candidates = list(range(max(0, hint - 8), min(len(lines), hint + 8)))
    candidates += list(range(0, len(lines)))
    seen: set[int] = set()
    for pos in candidates:
        if pos in seen or pos + len(ctx) > len(lines):
            continue
        seen.add(pos)
        window = [_strip_nl(lines[pos + i]) for i in range(len(ctx))]
        if window == ctx or [_norm(x) for x in window] == [_norm(x) for x in ctx]:
            return pos
    return None


def _apply_hunk(lines: list[str], hunk: Hunk) -> tuple[Optional[list[str]], str]:
    pos = _find_hunk_pos(lines, hunk)
    if pos is None:
        return None, f"context not found near line {hunk.old_start}"
    out: list[str] = []
    idx = pos
    for ln in hunk.lines:
        kind, body = ln[0], ln[1:]
        body_nl = body + ("\n" if body or kind == "+" else "")
        if kind == " ":
            if idx >= len(lines):
                return None, f"context extends past EOF at line {idx + 1}"
            if _norm(lines[idx]) != _norm(body_nl):
                return None, f"context mismatch at line {idx + 1}"
            out.append(lines[idx])
            idx += 1
        elif kind == "-":
            if idx >= len(lines):
                return None, f"delete past EOF at line {idx + 1}"
            if _norm(lines[idx]) != _norm(body_nl) and _strip_nl(lines[idx]) != _strip_nl(body):
                return None, f"delete mismatch at line {idx + 1}"
            idx += 1
        elif kind == "+":
            nl = "\n"
            if idx < len(lines):
                nl = "\n" if lines[idx].endswith("\n") else ""
            elif out:
                nl = "\n" if out[-1].endswith("\n") else ""
            elif lines:
                nl = "\n" if any(l.endswith("\n") for l in lines) else ""
            out.append(body + nl)
    return lines[:pos] + out + lines[idx:], ""


def apply_unified_patch(content: str, patch: str) -> PatchResult:
    """Apply a unified diff patch to file content."""
    if not patch.strip():
        return PatchResult(False, error="empty patch")
    hunks = _parse_hunks(patch)
    if not hunks:
        return PatchResult(False, error="no hunks found in patch")
    had_trailing_nl = content.endswith("\n")
    lines = content.splitlines(keepends=True)
    if content and not had_trailing_nl and lines:
        lines[-1] = lines[-1].rstrip("\n")
    applied = 0
    for hunk in hunks:
        result, err = _apply_hunk(lines, hunk)
        if result is None:
            return PatchResult(False, error=err, hunks_applied=applied)
        lines = result
        applied += 1
    out = "".join(lines)
    if had_trailing_nl and out and not out.endswith("\n"):
        out += "\n"
    return PatchResult(True, content=out, hunks_applied=applied)

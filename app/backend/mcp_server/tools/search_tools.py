"""mcp_server/tools/search_tools.py - Local content search over the workspace.

Ripgrep-like text search plus filename glob search, both scoped to the
caller's workspace_root.
"""
from __future__ import annotations
import fnmatch
import os
import re
from typing import List

from result import Result

_DEFAULT_IGNORE = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
_MAX_MATCHES = 500


def _iter_files(root: str, ignore: set[str]) -> List[str]:
    """Walk ``root`` yielding files, skipping ignored directory names."""
    out: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ignore and not d.startswith(".")]
        for fname in filenames:
            out.append(os.path.join(dirpath, fname))
    return out


def search_code(args: dict, ctx: dict) -> Result:
    """Grep-like text search across the workspace.

    Args:
        args: pattern (regex), path (subdirectory), ignore_case, limit.
    """
    root = ctx.get("workspace_root")
    if not root:
        return Result.failure("Missing workspace_root", code="NoWorkspace")
    pattern = args.get("pattern", "")
    if not pattern:
        return Result.failure("Missing 'pattern'", code="MissingArg")
    flags = re.IGNORECASE if args.get("ignore_case") else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        return Result.failure(f"Invalid regex: {e}", code="BadRegex")
    limit = min(int(args.get("limit", 100) or 100), _MAX_MATCHES)
    base = os.path.join(root, args.get("path", ""))
    ignore = set(args.get("ignore", [])) | _DEFAULT_IGNORE

    matches = []
    for path in _iter_files(base, ignore):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    if regex.search(line):
                        rel = os.path.relpath(path, root)
                        matches.append(f"{rel}:{i}:{line.rstrip()}")
                        if len(matches) >= limit:
                            return Result.success(matches)
        except OSError:
            continue
    return Result.success(matches)


def find_files(args: dict, ctx: dict) -> Result:
    """Glob for filenames under the workspace."""
    root = ctx.get("workspace_root")
    if not root:
        return Result.failure("Missing workspace_root", code="NoWorkspace")
    glob = args.get("glob", "*")
    limit = min(int(args.get("limit", 200) or 200), _MAX_MATCHES)
    ignore = set(args.get("ignore", [])) | _DEFAULT_IGNORE
    out = []
    for path in _iter_files(root, ignore):
        rel = os.path.relpath(path, root)
        if fnmatch.fnmatch(os.path.basename(path), glob):
            out.append(rel)
            if len(out) >= limit:
                break
    return Result.success(out)


TOOLS = {
    "search_code": search_code,
    "find_files": find_files,
}

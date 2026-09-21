"""mcp_server/tools/file_tools.py - File I/O tools exposed through the gateway.

These mirror the local file_agent surface but run inside the MCP server
context, so path resolution happens against the caller-provided workspace,
not the desktop app's workspace. Each handler returns a Result so the gateway
can serialize failures without special-casing exceptions.
"""
from __future__ import annotations
import os
from typing import Any

from result import Result


def _resolve(ctx: dict, path: str) -> Result:
    """Confine ``path`` to the caller's workspace.

    Args:
        ctx: Request context. Expected to carry ``workspace_root``.
        path: Relative or absolute path from the caller.

    Returns:
        Result with the absolute resolved path, or a failure when it would
        escape the workspace.
    """
    root = ctx.get("workspace_root")
    if not root:
        return Result.failure("Missing workspace_root", code="NoWorkspace")
    try:
        target = os.path.realpath(os.path.abspath(os.path.join(root, path)))
        base = os.path.realpath(os.path.abspath(root))
    except (OSError, ValueError) as exc:
        return Result.failure(f"Bad path: {exc}", code="BadPath")
    if target != base and not target.startswith(base.rstrip(os.sep) + os.sep):
        return Result.failure("Path escapes workspace", code="PathEscape")
    return Result.success(target)


def read_text(args: dict, ctx: dict) -> Result:
    """Read a text file under the caller's workspace."""
    resolved = _resolve(ctx, args.get("path", ""))
    if not resolved.ok:
        return resolved
    try:
        with open(resolved.value, "r", encoding="utf-8", errors="replace") as f:
            return Result.success(f.read())
    except OSError as e:
        return Result.failure(f"read failed: {e}", code="ReadError")


def write_text(args: dict, ctx: dict) -> Result:
    """Atomic write of a text file (tmp + rename)."""
    resolved = _resolve(ctx, args.get("path", ""))
    if not resolved.ok:
        return resolved
    content = args.get("content", "")
    target = resolved.value
    tmp = f"{target}.tmp.{os.getpid()}"
    try:
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, target)
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程
        return Result.failure(f"write failed: {e}", code="WriteError")
    return Result.success({"path": target, "bytes": len(content.encode("utf-8"))})


def list_dir(args: dict, ctx: dict) -> Result:
    """List directory entries, directories suffixed with ``/``."""
    resolved = _resolve(ctx, args.get("path", "."))
    if not resolved.ok:
        return resolved
    try:
        entries = sorted(os.listdir(resolved.value))
    except OSError as e:
        return Result.failure(f"list failed: {e}", code="ListError")
    labeled = []
    for name in entries[: int(args.get("limit", 200))]:
        full = os.path.join(resolved.value, name)
        labeled.append(name + ("/" if os.path.isdir(full) else ""))
    return Result.success(labeled)


TOOLS = {
    "read_text": read_text,
    "write_text": write_text,
    "list_dir": list_dir,
}

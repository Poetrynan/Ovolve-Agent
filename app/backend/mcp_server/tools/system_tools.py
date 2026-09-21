"""mcp_server/tools/system_tools.py - Read-only system introspection tools.

Intentionally narrow: the gateway is a public surface, so we do NOT expose
shell / process kill / installers here. Only lookups that don't mutate state.
"""
from __future__ import annotations
import os
import platform

from result import Result
from device_fingerprint import get_device_fingerprint


def platform_info(args: dict, ctx: dict) -> Result:
    """Return a coarse platform description."""
    return get_device_fingerprint().report()


def env_var(args: dict, ctx: dict) -> Result:
    """Read a single non-sensitive environment variable.

    Sensitive names (``KEY``, ``TOKEN``, ``SECRET``, ``PASSWORD``) are masked
    to prevent the gateway from leaking credentials via echo.
    """
    name = args.get("name", "").strip()
    if not name:
        return Result.failure("Missing 'name'", code="MissingArg")
    value = os.environ.get(name)
    if value is None:
        return Result.success({"name": name, "value": None})
    upper = name.upper()
    if any(hint in upper for hint in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
        return Result.success({"name": name, "value": "<masked>"})
    return Result.success({"name": name, "value": value})


def uptime(args: dict, ctx: dict) -> Result:
    """Report seconds since the app started (server-relative)."""
    started = ctx.get("server_started_at", 0.0)
    if not started:
        return Result.failure("No server start time in ctx", code="NoStartTime")
    import time
    return Result.success({"seconds": time.time() - started})


TOOLS = {
    "platform_info": platform_info,
    "env_var": env_var,
    "uptime": uptime,
}

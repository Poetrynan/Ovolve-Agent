"""mcp_server/tools/__init__.py - Server-side MCP tool registry.

Tool implementations live one per file for domain isolation. This module
composes the registry — a plain dict mapping service_id -> {tool_name: callable}
— so ``server.dispatch`` can route incoming requests without touching this
package's internals.

Add a new tool by writing ``mcp_server/tools/<domain>_tools.py`` with a
module-level ``TOOLS`` dict, then importing it here.
"""
from __future__ import annotations
from typing import Any, Callable

from mcp_server.tools.file_tools import TOOLS as FILE_TOOLS
from mcp_server.tools.system_tools import TOOLS as SYSTEM_TOOLS
from mcp_server.tools.search_tools import TOOLS as SEARCH_TOOLS

#: service_id -> {tool_name -> handler(args, ctx) -> Result}
REGISTRY: dict[str, dict[str, Callable[..., Any]]] = {
    "file": FILE_TOOLS,
    "system": SYSTEM_TOOLS,
    "search": SEARCH_TOOLS,
}


def resolve(service_id: str, tool_name: str) -> Callable[..., Any] | None:
    """Look up a tool handler by service_id + tool_name.

    Returns:
        The handler callable, or None when the service/tool is unknown.
    """
    return REGISTRY.get(service_id, {}).get(tool_name)


def list_tools(service_id: str = None) -> dict:
    """Describe available tools for gateway discovery.

    Args:
        service_id: Restrict to a single service_id when supplied.

    Returns:
        ``{service_id: [tool_name, ...]}``.
    """
    if service_id:
        return {service_id: sorted(REGISTRY.get(service_id, {}).keys())}
    return {sid: sorted(t.keys()) for sid, t in REGISTRY.items()}

"""mcp_manager.py — Manage external MCP servers, expose their tools to the agent.

Aligned with mainstream MCP clients:
- Config lives under ``mcpServers`` in ``config.json`` (industry-standard shape).
- A local entry: ``{command, args, env, disabled}``.
- A remote entry: ``{url, headers, type, disabled}`` — ``type`` being one of
  ``http`` (Streamable HTTP), ``sse`` or ``websocket``. Omit it and the
  transport is inferred from the URL scheme, which is what every published
  snippet relies on.
- On startup we connect each enabled server, initialize an MCP ``ClientSession``
  over the chosen transport, ``list_tools()``, and register each remote tool
  into the shared ``ToolRegistry`` under a namespaced name
  ``mcp__<server>__<tool>``.

Design notes
------------
1. **Long-lived session, isolated task.** The official ``mcp`` SDK uses anyio
   cancel scopes inside the transport clients and ``ClientSession``. Both must
   be entered and exited in the same task, so each server owns a dedicated
   ``_runner()`` task that enters both context managers, holds them open, and
   only exits when a stop event fires. Calling ``session.call_tool`` from
   another task on the same loop is safe — it just writes to the shared memory
   stream and awaits a response future.
2. **Graceful degradation.** If ``mcp`` is not installed or a specific server
   fails to launch, we log and continue: the rest of the agent must not go
   dark because one external server is misconfigured. The remote transports are
   imported lazily inside the runner for the same reason — an SDK build without
   the websocket extra must not stop stdio servers from working.
3. **Safety default.** MCP tools register at ``risk_level="medium"``. Under
   ``auto`` the permission gate will still allow reads through but
   any tool the user hasn't seen before goes through the confirmation path
   (a common default — external tools are not trusted equal to built-ins).
4. **Tool naming.** ``mcp__<server>__<tool_name>`` — double underscore matches
   the convention used in Anthropic's own MCP examples and keeps the
   provenance visible in traces.
"""
from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

try:
    from mcp import ClientSession, StdioServerParameters  # type: ignore
    from mcp.client.stdio import stdio_client  # type: ignore
    _MCP_AVAILABLE = True
    _MCP_IMPORT_ERROR = ""
except Exception as _exc:  # noqa: BLE001 — SDK missing on this install
    _MCP_AVAILABLE = False
    _MCP_IMPORT_ERROR = f"{type(_exc).__name__}: {_exc}"

from result import Result


#: Default per-call timeout. Kept generous so slow servers (npm-fetching-on-
#: first-use) don't die on the first request; the mode gate + user cancel
#: cover the "stuck forever" case.
DEFAULT_CALL_TIMEOUT = 60.0

#: Startup deadline for a server to reach the "tools listed" state.
STARTUP_TIMEOUT = 30.0

#: How often, once connected, to probe that the server is still alive, and how
#: long a probe may take before it counts as dead. Without this the runner just
#: ``await``s a stop event forever: a killed stdio child or a dropped remote
#: endpoint never raises there, so ``status`` stayed "connected" and the tools
#: stayed registered while every call silently failed. 0 disables probing.
HEARTBEAT_INTERVAL = 30.0
HEARTBEAT_TIMEOUT = 10.0

#: Transports we know how to open. ``stdio`` spawns a subprocess; the rest dial
#: a URL. Kept as a tuple so an unknown ``type`` in the config fails loudly at
#: parse time instead of silently behaving like stdio.
TRANSPORTS = ("stdio", "http", "sse", "websocket")


def _infer_transport(raw_type: str, url: str, command: str) -> str:
    """Resolve the transport for one config entry.

    An explicit ``type`` wins. Otherwise: a ``ws://``/``wss://`` URL is a
    websocket, any other URL is Streamable HTTP (the current spec default —
    plain SSE is the legacy path and has to be asked for by name), and no URL
    at all means a local subprocess.

    Inference exists because published snippets rarely include ``type``: people
    copy ``{"url": "https://..."}`` out of a README and expect it to work.
    """
    t = (raw_type or "").strip().lower()
    # VS Code writes "streamable-http"/"streamableHttp" in places; normalise.
    if t in ("streamable-http", "streamablehttp", "streamable_http"):
        return "http"
    if t in ("ws", "wss"):
        return "websocket"
    if t in TRANSPORTS:
        return t
    if url:
        return "websocket" if url.lower().startswith(("ws://", "wss://")) else "http"
    return "stdio"



@dataclass
class MCPServerConfig:
    """One entry from the ``mcpServers`` block of ``config.json``.

    Compatible with the industry-standard mcpServers schema so users can
    copy configs between apps. Local (``command``) and remote (``url``) entries
    share this one shape because that is how those apps do it — the transport
    is a property of the entry, not a separate config section.
    """
    name: str
    command: str = ""
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    disabled: bool = False
    #: Optional cap in seconds. Overrides ``DEFAULT_CALL_TIMEOUT``.
    timeout: Optional[float] = None
    #: Remote endpoint. Empty for stdio servers.
    url: str = ""
    #: Extra HTTP headers, typically ``{"Authorization": "Bearer ..."}``.
    headers: Dict[str, str] = field(default_factory=dict)
    #: One of ``TRANSPORTS``. Always populated by ``from_dict``.
    transport: str = "stdio"

    @property
    def is_remote(self) -> bool:
        return self.transport != "stdio"

    @classmethod
    def from_dict(cls, name: str, d: dict) -> "MCPServerConfig":
        raw_env = d.get("env") or {}
        raw_headers = d.get("headers") or {}
        url = str(d.get("url") or d.get("serverUrl") or "").strip()
        command = str(d.get("command") or "")
        return cls(
            name=name,
            command=command,
            args=[str(a) for a in (d.get("args") or [])],
            env={str(k): str(v) for k, v in raw_env.items()},
            disabled=bool(d.get("disabled", False)),
            timeout=d.get("timeout"),
            url=url,
            headers={str(k): str(v) for k, v in raw_headers.items()},
            transport=_infer_transport(
                str(d.get("type") or d.get("transport") or ""), url, command,
            ),
        )



@dataclass
class MCPToolInfo:
    """A tool discovered on a connected server (for the UI listing)."""
    qualified_name: str   # mcp__server__tool
    raw_name: str         # tool
    description: str
    schema: dict


class MCPServerConnection:
    """Owns one server subprocess + its MCP session for the process lifetime.

    State machine (``self.status``):
        ``idle`` → ``starting`` → ``connected`` | ``failed`` | ``disabled``
        ``connected`` → ``lost`` when a heartbeat probe fails
    A stop request transitions any live state back to ``idle``.

    ``lost`` is deliberately distinct from ``failed``: ``failed`` means we never
    got a working session, ``lost`` means we had one and the peer went away. Both
    mean "do not show this as connected and do not keep its tools registered",
    but only ``lost`` tells the user their server died under them.
    """

    def __init__(self, config: MCPServerConfig, registry: Any) -> None:
        self.config = config
        self._registry = registry
        self.status = "disabled" if config.disabled else "idle"
        self.error = ""
        self.tools: List[MCPToolInfo] = []
        self.session: Any = None
        self.started_at = 0.0
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Spawn the runner task and wait until tools are listed (or it fails).

        Idempotent: a no-op if already connected. Never raises — failures land
        in ``self.status``/``self.error`` so one bad server can't abort boot.
        """
        if self.config.disabled:
            self.status = "disabled"
            return
        if self.status == "connected":
            return
        if not _MCP_AVAILABLE:
            self.status = "failed"
            self.error = f"mcp SDK not installed ({_MCP_IMPORT_ERROR})"
            return
        if self.config.is_remote:
            if not self.config.url:
                self.status = "failed"
                self.error = f"transport '{self.config.transport}' needs a url"
                return
        elif not self.config.command:
            self.status = "failed"
            self.error = "no command configured"
            return


        self._stop.clear()
        self._ready.clear()
        self.status = "starting"
        self.error = ""
        self._task = asyncio.ensure_future(self._runner())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=STARTUP_TIMEOUT)
        except asyncio.TimeoutError:
            self.status = "failed"
            self.error = f"startup exceeded {STARTUP_TIMEOUT:.0f}s"
            await self.stop()

    async def stop(self) -> None:
        """Signal the runner to unwind, unregister tools, reap the task.

        The task is awaited (bounded) rather than fire-and-forget so the
        subprocess is actually reaped before a restart spawns a second one.
        """
        self._unregister_tools()
        self._stop.set()
        task, self._task = self._task, None
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
            except Exception as e:  # noqa: BLE001 — teardown must not raise
                print(f"[mcp] stop(): teardown error while waiting for server "
                      f"task: {e}")
        self.session = None
        self.tools = []
        # `lost` is preserved alongside `failed`: an explicit stop of a server
        # that already died should not relabel it as a clean `idle`, or the user
        # loses the only signal that it went down on its own.
        if self.status not in ("failed", "lost"):
            self.status = "disabled" if self.config.disabled else "idle"

    @asynccontextmanager
    async def _open_streams(self):
        """Yield ``(read, write)`` for whichever transport this server uses.

        The transport clients are imported here, not at module scope, because
        an ``mcp`` install without the websocket extra would otherwise take
        stdio servers down with it — the same graceful-degradation rule that
        keeps one broken server from killing the whole agent.
        """
        cfg = self.config
        if cfg.transport == "stdio":
            params = StdioServerParameters(
                command=cfg.command,
                args=list(cfg.args),
                # Inherit the parent env so `npx`/`uvx` can find node/python,
                # then layer the user's overrides on top. A bare env would
                # break almost every real-world server.
                env={**os.environ, **cfg.env} if cfg.env else None,
            )
            async with stdio_client(params) as (read, write):
                yield read, write
            return

        if cfg.transport == "http":
            from mcp.client.streamable_http import streamablehttp_client  # type: ignore
            # Streamable HTTP yields a third element (a session-id getter) that
            # ClientSession does not take; unpack and drop it.
            async with streamablehttp_client(
                cfg.url, headers=cfg.headers or None,
            ) as (read, write, _get_session_id):
                yield read, write
            return

        if cfg.transport == "sse":
            from mcp.client.sse import sse_client  # type: ignore
            async with sse_client(cfg.url, headers=cfg.headers or None) as (read, write):
                yield read, write
            return

        if cfg.transport == "websocket":
            from mcp.client.websocket import websocket_client  # type: ignore
            # No headers parameter in the SDK's websocket client — auth has to
            # ride in the URL for this transport.
            async with websocket_client(cfg.url) as (read, write):
                yield read, write
            return

        raise ValueError(f"unsupported transport '{cfg.transport}'")

    async def _runner(self) -> None:
        """Hold the transport + session contexts open until asked to stop.

        Everything lives in ONE task on purpose: anyio cancel scopes created by
        the transport client and ``ClientSession`` must be exited by the task
        that entered them. Splitting setup and teardown across tasks produces
        the classic "Attempted to exit cancel scope in a different task" crash.
        """
        try:
            async with self._open_streams() as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self.session = session
                    await self._discover_tools(session)
                    self.status = "connected"
                    self.started_at = time.time()
                    self._ready.set()
                    await self._hold_until_stopped(session)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — one bad server, not a dead app
            self.status = "failed"
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.session = None
            # A server that died on us must stop advertising tools. Leaving them
            # in the registry is what made the UI show "connected · 8 tools"
            # while every one of those calls failed.
            if self.status in ("failed", "lost"):
                try:
                    self._unregister_tools()
                except Exception as e:  # noqa: BLE001
                    # fail-open：注销失败不该盖掉真正的启动失败原因，
                    # 但注册表里残留幽灵工具必须留痕。
                    print(f"[mcp] unregister tools after failure failed: {e}")
            # Unblock a start() that is still waiting, so a failure surfaces
            # immediately instead of burning the full startup timeout.
            self._ready.set()

    async def _hold_until_stopped(self, session: Any) -> None:
        """Stay in this task until asked to stop — or until the server dies.

        The previous version was a bare ``await self._stop.wait()``. That is
        correct for the shutdown path and blind to everything else: a killed
        stdio child or a dropped HTTP endpoint does not wake that await and does
        not raise, so the session sat there reporting itself healthy forever.

        So: wait on the stop event, but only in ``HEARTBEAT_INTERVAL`` slices,
        and probe the server between slices. A probe that raises or times out
        transitions to ``lost`` and returns, which lets the ``finally`` in
        :meth:`_runner` tear the tools back out of the registry.
        """
        if HEARTBEAT_INTERVAL <= 0:
            await self._stop.wait()
            return
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=HEARTBEAT_INTERVAL)
                return  # stop event won — normal shutdown
            except asyncio.TimeoutError:
                pass  # interval elapsed; time to probe
            alive, detail = await self._probe(session)
            if not alive:
                self.status = "lost"
                self.error = detail
                return

    async def _probe(self, session: Any) -> tuple[bool, str]:
        """One liveness check. Returns ``(alive, detail)``; never raises.

        Prefers the protocol's own ``ping``. Falls back to ``list_tools`` for
        sessions that don't expose one — it is a heavier call, but any successful
        round-trip proves the transport and the peer are both still there, which
        is the only thing being asked.
        """
        probe = getattr(session, "send_ping", None) or getattr(session, "list_tools", None)
        if probe is None:
            # Nothing to probe with. Report alive rather than killing a healthy
            # server over a missing SDK method.
            return True, ""
        try:
            await asyncio.wait_for(probe(), timeout=HEARTBEAT_TIMEOUT)
            return True, ""
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            return False, f"心跳超时（{HEARTBEAT_TIMEOUT:g}s 内无响应）"
        except Exception as exc:  # noqa: BLE001
            return False, f"连接已断开：{type(exc).__name__}: {exc}"


    # ------------------------------------------------------------------
    # Tool discovery + registration
    # ------------------------------------------------------------------

    async def _discover_tools(self, session: Any) -> None:
        """List tools from the session and register them into the ToolRegistry."""
        resp = await session.list_tools()
        self.tools = []
        for tool in resp.tools:
            qname = f"mcp__{self.config.name}__{tool.name}"
            schema = tool.inputSchema if hasattr(tool, "inputSchema") else (
                tool.input_schema if hasattr(tool, "input_schema") else
                {"type": "object", "properties": {}}
            )
            info = MCPToolInfo(
                qualified_name=qname,
                raw_name=tool.name,
                description=tool.description or f"[MCP:{self.config.name}] {tool.name}",
                schema=schema if isinstance(schema, dict) else {"type": "object", "properties": {}},
            )
            self.tools.append(info)
            self._register_tool(info)

    def _register_tool(self, info: MCPToolInfo) -> None:
        """Register a single MCP tool into the global ToolRegistry."""
        from tools import ToolDef, get_tool_registry

        server_name = self.config.name
        timeout = self.config.timeout or DEFAULT_CALL_TIMEOUT

        async def _handler(args: dict, ctx: dict) -> Result:
            if self.session is None:
                return Result.failure(
                    f"MCP server '{server_name}' is not connected",
                    meta={"server": server_name, "tool": info.raw_name},
                )
            try:
                resp = await asyncio.wait_for(
                    self.session.call_tool(info.raw_name, arguments=args),
                    timeout=timeout,
                )
                # MCP call_tool returns CallToolResult with `.content` list.
                # Each item has `.text` or `.data`; we flatten to string.
                parts = []
                for block in (resp.content or []):
                    if hasattr(block, "text") and block.text:
                        parts.append(block.text)
                    elif hasattr(block, "data"):
                        import json as _json
                        parts.append(_json.dumps(block.data, ensure_ascii=False))
                output = "\n".join(parts) if parts else "(empty response)"
                if resp.isError:
                    return Result.failure(output, meta={"server": server_name})
                return Result.success(output, server=server_name, tool=info.raw_name)
            except asyncio.TimeoutError:
                return Result.failure(
                    f"MCP tool '{info.raw_name}' timed out after {timeout}s",
                    meta={"server": server_name},
                )
            except Exception as exc:  # noqa: BLE001
                return Result.failure(
                    f"MCP call failed: {type(exc).__name__}: {exc}",
                    meta={"server": server_name, "tool": info.raw_name},
                )

        tool_def = ToolDef(
            name=info.qualified_name,
            description=f"[MCP:{server_name}] {info.description}",
            schema=info.schema,
            execute=_handler,
            domain="mcp",
            risk_level="medium",
            needs_confirmation=True,
            # 按服务器名成组（六·UC1）。domain 一律是 "mcp"，装了三个服务器就
            # 分不出来源；分组之后目录裁剪能整组折叠、tool_search 能整组浮出。
            group=f"mcp:{server_name}",
        )
        get_tool_registry().register(tool_def)

    def _unregister_tools(self) -> None:
        """Remove all tools this server registered from the ToolRegistry."""
        from tools import get_tool_registry
        registry = get_tool_registry()
        for info in self.tools:
            registry._tools.pop(info.qualified_name, None)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def snapshot(self) -> dict:
        """A JSON-serializable status payload for the diagnostics UI."""
        return {
            "name": self.config.name,
            "command": self.config.command,
            "args": self.config.args,
            "transport": self.config.transport,
            "url": self.config.url,
            "status": self.status,
            "error": self.error,
            "disabled": self.config.disabled,
            "toolCount": len(self.tools),
            "tools": [{"name": t.qualified_name, "raw": t.raw_name, "desc": t.description} for t in self.tools],
            "uptimeSeconds": round(time.time() - self.started_at, 1) if self.started_at and self.status == "connected" else 0,
        }


# ==========================================================================
# MCPManager — global singleton managing all configured servers
# ==========================================================================

class MCPManager:
    """Lifecycle manager for all configured MCP servers.

    Instantiated once during ``run_server`` (just like goal_scheduler /
    bot_controller). Reads from ``config["mcpServers"]`` (standard shape) and
    from ``config["mcp_servers"]`` (snake_case fallback).
    """

    def __init__(self) -> None:
        self._servers: Dict[str, MCPServerConnection] = {}

    # ------------------------------------------------------------------
    # Config load
    # ------------------------------------------------------------------

    def load_config(self, config: dict) -> None:
        """Parse ``mcpServers`` from the config dict and build connection objects.

        Does NOT start them — call ``start_all()`` after the event loop is live.
        """
        from tools import get_tool_registry
        registry = get_tool_registry()

        # The industry-standard key is ``mcpServers``.
        raw = config.get("mcpServers") or config.get("mcp_servers") or {}
        for name, entry in raw.items():
            if not isinstance(entry, dict):
                continue
            cfg = MCPServerConfig.from_dict(name, entry)
            self._servers[name] = MCPServerConnection(cfg, registry)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start_all(self) -> dict:
        """Start all non-disabled servers in parallel. Returns summary."""
        results: Dict[str, str] = {}
        coros = []
        for name, conn in self._servers.items():
            if conn.config.disabled:
                results[name] = "disabled"
            else:
                coros.append((name, conn.start()))

        for name, coro in coros:
            await coro
            results[name] = self._servers[name].status
        return results

    async def stop_all(self) -> None:
        """Graceful shutdown for all servers (called on app exit)."""
        for conn in self._servers.values():
            await conn.stop()

    async def restart(self, name: str) -> str:
        """Restart a single server by name. Returns new status."""
        conn = self._servers.get(name)
        if conn is None:
            return "not_found"
        await conn.stop()
        conn.config.disabled = False
        await conn.start()
        return conn.status

    async def disable(self, name: str) -> str:
        """Disable a server (stop + mark disabled)."""
        conn = self._servers.get(name)
        if conn is None:
            return "not_found"
        conn.config.disabled = True
        await conn.stop()
        return "disabled"

    async def enable(self, name: str) -> str:
        """Enable and start a previously disabled server."""
        conn = self._servers.get(name)
        if conn is None:
            return "not_found"
        conn.config.disabled = False
        await conn.start()
        return conn.status

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def list_servers(self) -> List[dict]:
        """All server snapshots, for the UI listing."""
        return [conn.snapshot() for conn in self._servers.values()]

    def get_server(self, name: str) -> Optional[MCPServerConnection]:
        return self._servers.get(name)

    @property
    def available(self) -> bool:
        return _MCP_AVAILABLE

    @property
    def import_error(self) -> str:
        return _MCP_IMPORT_ERROR


# --------------------------------------------------------------------------
# Singleton
# --------------------------------------------------------------------------

_manager: Optional[MCPManager] = None


def get_mcp_manager() -> MCPManager:
    global _manager
    if _manager is None:
        _manager = MCPManager()
    return _manager

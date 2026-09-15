"""mcp_client.py - MCP client (unified gateway + service_id routing + signature header).

Pattern: Agent only knows one gateway URL + service_id.
Gateway handles auth/audit/rate-limiting and routes to real providers.
Local atomic tools use stdio; cloud MCP uses Streamable HTTP.
"""
from __future__ import annotations
import json, time, hashlib, os, asyncio
from typing import Any, Optional
from result import Result


async def _http_post(url: str, body: str, headers: dict, timeout: int) -> tuple[int, str]:
    """POST JSON and return ``(status, text)``.

    Uses aiohttp when available; otherwise falls back to a blocking urllib call
    run in a worker thread so the event loop is never blocked.
    """
    try:
        import aiohttp
        cto = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=cto) as session:
            async with session.post(url, data=body.encode("utf-8"), headers=headers) as resp:
                return resp.status, await resp.text()
    except ImportError:
        def _blocking() -> tuple[int, str]:
            import urllib.request, urllib.error
            req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.status, r.read().decode("utf-8", errors="ignore")
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode("utf-8", errors="ignore")
        return await asyncio.to_thread(_blocking)

class MCPSignatureBuilder:
    """Build signature headers: md5(body + timestamp + accessKey + nonce)."""
    def __init__(self, access_key: str = "", business_id: str = "ovolve"):
        self.access_key = access_key
        self.business_id = business_id

    def sign(self, body: str, timestamp: int = None, nonce: str = None) -> dict:
        import uuid
        ts = timestamp or int(time.time())
        nc = nonce or str(uuid.uuid4())[:8]
        raw = f"{body}{ts}{self.access_key}{nc}"
        sig = hashlib.md5(raw.encode()).hexdigest()
        return {
            "X-Access-Businessid": self.business_id,
            "X-Access-Timestamp": str(ts),
            "X-Access-Nonce": nc,
            "X-Access-Signature": sig,
            "X-Access-Requestid": str(uuid.uuid4()),
        }


class MCPServiceRegistry:
    """Service registry: service_id -> config mapping."""
    def __init__(self):
        self._services: dict = {}

    def register(self, service_id: str, config: dict):
        """Register a MCP service. Config includes:
        - server_url, transport_type, timeout, auth_type
        - ext_mcp_config: {description, capabilities, scenarios}
        """
        self._services[service_id] = config

    def get(self, service_id: str) -> Optional[dict]:
        return self._services.get(service_id)

    def list_services(self) -> list:
        return [{"service_id": sid, **{k: v for k, v in cfg.items() if k != "headers"}}
                for sid, cfg in self._services.items()]

    def find_by_capability(self, query: str) -> list:
        """Find services matching a capability query (uses ext_mcp_config)."""
        results = []
        for sid, cfg in self._services.items():
            ext = cfg.get("ext_mcp_config", {})
            if isinstance(ext, str):
                try: ext = json.loads(ext)
                except: ext = {}
            desc = ext.get("description", "") + " " + ext.get("capabilities", "") + " " + ext.get("scenarios", "")
            if query.lower() in desc.lower():
                results.append(sid)
        return results


class MCPClient:
    """MCP client: unified gateway + service_id routing."""

    def __init__(self, gateway_url: str = "", access_key: str = "", business_id: str = "ovolve"):
        self.gateway_url = gateway_url
        self.signature_builder = MCPSignatureBuilder(access_key, business_id)
        self.registry = MCPServiceRegistry()
        self._timeout = 30

    def configure_service(self, service_id: str, name: str, description: str,
                          capabilities: str = "", scenarios: str = "",
                          server_url: str = None, transport: str = "streamable",
                          auth_type: str = "none", timeout: int = 30):
        """Configure a MCP service in the registry."""
        url = server_url or f"{self.gateway_url}/v1/mcp_proxy/streamable?service_id={service_id}"
        ext = {"description": description, "capabilities": capabilities, "scenarios": scenarios}
        self.registry.register(service_id, {
            "service_name": name,
            "server_url": url,
            "transport_type": transport,
            "auth_type": auth_type,
            "timeout": timeout,
            "ext_mcp_config": json.dumps(ext, ensure_ascii=False),
            "is_need_proxy": True,
        })

    async def call_tool(self, service_id: str, tool_name: str, args: dict) -> Result:
        """Call a MCP tool through the gateway (real HTTP round-trip)."""
        svc = self.registry.get(service_id)
        if not svc:
            return Result.failure(f"MCP service not found: {service_id}")

        url = svc.get("server_url") or ""
        if not url or url.startswith("/v1/"):  # empty gateway_url leaves a bare path
            return Result.failure(
                "MCP gateway not configured: set mcp.gateway_url (and signature_key) "
                "in config.json, or pass server_url when configuring the service."
            )

        body = json.dumps({"tool": tool_name, "args": args}, ensure_ascii=False)
        headers = self.signature_builder.sign(body)
        headers["Content-Type"] = "application/json"

        try:
            status, text = await _http_post(url, body, headers, svc.get("timeout", self._timeout))
        except Exception as e:
            return Result.failure(f"MCP call failed ({service_id}/{tool_name}): {e}")

        if status >= 400:
            return Result.failure(f"MCP gateway returned {status}: {text[:500]}")
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            data = {"raw": text[:5000]}
        return Result.success(data)

    async def list_tools(self, service_id: str) -> Result:
        """List available tools for a MCP service.

        Queries the service when a real URL is configured; otherwise falls back
        to the registry's ext_mcp_config description (so capability routing
        still works offline).
        """
        svc = self.registry.get(service_id)
        if not svc:
            return Result.failure(f"MCP service not found: {service_id}")

        url = svc.get("server_url") or ""
        if url and not url.startswith("/v1/"):
            body = json.dumps({"method": "tools/list"}, ensure_ascii=False)
            headers = self.signature_builder.sign(body)
            headers["Content-Type"] = "application/json"
            try:
                status, text = await _http_post(url, body, headers, svc.get("timeout", self._timeout))
                if status < 400:
                    try:
                        return Result.success(json.loads(text))
                    except (json.JSONDecodeError, ValueError):
                        pass  # fail-open: 可选增强，失败不影响主流程
            except Exception:
                pass  # fall through to registry metadata

        ext = svc.get("ext_mcp_config", "{}")
        try:
            ext_data = json.loads(ext) if isinstance(ext, str) else ext
        except (json.JSONDecodeError, ValueError, TypeError):
            ext_data = {}
        return Result.success({
            "service_id": service_id,
            "service_name": svc.get("service_name", ""),
            "description": ext_data.get("description", ""),
            "capabilities": ext_data.get("capabilities", ""),
        })

    def get_service_prompt(self, service_id: str) -> str:
        """Get the routing prompt (ext_mcp_config) for a service."""
        svc = self.registry.get(service_id)
        if not svc: return ""
        return svc.get("ext_mcp_config", "")

_mcp: Optional[MCPClient] = None
def get_mcp_client() -> MCPClient:
    global _mcp
    if _mcp is None:
        _mcp = MCPClient()
    return _mcp

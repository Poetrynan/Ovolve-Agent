"""mcp_server/server.py - MCP gateway HTTP entrypoint.

Design follows the "unified gateway + service_id routing + Streamable HTTP"
pattern: one endpoint, ``?service_id=<id>`` picks the tool namespace, and every
request is signature-verified before dispatch.

The handler is transport-agnostic — ``handle_request`` takes raw bytes plus
headers and returns a status/body pair, so it can be mounted on the existing
http_server, on Starlette/FastAPI, or driven directly from tests. Only
``run_standalone`` touches a concrete server (stdlib ``http.server``), keeping
the dependency footprint at zero.
"""
from __future__ import annotations

import json
import time
from typing import Any, Optional, Tuple

from result import Result
from mcp_server.auth import get_verifier
from mcp_server.tools import list_tools, resolve

#: Header names carrying the signature envelope.
H_BUSINESS = "ual-access-businessid"
H_TIMESTAMP = "ual-access-timestamp"
H_NONCE = "ual-access-nonce"
H_SIGNATURE = "ual-access-signature"
H_REQUEST_ID = "ual-access-requestid"


class MCPServer:
    """Signature-verified MCP tool gateway.

    Args:
        workspace_root: Root directory tool calls are confined to.
        require_signature: When False, signature checks are skipped. Only
            appropriate for loopback development — never for a listening socket.
    """

    def __init__(self, workspace_root: str, require_signature: bool = True) -> None:
        self.workspace_root = workspace_root
        self.require_signature = require_signature
        self.started_at = time.time()
        self._verifier = get_verifier()

    # ------------------------------------------------------------------
    # Request handling
    # ------------------------------------------------------------------

    def handle_request(
        self, body: bytes, headers: dict, query: dict
    ) -> Tuple[int, dict]:
        """Verify and dispatch one gateway request.

        Args:
            body: Raw request body.
            headers: Header mapping with lowercased keys.
            query: Parsed query string, expected to carry ``service_id``.

        Returns:
            ``(http_status, response_dict)``. The response always uses the
            envelope ``{success, code, message, data}``.
        """
        raw = body.decode("utf-8", errors="replace")

        if self.require_signature:
            auth = self._verifier.verify(
                body=raw,
                business_id=headers.get(H_BUSINESS, ""),
                timestamp=headers.get(H_TIMESTAMP, ""),
                nonce=headers.get(H_NONCE, ""),
                signature=headers.get(H_SIGNATURE, ""),
            )
            if not auth.ok:
                return 401, self._envelope(False, auth.code, auth.error)

        try:
            payload = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as e:
            return 400, self._envelope(False, "BadJSON", f"Invalid JSON: {e}")

        service_id = (query.get("service_id") or payload.get("service_id") or "").strip()
        method = payload.get("method", "")

        if method == "tools/list":
            return 200, self._envelope(True, "OK", "", list_tools(service_id or None))

        if method != "tools/call":
            return 400, self._envelope(
                False, "UnsupportedMethod", f"Unsupported method: {method or '(none)'}"
            )

        if not service_id:
            return 400, self._envelope(False, "MissingServiceId", "service_id is required")

        params = payload.get("params") or {}
        tool_name = params.get("name", "")
        args = params.get("arguments") or {}
        handler = resolve(service_id, tool_name)
        if handler is None:
            return 404, self._envelope(
                False, "UnknownTool", f"No tool '{tool_name}' in service '{service_id}'"
            )

        ctx = {
            "workspace_root": self.workspace_root,
            "server_started_at": self.started_at,
            "request_id": headers.get(H_REQUEST_ID, ""),
            "business_id": headers.get(H_BUSINESS, ""),
        }
        result = self._invoke(handler, args, ctx)
        if not result.ok:
            return 200, self._envelope(False, result.code or "ToolFailed", result.error)
        return 200, self._envelope(True, "OK", "", result.value)

    @staticmethod
    def _invoke(handler: Any, args: dict, ctx: dict) -> Result:
        """Call a tool handler, converting any escape into a Result."""
        try:
            out = handler(args, ctx)
        except Exception as exc:  # tool bugs must not take down the gateway
            return Result.failure(f"{type(exc).__name__}: {exc}", code="ToolException")
        return out if isinstance(out, Result) else Result.success(out)

    @staticmethod
    def _envelope(success: bool, code: str, message: str, data: Any = None) -> dict:
        """Build the uniform JSON response envelope."""
        return {"success": success, "code": code, "message": message, "data": data}

    # ------------------------------------------------------------------
    # Standalone runner (stdlib only)
    # ------------------------------------------------------------------

    def run_standalone(self, host: str = "127.0.0.1", port: int = 8765) -> None:
        """Serve the gateway on a loopback socket using stdlib http.server.

        Binds to 127.0.0.1 by default. Binding to a non-loopback interface with
        ``require_signature=False`` would expose unauthenticated file read/write
        to the network, so that combination is refused.
        """
        if host not in ("127.0.0.1", "localhost", "::1") and not self.require_signature:
            raise ValueError(
                "Refusing to serve unauthenticated gateway on a non-loopback interface"
            )

        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from urllib.parse import parse_qs, urlparse

        server_self = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                parsed = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                headers = {k.lower(): v for k, v in self.headers.items()}
                status, payload = server_self.handle_request(raw, headers, query)
                encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, fmt: str, *fmt_args: Any) -> None:
                # Keep the console clean; real deployments should wire telemetry.
                return

        ThreadingHTTPServer((host, port), Handler).serve_forever()


_server: Optional[MCPServer] = None


def get_mcp_server(workspace_root: str = None, require_signature: bool = True) -> MCPServer:
    """Get (or create) the global MCPServer singleton."""
    global _server
    if _server is None:
        import os
        _server = MCPServer(
            workspace_root or os.getcwd(), require_signature=require_signature
        )
    return _server

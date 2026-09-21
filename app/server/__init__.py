"""server/ — HTTP/WebSocket API layer for the Ovolve backend.

What lives here
--------------
``http_server.py`` is the aiohttp application: it wires the shared backend
services (Router, SessionHost, Evolution, MCP, sub-agent runtime) to HTTP
routes and a WebSocket bridge, and enforces the API-token auth middleware
from ``api_auth``.

Why a separate package
----------------------
``app/backend/`` holds the agent machinery (router, storage, tools, risk). It
has no HTTP dependency — the CLI entrypoint (``app/main.py``) runs the same
code without a server. Keeping HTTP here means the backend stays transport-
agnostic and testable without binding a port.
"""

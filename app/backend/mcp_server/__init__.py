"""mcp_server package - Local MCP gateway exposing tools to external clients.

Provides:
  - ``server.py``  : HTTP entrypoint (Streamable transport, service_id routing)
  - ``auth.py``    : md5(body+ts+key+nonce) signature verification
  - ``tools/``     : Tool implementations grouped by domain
"""
from mcp_server.auth import SignatureVerifier, get_verifier

__all__ = ["SignatureVerifier", "get_verifier"]

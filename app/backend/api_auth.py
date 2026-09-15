"""
api_auth.py — local-process authentication for the HTTP / WebSocket API.

Why this exists
---------------
The API binds to 127.0.0.1, which keeps it off the network but does **not** keep
it private: every other process running as this user can reach it. Without a
shared secret, any local program — a browser extension's helper, a random npm
postinstall script, malware — can read the whole conversation history, rewrite
settings, and run tools through ``/api/*``. "Localhost only" is a network
boundary, not an authorization boundary.

The scheme
----------
One secret, three ways to present it:

* ``X-Api-Token: <token>`` — the normal path, used by ``fetch``.
* ``Authorization: Bearer <token>`` — accepted because it is the convention.
* ``?token=<token>`` — required, not a convenience: the browser
  ``WebSocket`` constructor and ``<img src>`` cannot set headers at all. A
  query token on loopback is the same secret over the same socket; the only
  real cost is that it can end up in a log line.

Exempt paths are listed in :data:`EXEMPT_PREFIXES` / :data:`EXEMPT_EXACT` and
each one has a reason recorded there. Everything else is closed.

Where the token comes from
--------------------------
Same pattern as the 8766 browser-control bridge (``OVOLVE_BRIDGE_TOKEN``):
the Electron parent generates it and injects it through the environment, so it
never touches a command line. When the backend is launched standalone (bare
``python main.py --server``, tests, a dev shell) there is no parent to do that,
so it generates its own and writes it to :func:`token_file_path` — that file is
how the Vite dev proxy learns the secret. The file is written with owner-only
permissions and is best-effort: if the write fails the token still works, the
dev proxy just cannot pick it up.

There is deliberately no "auth disabled" switch. A flag like that is always
found by the next person in a hurry, and a security boundary that can be turned
off by an environment variable is one an attacker can also turn off.
"""
from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path
from typing import Optional

from aiohttp import web

#: Header the frontend sends. Mirrors ``X-Bridge-Token`` on the control bridge.
TOKEN_HEADER = "X-Api-Token"
#: Query parameter for clients that physically cannot send headers.
TOKEN_QUERY = "token"
#: Environment variable the Electron parent uses to inject the secret.
TOKEN_ENV = "OVOLVE_API_TOKEN"

#: Paths open to unauthenticated callers, with the reason each one has to be.
EXEMPT_EXACT = frozenset({
    # Electron polls this before the window exists, i.e. before it could attach
    # a token, and it returns nothing but liveness.
    "/api/health",
    # The SPA shell itself. The renderer has to load before it can authenticate.
    "/",
    "/index.html",
})

EXEMPT_PREFIXES = (
    # Built assets for the shell above.
    "/assets/",
    # Inbound webhooks from Feishu / DingTalk / WeCom. These are called by the
    # vendors' servers, which know nothing about our token; they authenticate
    # with their own per-platform request signatures (see providers/*).
    "/api/bot/webhook/",
)


def is_exempt(path: str) -> bool:
    """Whether ``path`` may be served without a token."""
    if path in EXEMPT_EXACT:
        return True
    return any(path.startswith(p) for p in EXEMPT_PREFIXES)


def token_file_path() -> Path:
    """Where a self-generated token is cached for the Vite dev proxy.

    ``app/.api_token`` — next to the backend rather than in a temp dir, because
    the dev proxy config (``app/ui/vite.config.ts``) resolves it relatively and
    a temp path would differ per platform.
    """
    return Path(__file__).resolve().parent.parent / ".api_token"


_token: Optional[str] = None


def get_api_token() -> str:
    """The process's API secret, generated once on first use.

    Resolution order: injected environment → previously cached value → freshly
    generated. Generating is the fallback, never the preference: when Electron
    injected a token, the renderer already has the same string, and minting a
    second one here would lock out the very client we exist to serve.
    """
    global _token
    if _token:
        return _token

    env_token = (os.environ.get(TOKEN_ENV) or "").strip()
    if env_token:
        _token = env_token
    else:
        # Check if app/.api_token was already written by Electron
        try:
            p = token_file_path()
            if p.exists():
                file_tok = p.read_text(encoding="utf-8").strip()
                if file_tok:
                    _token = file_tok
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        if not _token:
            _token = secrets.token_urlsafe(32)

    # Make it discoverable to the dev proxy. Best-effort: a packaged install may
    # sit on a read-only volume, and in that case Electron supplied the token via
    # the environment anyway, so nobody needs the file.
    try:
        p = token_file_path()
        p.write_text(_token, encoding="utf-8")
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程
    except OSError:
        pass  # fail-open: 可选增强，失败不影响主流程
    return _token


def token_matches(candidate: Optional[str]) -> bool:
    """Constant-time comparison against the process token.

    ``hmac.compare_digest`` rather than ``==``: a short-circuiting comparison
    leaks the length of the shared prefix through timing, which is enough to
    recover a secret one character at a time.

    Fail-closed on every path: no candidate, or a candidate that matches
    neither the process token → False. There is deliberately no loopback or
    file fallback here — the server already binds to loopback only, so
    "loopback is trusted" would authorize every local process equally
    (see the module header: localhost is a network boundary, not an
    authorization one).
    """
    if not candidate:
        return False
    return hmac.compare_digest(str(candidate), get_api_token())


def extract_token(request: web.Request) -> Optional[str]:
    """Pull the presented token out of a request, in header-first order."""
    tok = request.headers.get(TOKEN_HEADER)
    if tok:
        return tok.strip()
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    q = request.query.get(TOKEN_QUERY)
    if q:
        return q.strip()
    return None


def request_authorized(request: web.Request) -> bool:
    """Whether this request may proceed — exemption or a valid token."""
    if is_exempt(request.path):
        return True
    return token_matches(extract_token(request))


@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Reject unauthenticated remote callers before any handler runs."""
    if request.method == "OPTIONS":
        return await handler(request)
    if request_authorized(request):
        return await handler(request)
    return web.json_response({"error": "api token required"}, status=401)


# Eagerly initialize the token on module load so app/.api_token is always
# written to disk before any dev proxy or client tries to discover it.
try:
    get_api_token()
except Exception:
    pass

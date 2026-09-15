"""B1 — local-process API token auth (F4 batch).

The gap this pins: binding to 127.0.0.1 is a *network* boundary, not an
authorization one. Every other process running as this user could read the whole
conversation history and drive tools through ``/api/*``.

The discipline carried over from the C/D/E batches: it is not enough that a
middleware *exists*. These tests assert that

  1. it is actually installed in the app that ships (``create_server``),
  2. it really refuses — a tokenless request gets 401, not 200,
  3. every transport that cannot send headers still has a way in, and
  4. the frontend migration is complete, because one missed ``fetch`` is a
     feature that 401s in production while the test suite stays green.
"""
import inspect
import re
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import api_auth


TEST_TOKEN = "unit-test-token-0123456789"


@pytest.fixture()
def token(monkeypatch):
    """Pin the process token so assertions are deterministic."""
    monkeypatch.setattr(api_auth, "_token", TEST_TOKEN, raising=False)
    return TEST_TOKEN


@pytest.fixture()
def guarded_app(token):
    """An app wired exactly like production: CORS outermost, auth inside it."""
    from server import http_server

    async def ok(_request):
        return web.json_response({"ok": True})

    app = web.Application(
        middlewares=[http_server.cors_middleware, api_auth.auth_middleware]
    )
    app.add_routes([
        web.get("/api/settings", ok),
        web.get("/api/health", ok),
        web.get("/api/bot/webhook/feishu", ok),
        web.get("/ws", ok),
    ])
    return app


@pytest.fixture()
async def client(guarded_app):
    """A started TestClient over the guarded app.

    Same story as the image-route tests: these used to ask for
    ``aiohttp_client``, which comes from ``pytest-aiohttp`` — not installed
    here and not installed in CI. The 8 tests that needed it ended as ERROR,
    which reads like "nothing to run" rather than "8 auth assertions never
    executed". ``TestClient`` ships with aiohttp, so nothing has to be added.
    """
    c = TestClient(TestServer(guarded_app))
    await c.start_server()
    yield c
    await c.close()


# ── 语料 1 · 门是真的关着的 ────────────────────────────────────────────────

async def test_tokenless_request_is_refused(client):
    """The whole point. If this ever returns 200 the boundary is decorative."""
    resp = await client.get("/api/settings")
    assert resp.status == 401


async def test_wrong_token_is_refused(client):
    resp = await client.get("/api/settings", headers={"X-Api-Token": "not-it"})
    assert resp.status == 401


async def test_error_body_says_nothing_useful_to_an_attacker(client):
    """No hint about length, correctness, or whether the route exists."""
    resp = await client.get("/api/settings")
    body = await resp.json()
    text = str(body).lower()
    assert "token" in text
    for leak in ("length", "expected", "prefix", str(len(TEST_TOKEN))):
        assert leak not in text


# ── 语料 2 · 三种出示方式都得管用 ──────────────────────────────────────────

async def test_header_is_accepted(client, token):
    resp = await client.get("/api/settings", headers={"X-Api-Token": token})
    assert resp.status == 200


async def test_bearer_is_accepted(client, token):
    resp = await client.get("/api/settings", headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 200


async def test_query_token_is_accepted_because_websockets_cannot_send_headers(
    client, token
):
    """`new WebSocket()` and `<img src>` cannot set headers at all. Without this
    path the socket could never authenticate and the app would never connect."""
    resp = await client.get(f"/ws?token={token}")
    assert resp.status == 200
    assert (await client.get("/ws")).status == 401


# ── 语料 3 · 豁免名单不多不少 ──────────────────────────────────────────────

async def test_health_stays_open_because_electron_polls_it_before_startup(client):
    assert (await client.get("/api/health")).status == 200


async def test_vendor_webhooks_stay_open(client):
    """Feishu / DingTalk / WeCom servers cannot know our token; they authenticate
    with their own request signatures instead (see providers/*)."""
    assert (await client.get("/api/bot/webhook/feishu")).status == 200


@pytest.mark.parametrize("path", [
    "/api/settings", "/api/goals", "/api/memory/entries", "/api/git/commit",
    "/api/subagents/kill-all", "/api/images/abc", "/ws",
])
def test_sensitive_paths_are_not_exempt(path):
    """A path sneaking onto the exempt list is how this protection quietly dies."""
    assert not api_auth.is_exempt(path), f"{path} must require a token"


def test_exempt_list_has_not_grown_silently():
    """Pinned so adding an exemption is a deliberate, reviewed act."""
    assert api_auth.EXEMPT_EXACT == frozenset({"/api/health", "/", "/index.html"})
    assert api_auth.EXEMPT_PREFIXES == ("/assets/", "/api/bot/webhook/")


# ── 语料 4 · 比较是常量时间的 ──────────────────────────────────────────────

def test_comparison_is_constant_time(token):
    """`==` on secrets leaks the shared-prefix length through timing, which is
    enough to recover a token one character at a time."""
    src = inspect.getsource(api_auth.token_matches)
    assert "compare_digest" in src
    assert token_equality_shortcut_absent(src)
    assert api_auth.token_matches(token) is True
    assert api_auth.token_matches(token[:-1]) is False
    assert api_auth.token_matches("") is False
    assert api_auth.token_matches(None) is False


def token_equality_shortcut_absent(src: str) -> bool:
    return not re.search(r"candidate\s*==", src)


# ── 语料 5 · 它真的被装进了会发货的那个 app ────────────────────────────────

def test_create_server_installs_the_auth_middleware():
    """A middleware defined but never registered protects nothing. Pin that the
    production factory wires it in — and inside CORS, so preflights still work."""
    from server import http_server

    src = inspect.getsource(http_server.create_server)
    assert "auth_middleware" in src, "auth middleware is not installed in create_server"
    # CORS has to be listed before auth so browser OPTIONS (which carry no token)
    # are answered before the token check runs.
    assert src.index("cors_middleware") < src.index("auth_middleware")


# ── 语料 6 · 前端迁移没有漏网之鱼 ──────────────────────────────────────────

def _ui_src() -> Path:
    """app/backend/tests/ -> app/ -> app/ui/src.

    Indexed by depth (``parents[2]``) instead of a chain of ``.parent``, with
    the expected layout spelled out, because the two tests below skip cleanly
    when the tree is missing: a path that is merely *wrong* would therefore
    turn into a permanent silent skip rather than a failure. This file used to
    live one level higher (app/tests/), which is exactly how it would have
    broken on a move.
    """
    return Path(__file__).resolve().parents[2] / "ui" / "src"


def test_no_bare_fetch_to_the_backend_remains():
    """One un-migrated ``fetch`` is a call that 401s in packaged Electron while
    every test here stays green — the exact failure mode this batch exists to
    prevent. The only allowed bare ``fetch`` is the wrapper's own, in lib/api.ts.

    Skips cleanly if the UI tree is absent (backend-only checkout / CI shard)."""
    src = _ui_src()
    if not src.exists():
        pytest.skip(f"UI source tree not present (looked at {src})")

    allowed = {src / "lib" / "api.ts"}
    bare = re.compile(r"(?<![.\w])fetch\s*\(")
    offenders = []
    for path in src.rglob("*.ts*"):
        if path in allowed or path.suffix not in (".ts", ".tsx"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for i, line in enumerate(text.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue
            if bare.search(line):
                offenders.append(f"{path.relative_to(src)}:{i}")
    assert offenders == [], "un-migrated bare fetch (should be apiFetch): " + ", ".join(offenders)


def test_electron_has_exactly_one_token_generation_site():
    """Two `randomBytes` calls would mint two tokens, and whichever process lost
    the coin flip would authenticate against nothing. `electron/apiToken.ts` is
    the single source; main.ts and ipc/modelHandlers.ts must import from it."""
    electron = _ui_src().parent / "electron"
    if not electron.exists():
        pytest.skip(f"Electron source tree not present (looked at {electron})")

    holder = electron / "apiToken.ts"
    assert holder.exists(), "electron/apiToken.ts is missing"
    assert "randomBytes" in holder.read_text(encoding="utf-8")

    for name in ("main.ts", "ipc/modelHandlers.ts"):
        text = (electron / name).read_text(encoding="utf-8", errors="ignore")
        assert "apiToken" in text, f"{name} does not use the shared API token"
        assert "randomBytes(32)" not in text, (
            f"{name} generates its own token — it must import from ./apiToken"
        )


def test_backend_reads_the_token_from_the_environment():
    """Electron injects OVOLVE_API_TOKEN; if the backend ignored it and minted
    its own, the renderer would hold a token the server has never heard of."""
    src = inspect.getsource(api_auth.get_api_token)
    assert "TOKEN_ENV" in src or "OVOLVE_API_TOKEN" in src
    assert api_auth.TOKEN_ENV == "OVOLVE_API_TOKEN"

"""End-to-end test for the image HTTP route.

Everything else about images is unit-tested; this file is here because the route
is the one piece that can only be verified by actually serving a request. It
spins up a real aiohttp app with just that handler and a stub router, then checks
status codes, headers and bytes over the wire.
"""
import base64
from contextlib import asynccontextmanager

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import image_store
from server.http_server import ROUTER_KEY, handle_get_image


@asynccontextmanager
async def _serve(app):
    """Run a real app in-process and hand back a started client.

    Why not the ``aiohttp_client`` fixture: it comes from ``pytest-aiohttp``,
    which is installed on neither this machine nor CI — see
    ``.github/workflows/ci.yml``, it installs ``pytest pytest-asyncio aiohttp``
    and nothing else. Every test asking for it died with ``fixture
    'aiohttp_client' not found``, i.e. ERROR rather than FAIL, and an ERROR is
    easy to mistake for "nothing to run". These 11 assertions — including path
    traversal and "workspace must not come from a query param" — were silently
    not running for exactly that reason.

    ``TestClient`` ships with aiohttp itself, so this needs no extra dependency.
    """
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield client
    finally:
        await client.close()


TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8"
    "AAQTAGAFKcBQGkGvSuAAAAAElFTkSuQmCC"
)
TINY_PNG = base64.b64decode(TINY_PNG_B64)


class _StubRouter:
    """Only `workspace` is read by the handler."""

    def __init__(self, workspace):
        self.workspace = str(workspace)


@pytest.fixture
def make_app(tmp_path):
    def _make():
        app = web.Application()
        app[ROUTER_KEY] = _StubRouter(tmp_path)
        app.add_routes([web.get("/api/images/{image_id}", handle_get_image)])
        return app
    return _make


async def test_serves_saved_image_bytes(make_app, tmp_path):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path), "cat.png")
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{ref['id']}")
        assert resp.status == 200
        assert await resp.read() == TINY_PNG


async def test_content_type_matches_stored_extension(make_app, tmp_path):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/webp", str(tmp_path))
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{ref['id']}")
        assert resp.status == 200
        assert resp.headers["Content-Type"] == "image/webp"


async def test_sends_immutable_cache_header(make_app, tmp_path):
    """An id is a fresh uuid per save and the bytes behind it never change, so
    the browser is allowed to keep it forever. This is what makes a session
    reload cost zero re-transfer."""
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{ref['id']}")
        cache = resp.headers["Cache-Control"]
        assert "immutable" in cache
        assert "max-age=31536000" in cache


async def test_inline_disposition_so_browser_renders_instead_of_downloading(
    make_app, tmp_path
):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{ref['id']}")
        assert resp.headers["Content-Disposition"].startswith("inline")


async def test_unknown_id_is_404_not_500(make_app):
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{'a' * 32}")
        assert resp.status == 404


@pytest.mark.parametrize("evil", [
    "..%2F..%2F..%2Fetc%2Fpasswd",
    "..%5C..%5Cwindows%5Csystem32%5Cconfig%5Csam",
    "a" * 200,
    "short",
])
async def test_traversal_attempts_are_rejected(make_app, evil):
    """The id lands here straight off the URL path — it is untrusted input."""
    async with _serve(make_app()) as client:
        resp = await client.get(f"/api/images/{evil}")
        assert resp.status in (404, 400)


async def test_lookup_does_not_create_directories(tmp_path):
    """A GET must never have a filesystem side effect. The reference design took
    the workspace from a query param and called mkdir() during lookup, which made
    an unauthenticated GET able to create directories anywhere."""
    nowhere = tmp_path / "nowhere"
    app = web.Application()
    app[ROUTER_KEY] = _StubRouter(nowhere)
    app.add_routes([web.get("/api/images/{image_id}", handle_get_image)])

    async with _serve(app) as client:
        resp = await client.get(f"/api/images/{'b' * 32}")
        assert resp.status == 404

    assert not (nowhere / ".ovolve").exists()


async def test_workspace_is_not_taken_from_query_param(make_app, tmp_path):
    """Even if a caller passes ?workspace=..., the handler must ignore it and use
    the server's own workspace."""
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    async with _serve(make_app()) as client:
        # Point the query param somewhere else entirely — the image must still
        # resolve from the server's workspace, proving the param is not consulted.
        resp = await client.get(f"/api/images/{ref['id']}?workspace=C:/Windows")
        assert resp.status == 200
        assert await resp.read() == TINY_PNG

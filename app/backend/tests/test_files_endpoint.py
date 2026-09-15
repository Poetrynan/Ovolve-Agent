"""Wave E：本地媒体文件端点 GET /api/files 的安全回归。

只锁一个端点的安全语义：鉴权（401）、白名单外拒绝（403）、穿越拒绝（403）、
双重编码拒绝（403）、扩展名白名单（403）、404、413、Content-Type、限流（429）。
用 aiohttp TestServer 挂真实 handler + 真实 api_auth 中间件，workspace /
cua_shots / 用户 home 全部指向 tmp_path——绝不触碰真实用户目录。
用例按 Ovolve 的 ~/.ovolve/cua_shots 落盘约定
适配，
"""
import os
import types
import urllib.parse

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import api_auth
import server.http_server as hs
from server.http_server import handle_get_file, resolve_local_media_path

PDF_BYTES = b"%PDF-1.4\n%ovolve test pdf\n"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 32
JPG_BYTES = b"\xff\xd8\xff" + b"JPGDATA"


@pytest.fixture()
async def client(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "report.pdf").write_bytes(PDF_BYTES)
    (ws / "shot.png").write_bytes(PNG_BYTES)
    (ws / "notes.txt").write_text("definitely not media")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(PNG_BYTES)
    # cua_shots 约定形态：~/.ovolve/cua_shots（home 被 monkeypatch 到 tmp）。
    ovolve = tmp_path / ".ovolve"
    shots = ovolve / "cua_shots"
    shots.mkdir(parents=True)
    (shots / "cua.jpg").write_bytes(JPG_BYTES)

    monkeypatch.setattr(hs, "cua_shots_dir", lambda: str(shots))
    monkeypatch.setattr(hs, "_user_home", lambda: str(tmp_path))
    hs._reset_media_file_rate()

    app = web.Application(middlewares=[api_auth.auth_middleware])
    app[hs.ROUTER_KEY] = types.SimpleNamespace(workspace=str(ws))
    app.router.add_get("/api/files", handle_get_file)
    async with TestClient(TestServer(app)) as c:
        c.ws = ws
        c.shots = shots
        c.outside = outside
        c.token = api_auth.get_api_token()
        yield c
    hs._reset_media_file_rate()


def _authed(url: str, token: str) -> str:
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}token={urllib.parse.quote(token)}"


async def test_missing_token_is_401(client):
    resp = await client.get("/api/files", params={"path": str(client.ws / "shot.png")})
    assert resp.status == 401


async def test_serves_workspace_png_with_content_type(client):
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.ws / "shot.png")})
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/png"
    assert await resp.read() == PNG_BYTES
    assert resp.headers["Content-Disposition"].startswith("inline")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


async def test_serves_pdf_from_workspace(client):
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.ws / "report.pdf")})
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "application/pdf"
    assert await resp.read() == PDF_BYTES


async def test_cua_shots_root_is_whitelisted(client):
    # 路径在 workspace 之外，但落在 cua_shots 白名单根里。
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.shots / "cua.jpg")})
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/jpeg"


async def test_home_relative_cua_shots_path_resolves(client):
    # 文本里的 `~/.ovolve/cua_shots/...` 形态：~ = 用户 home（tmp）。
    p = "~/.ovolve/cua_shots/cua.jpg"
    resp = await client.get(_authed("/api/files", client.token), params={"path": p})
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "image/jpeg"


async def test_outside_whitelist_is_403(client):
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.outside / "secret.png")})
    assert resp.status == 403


async def test_traversal_is_403(client):
    for evil in ("../outside/secret.png", "..%2Foutside%2Fsecret.png",
                 "shot.png:ads", "..\\..\\outside\\secret.png"):
        resp = await client.get(_authed("/api/files", client.token),
                                params={"path": evil})
        assert resp.status == 403, evil


async def test_unc_and_device_paths_are_403(client):
    for evil in ("//server/share/x.png", "\\\\server\\share\\x.png",
                 "//./PhysicalDrive0.png"):
        resp = await client.get(_authed("/api/files", client.token),
                                params={"path": evil})
        assert resp.status == 403, evil


async def test_non_media_extension_is_403_even_inside_workspace(client):
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.ws / "notes.txt")})
    assert resp.status == 403


async def test_missing_file_is_404(client):
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.ws / "ghost.png")})
    assert resp.status == 404


async def test_empty_path_is_400(client):
    resp = await client.get(_authed("/api/files", client.token))
    assert resp.status == 400


async def test_oversized_file_is_413(client, monkeypatch):
    monkeypatch.setattr(hs, "MAX_MEDIA_FILE_BYTES", 8)
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(client.ws / "shot.png")})
    assert resp.status == 413


async def test_rate_limit_is_429(client, monkeypatch):
    monkeypatch.setattr(hs, "MEDIA_RATE_PER_MIN", 2)
    hs._reset_media_file_rate()
    statuses = []
    for _ in range(3):
        r = await client.get(_authed("/api/files", client.token),
                             params={"path": str(client.ws / "shot.png")})
        statuses.append(r.status)
    assert statuses == [200, 200, 429]


async def test_symlink_escape_is_403(client, tmp_path):
    """workspace 内的软链指向白名单外 → realpath 解析后仍拒绝。"""
    link = client.ws / "link.png"
    try:
        os.symlink(str(client.outside / "secret.png"), str(link))
    except (OSError, NotImplementedError):
        pytest.skip("symlink 权限不可用（Windows 无开发者模式）")
    if not os.path.islink(str(link)):
        # 某些文件系统层会把 symlink 静默降级成一个空文件：不报错，但链接
        # 根本没建起来（islink 为假）。此时断言 403 毫无意义——端点只是把
        # 那个空文件回给了 200，跟"是否挡住了逃逸"无关。不 skip 的话这里
        # 会稳定红，而且看起来像真的路径穿越漏洞，非常误导。
        pytest.skip("symlink 未真正创建（文件系统层把它降级成了空文件）")
    resp = await client.get(_authed("/api/files", client.token),
                            params={"path": str(link)})
    assert resp.status == 403


# ── 纯函数层：resolve_local_media_path 的形态覆盖（不经过 HTTP） ─────────────


def test_resolve_accepts_file_url_form(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "report.pdf").write_bytes(PDF_BYTES)
    real, err = resolve_local_media_path(
        "file:///" + urllib.parse.quote(str(ws / "report.pdf").replace("\\", "/")),
        str(ws), allowed_roots=[str(ws)])
    assert err == ""
    assert os.path.normcase(str(real)) == os.path.normcase(str(ws / "report.pdf"))


def test_resolve_rejects_empty_and_nul(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    assert resolve_local_media_path("", str(ws), allowed_roots=[str(ws)])[1] == "empty"
    assert resolve_local_media_path("shot\x00.png", str(ws), allowed_roots=[str(ws)])[1] == "traversal"


def test_resolve_rejects_double_encoded_traversal(tmp_path):
    """双重编码（..%2F..%2F）残留的百分号转义一律 403，绝不再解码一次。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    for evil in ("..%2Foutside%2Fsecret.png", "a%2F..%2F..%2Fsecret.png",
                 "%2e%2e%2fsecret.png"):
        assert resolve_local_media_path(evil, str(ws),
                                        allowed_roots=[str(ws)])[1] == "traversal", evil


def test_resolve_relative_joins_workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.png").write_bytes(PNG_BYTES)
    real, err = resolve_local_media_path("a.png", str(ws), allowed_roots=[str(ws)])
    assert err == ""
    assert os.path.normcase(str(real)) == os.path.normcase(str(ws / "a.png"))


def test_resolve_workspace_sibling_not_contained(tmp_path):
    # workspace 的"兄弟目录"不因前缀字符串相同而误判包含（commonpath 判定）。
    ws = tmp_path / "ws2x"
    ws.mkdir()
    sib = tmp_path / "ws2x-evil"
    sib.mkdir()
    (sib / "x.png").write_bytes(PNG_BYTES)
    assert resolve_local_media_path(str(sib / "x.png"), str(ws),
                                    allowed_roots=[str(ws)])[1] == "traversal"


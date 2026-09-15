"""test_claim_endpoints.py — U3 认领闭环 HTTP 桥面回归。

覆盖（handler 是 server.http_server 的真实实现；会话管理器整体替换为
FakeBridge 驱动的真 BrowserSessionManager——协议文案由 browser_sessions
原样生成，这里逐字断言；鉴权走真实 api_auth 中间件，对齐
test_files_endpoint.py 手法）:

GET /api/browser/tabs?task_id=...
  1. 正常: 打开中的标签清单（closed 过滤、active 标记、字段形状）
  2. 无会话: 200 空数组（优雅空态），缺省参数落 default 同样空态
  3. 鉴权: 无令牌 401
  4. 程序故障: 500 {error}

POST /api/browser/claim
  5. 成功: 200 {ok:true, tab, claim} 回执（claim 平铺可序列化、
     claimed_at_ms 已盖章、认领即聚焦）
  6. 三类协议拒绝: 200 {ok:false, message:<协议原文>}——changed 逐字断言
     旧→新对照，missing/foreign 整体等值
  7. 坏 body: 400（非 JSON / 非 object / 缺 object_id）
  8. 程序故障: 500 {error}

运行: pytest tests/test_claim_endpoints.py -q
"""
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from result import Result

import api_auth
import server.http_server as hs
from browser_sessions import BrowserSessionManager
from server.http_server import handle_browser_claim, handle_browser_tabs


# ── 测试替身（与 tests/test_browser_claim.py 同款手法）──────────────────────

class FakeBridge:
    """ElectronBrowserClient 的形状替身：记录 (endpoint, payload) 调用序列。"""

    def __init__(self, fail_endpoints=(), titles=None):
        self.calls = []
        self.fail = set(fail_endpoints)
        self.titles = dict(titles or {})
        self._n = 0

    def call(self, endpoint, payload=None, timeout=35):
        payload = dict(payload or {})
        self.calls.append((endpoint, payload))
        if endpoint in self.fail:
            return Result.failure(f"{endpoint} failed (injected)")
        if endpoint == "tab_open":
            self._n += 1
            url = payload.get("url", "")
            default = f"Page {self._n}" if url else "New Tab"
            return Result.success({
                "tab_id": payload.get("tab_id"),
                "url": url,
                "title": self.titles.get(url, default),
            })
        if endpoint == "navigate":
            url = payload.get("url", "")
            return Result.success({"url": url, "title": self.titles.get(url, "Page Title")})
        return Result.success({"tab_id": payload.get("tab_id")})


def seq_ids(prefix="t"):
    """确定性 tab id 工厂：断言里可以点名具体标签。"""
    box = {"n": 0}

    def factory():
        box["n"] += 1
        return f"{prefix}{box['n']:03d}"

    return factory


@pytest.fixture()
async def client(monkeypatch):
    bridge = FakeBridge(titles={
        "https://a.example": "A 页",
        "https://a.example/next": "A 页 — 第 2 页",
        "https://b.example": "B 页",
    })
    mgr = BrowserSessionManager(client=bridge, id_factory=seq_ids())
    monkeypatch.setattr(hs, "_claim_session_manager", lambda: mgr)
    app = web.Application(middlewares=[api_auth.auth_middleware])
    app.router.add_get("/api/browser/tabs", handle_browser_tabs)
    app.router.add_post("/api/browser/claim", handle_browser_claim)
    async with TestClient(TestServer(app)) as c:
        c.mgr = mgr
        c.bridge = bridge
        c.token = api_auth.get_api_token()
        yield c


def _auth(client):
    """真实 api_auth 中间件下的请求头。"""
    return {"X-Api-Token": client.token}


def _open(client, task, url):
    r = client.mgr.open_tab(task, url=url)
    assert r.ok
    return r.value["tab_id"]


# ── GET /api/browser/tabs ────────────────────────────────────────────────────

class TestBrowserTabsEndpoint:

    async def test_unauthenticated_request_is_401(self, client):
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-a"})
        assert resp.status == 401

    async def test_lists_open_tabs_with_active_marker(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        t2 = _open(client, "task-a", "https://b.example")     # 后开的夺焦点
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-a"},
                                headers=_auth(client))
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True
        assert data["task_id"] == "task-a"
        assert [t["tab_id"] for t in data["tabs"]] == [t1, t2]
        first, second = data["tabs"]
        # 行形状 = 后端 wire 原样：tab_id/title/url/status/active
        assert set(first.keys()) == {"tab_id", "title", "url", "status", "active"}
        assert first["title"] == "A 页" and first["url"] == "https://a.example"
        assert first["status"] == "active" and first["active"] is False
        assert second["active"] is True and second["title"] == "B 页"

    async def test_suspended_tabs_stay_listed(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        client.mgr.suspend_tab("task-a", t1)
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-a"},
                                headers=_auth(client))
        data = await resp.json()
        # 挂起保留（认领会顺带唤醒它），status 如实报 suspended
        assert [t["tab_id"] for t in data["tabs"]] == [t1]
        assert data["tabs"][0]["status"] == "suspended"
        assert data["tabs"][0]["active"] is False

    async def test_closed_tabs_are_filtered_out(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        t2 = _open(client, "task-a", "https://b.example")
        client.mgr.close_tab("task-a", t1)
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-a"},
                                headers=_auth(client))
        data = await resp.json()
        # closed 不进列表（引用一个已关闭对象只会得到认领失败）
        assert [t["tab_id"] for t in data["tabs"]] == [t2]

    async def test_no_session_is_200_empty_list(self, client):
        # 优雅空态：无会话不是错误，前端据此置灰而不是报错
        resp = await client.get("/api/browser/tabs", params={"task_id": "ghost"},
                                headers=_auth(client))
        assert resp.status == 200
        assert await resp.json() == {"ok": True, "task_id": "ghost", "tabs": []}

    async def test_missing_task_param_falls_back_to_default(self, client):
        resp = await client.get("/api/browser/tabs", headers=_auth(client))
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True and data["task_id"] == "default" and data["tabs"] == []

    async def test_tasks_are_isolated(self, client):
        _open(client, "task-a", "https://a.example")
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-b"},
                                headers=_auth(client))
        assert await resp.json() == {"ok": True, "task_id": "task-b", "tabs": []}

    async def test_program_failure_is_500(self, client, monkeypatch):
        class Boom:
            def list_tabs(self, task_id):
                raise RuntimeError("sessions store corrupted")

        monkeypatch.setattr(hs, "_claim_session_manager", lambda: Boom())
        resp = await client.get("/api/browser/tabs", params={"task_id": "task-a"},
                                headers=_auth(client))
        assert resp.status == 500
        assert "browser tabs unavailable" in (await resp.json())["error"]


# ── POST /api/browser/claim ──────────────────────────────────────────────────

class TestBrowserClaimEndpoint:

    def _claim_body(self, tab_id, title, url, task="task-a"):
        return {"task_id": task, "object_id": tab_id,
                "title_snapshot": title, "url_snapshot": url}

    async def test_unauthenticated_claim_is_401(self, client):
        resp = await client.post("/api/browser/claim",
                                 json=self._claim_body("t001", "x", "y"))
        assert resp.status == 401

    async def test_success_receipt_carries_tab_and_claim(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body(t1, "A 页", "https://a.example"))
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True
        assert data["tab"]["tab_id"] == t1
        assert data["claim"]["object_id"] == t1
        assert data["claim"]["title_snapshot"] == "A 页"
        assert data["claim"]["url_snapshot"] == "https://a.example"
        assert data["claim"]["kind"] == "tab"
        assert data["claim"]["claimed_at_ms"] > 0
        # 认领即聚焦（activate 语义）
        assert client.mgr.session_state("task-a").value["active_tab_id"] == t1

    async def test_drift_rejection_passes_protocol_text_verbatim(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        client.mgr.navigate_tab("task-a", "https://a.example/next", tab_id=t1)
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body(t1, "A 页", "https://a.example"))
        # 协议拒绝 = 业务结果：HTTP 200 + {ok:false, message:原文}
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is False
        msg = data["message"]
        assert ("认领失败: 对象已变化（引用时: A 页 | https://a.example → "
                "当前: A 页 — 第 2 页 | https://a.example/next），"
                "请重新引用后再认领") == msg

    async def test_missing_tab_rejection_is_verbatim(self, client):
        t1 = _open(client, "task-a", "https://a.example")
        client.mgr.close_tab("task-a", t1)
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body(t1, "A 页", "https://a.example"))
        assert resp.status == 200
        data = await resp.json()
        assert data == {"ok": False,
                        "message": f"认领失败: 标签 {t1} 不存在（可能已关闭）"}

    async def test_foreign_tab_rejection_is_verbatim_and_isolated(self, client):
        ta = _open(client, "task-a", "https://a.example")
        tb = _open(client, "task-b", "https://b.example")
        before = client.mgr.list_tabs("task-b").value
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body(tb, "B 页", "https://b.example",
                                                       task="task-a"))
        assert resp.status == 200
        data = await resp.json()
        assert data == {"ok": False, "message": "认领失败: 标签不属于当前任务会话"}
        # 跨会话零波及
        assert client.mgr.list_tabs("task-b").value == before
        assert client.mgr.session_state("task-a").value["active_tab_id"] == ta

    async def test_claim_never_secretly_begins_a_session(self, client):
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body("t001", "x", "y", task="ghost"))
        assert resp.status == 200
        data = await resp.json()
        # 无会话的既有失败原样透出（认领不偷偷建会话）
        assert data["ok"] is False
        assert "no active browser session" in data["message"]

    @pytest.mark.parametrize("payload,as_json", [
        ("not json at all", False),
        ([1, 2, 3], True),
        ({"task_id": "task-a"}, True),          # 缺 object_id
    ])
    async def test_bad_body_is_400(self, client, payload, as_json):
        kwargs = {"data": payload} if not as_json else {"json": payload}
        resp = await client.post("/api/browser/claim", headers=_auth(client), **kwargs)
        assert resp.status == 400
        assert "error" in await resp.json()

    async def test_program_failure_is_500(self, client, monkeypatch):
        class Boom:
            def claim_tab(self, task_id, claim):
                raise RuntimeError("claim pipe broken")

        monkeypatch.setattr(hs, "_claim_session_manager", lambda: Boom())
        resp = await client.post("/api/browser/claim", headers=_auth(client),
                                 json=self._claim_body("t001", "A 页", "https://a.example"))
        assert resp.status == 500
        assert "claim endpoint failure" in (await resp.json())["error"]

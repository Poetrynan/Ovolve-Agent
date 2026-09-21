"""Test the local MCP memory server (official mcp SDK / FastMCP).

The protocol plumbing (initialize / tools/list dispatch / stdio framing) is now
owned by the official ``mcp`` package, so we don't re-test it here. What matters
for us is the TOOL CONTRACTS — the four handler functions and their behaviour.
storage and memory_layer are stubbed so these stay hermetic.
"""
import pytest

import memory_mcp_server as srv


def call(name, **kwargs):
    """Invoke a tool through the TOOLS view, same shape the SDK uses."""
    return srv.TOOLS[name]["handler"](kwargs)


class _FakeStorage:
    def __init__(self):
        self.rows = []
        self.searches = []

    def search_memory_semantic(self, root, query_embedding=None, keywords=None, limit=5):
        self.searches.append(
            {"root": root, "emb": query_embedding, "keywords": keywords, "limit": limit}
        )
        return self.rows[:limit]


class _FakeMemory:
    def __init__(self, has_emb=False):
        self.has_embeddings = has_emb
        self.stored = []

    def _embed_text(self, text):
        return [0.1, 0.2] if self.has_embeddings else None

    def _extract_keywords(self, text):
        return [w for w in text.split() if len(w) > 2]

    def store(self, mem):
        self.stored.append(mem)

        class R:
            ok = True
            value = "mem-1"
            error = None
        return R()


@pytest.fixture
def stubs(monkeypatch):
    storage = _FakeStorage()
    memory = _FakeMemory()
    monkeypatch.setattr(srv, "get_storage", lambda: storage)
    monkeypatch.setattr(srv, "get_memory_layer", lambda: memory)
    monkeypatch.setenv("OVOLVE_WORKSPACE", "/fake/ws")
    return storage, memory


# ── tool registry ───────────────────────────────────────────────────────────

def test_all_four_tools_registered():
    assert set(srv.TOOLS) == {"memory_search", "memory_add", "memory_list", "rules_list"}


def test_every_tool_has_a_description():
    for name, spec in srv.TOOLS.items():
        assert spec["description"], name


def test_fastmcp_app_is_named():
    assert srv.mcp.name == srv.SERVER_NAME


# ── memory_search ───────────────────────────────────────────────────────────

def test_search_returns_structured_results(stubs):
    storage, _ = stubs
    storage.rows = [
        {"id": "a", "content": "用户偏好 TypeScript", "type": "preference",
         "importance": 0.8, "created_at": 1},
    ]
    payload = call("memory_search", query="喜欢什么语言")
    assert payload["results"][0]["content"] == "用户偏好 TypeScript"
    assert payload["results"][0]["id"] == "a"


def test_search_reports_keyword_backend_without_embeddings(stubs):
    assert call("memory_search", query="任意查询")["backend"] == "keyword"


def test_search_reports_semantic_backend_when_embeddings_available(monkeypatch):
    storage = _FakeStorage()
    memory = _FakeMemory(has_emb=True)
    monkeypatch.setattr(srv, "get_storage", lambda: storage)
    monkeypatch.setattr(srv, "get_memory_layer", lambda: memory)
    payload = call("memory_search", query="语义查询")
    assert payload["backend"] == "semantic"
    assert storage.searches[0]["emb"] == [0.1, 0.2]


def test_search_rejects_empty_query(stubs):
    assert call("memory_search", query="   ")["error"]


def test_search_respects_limit(stubs):
    storage, _ = stubs
    storage.rows = [{"id": str(i), "content": f"m{i}"} for i in range(10)]
    assert len(call("memory_search", query="x", limit=3)["results"]) == 3


def test_search_clamps_oversized_limit(stubs):
    storage, _ = stubs
    storage.rows = [{"id": str(i), "content": f"m{i}"} for i in range(100)]
    call("memory_search", query="x", limit=999)
    assert storage.searches[0]["limit"] == 50   # clamped to max


# ── memory_add ──────────────────────────────────────────────────────────────

def test_add_persists_through_memory_layer(stubs):
    _, memory = stubs
    payload = call("memory_add", content="项目用 pnpm 不用 npm", type="preference",
                   importance=0.9, tags=["tooling"])
    assert payload["ok"] is True
    assert payload["id"] == "mem-1"
    stored = memory.stored[0]
    assert stored.content == "项目用 pnpm 不用 npm"
    assert stored.type == "preference"
    assert stored.importance == 0.9
    assert stored.tags == ["tooling"]


def test_add_rejects_empty_content(stubs):
    assert call("memory_add", content="")["error"]


def test_add_defaults_tags_to_empty_list(stubs):
    _, memory = stubs
    call("memory_add", content="x")
    assert memory.stored[0].tags == []


def test_add_uses_workspace_from_env(stubs):
    _, memory = stubs
    call("memory_add", content="x")
    assert memory.stored[0].root_dir == "/fake/ws"


# ── memory_list ─────────────────────────────────────────────────────────────

def test_list_paginates(stubs):
    storage, _ = stubs
    storage.rows = [{"id": str(i), "content": f"m{i}"} for i in range(10)]
    payload = call("memory_list", limit=3, offset=2)
    assert payload["total_returned"] == 3
    assert payload["items"][0]["id"] == "2"


def test_list_truncates_long_content(stubs):
    storage, _ = stubs
    storage.rows = [{"id": "a", "content": "x" * 500}]
    assert len(call("memory_list")["items"][0]["content"]) == 200


# ── rules_list ──────────────────────────────────────────────────────────────

def test_rules_list_returns_snapshot(monkeypatch, tmp_path):
    d = tmp_path / ".ovolve" / "rules"
    d.mkdir(parents=True)
    (d / "r.md").write_text("---\npriority: HIGH\n---\n# R\nbody", encoding="utf-8")
    monkeypatch.setenv("OVOLVE_WORKSPACE", str(tmp_path))
    import rule_engine
    monkeypatch.setattr(rule_engine, "_engine", None)
    payload = call("rules_list")
    assert payload["count"] >= 1
    assert any(r["priority"] == "HIGH" for r in payload["rules"])

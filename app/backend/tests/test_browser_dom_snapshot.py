"""Tests for Browser DOM snapshot and stable element ref protocol.

Based on community reference implementation for token-economic browser interaction.
"""
import pytest
from unittest.mock import MagicMock
from result import Result
from browser_dom_snapshot import (
    DOM_SNAPSHOT_JS,
    RefRegistry,
    render_compact,
    get_ref_registry,
)


def test_dom_snapshot_js_contract():
    assert isinstance(DOM_SNAPSHOT_JS, str)
    assert "120" in DOM_SNAPSHOT_JS
    assert "script" in DOM_SNAPSHOT_JS
    assert "style" in DOM_SNAPSHOT_JS
    assert "button" in DOM_SNAPSHOT_JS
    assert "input" in DOM_SNAPSHOT_JS


def test_ref_registry_lifecycle():
    reg = RefRegistry()
    tab_id = "tab-abc"
    elements = [
        {"ref": "e1", "tag": "button", "selector": "#btn-submit", "text": "Submit", "enabled": True},
        {"ref": "e2", "tag": "input", "selector": "input[name=\"search\"]", "placeholder": "Search", "enabled": True},
    ]

    reg.register(tab_id, elements)
    assert reg.resolve(tab_id, "e1") == "#btn-submit"
    assert reg.resolve(tab_id, "e2") == "input[name=\"search\"]"
    assert reg.resolve(tab_id, "e999") is None

    # Element metadata lookup
    meta = reg.get_element(tab_id, "e1")
    assert meta is not None
    assert meta["text"] == "Submit"

    # Invalidate tab (e.g. on navigate)
    reg.invalidate(tab_id)
    assert reg.resolve(tab_id, "e1") is None
    assert reg.resolve(tab_id, "e2") is None


def test_render_compact_format():
    elements = [
        {"ref": "e1", "tag": "button", "text": "Submit", "enabled": True},
        {"ref": "e2", "tag": "input", "placeholder": "Search query", "value": "test", "enabled": False},
        {"ref": "e3", "tag": "a", "role": "link", "text": "Pricing", "enabled": True},
    ]
    rendered = render_compact(elements)
    assert '[e1] button "Submit" (enabled)' in rendered
    assert '[e2] input placeholder="Search query" value="test" (disabled)' in rendered
    assert '[e3] a "Pricing" (enabled)' in rendered


def test_render_compact_truncation():
    elements = [
        {"ref": f"e{i}", "tag": "button", "text": f"Button {i} with long description text", "enabled": True}
        for i in range(150)
    ]
    max_chars = 500
    rendered = render_compact(elements, max_chars=max_chars)
    assert len(rendered) <= max_chars + 10
    assert "truncated" in rendered.lower()


class FakeClient:
    def __init__(self, eval_result=None):
        self.calls = []
        self.eval_result = eval_result or []

    def call(self, endpoint, payload, timeout=35):
        self.calls.append((endpoint, payload))
        if endpoint == "evaluate":
            return Result.success(self.eval_result)
        if endpoint == "click":
            return Result.success(True)
        if endpoint == "fill":
            return Result.success(True)
        return Result.success({"ok": True})


def test_click_and_fill_with_ref():
    from browser_agent import _click, _fill
    client = FakeClient()
    reg = get_ref_registry()
    tab_id = "test-tab-ref"
    ctx = {"client": client, "tab_id": tab_id}

    reg.register(tab_id, [
        {"ref": "e1", "selector": "#login-btn", "tag": "button"},
        {"ref": "e2", "selector": "#username-input", "tag": "input"},
    ])

    # Valid ref click
    res = _click({"ref": "e1"}, ctx)
    assert res.ok
    assert any(c[0] == "click" and c[1].get("selector") == "#login-btn" for c in client.calls)

    # Invalid / expired ref click
    res_invalid = _click({"ref": "e999"}, ctx)
    assert not res_invalid.ok
    assert any(w in res_invalid.error for w in ["变化", "无效", "snapshot", "expired", "invalid"])

    # Valid ref fill
    res_fill = _fill({"ref": "e2", "value": "alice"}, ctx)
    assert res_fill.ok
    assert any(c[0] == "fill" and c[1].get("selector") == "#username-input" for c in client.calls)


def test_snapshot_returns_compact_dom():
    from browser_agent import _snapshot
    mock_dom = [
        {"ref": "e1", "tag": "button", "selector": "#ok-btn", "text": "OK", "enabled": True, "rect": {"x": 10, "y": 20, "w": 30, "h": 40}},
    ]
    client = FakeClient(eval_result=mock_dom)
    ctx = {"client": client, "tab_id": "snap-tab"}

    res = _snapshot({}, ctx)
    assert res.ok
    assert '[e1] button "OK" (enabled)' in res.value
    # Ensure ref was registered
    reg = get_ref_registry()
    assert reg.resolve("snap-tab", "e1") == "#ok-btn"


def test_navigate_includes_snapshot():
    from browser_agent import _navigate
    reg = get_ref_registry()
    mock_dom = [
        {"ref": "e1", "tag": "button", "selector": "#nav-btn", "text": "Click me", "enabled": True}
    ]
    client = FakeClient(eval_result=mock_dom)
    mock_sessions = MagicMock()
    mock_sessions.navigate_tab.return_value = Result.success({"tab_id": "tab-nav-1", "title": "Test Title"})

    ctx = {"client": client, "_agent": MagicMock(sessions=mock_sessions)}
    res = _navigate({"url": "https://dashboard.example"}, ctx)
    assert res.ok
    assert "Navigated to: https://dashboard.example" in res.value
    assert "--- Page Snapshot ---" in res.value
    assert '[e1] button "Click me" (enabled)' in res.value
    assert reg.resolve("tab-nav-1", "e1") == "#nav-btn"



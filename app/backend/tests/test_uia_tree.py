"""uia_tree.py — Windows UI Automation 无障碍树读取的专项测试。

不依赖真实桌面：COM 后端全部注入假实现，测裁剪/过滤/坐标/降级契约。
真机冒烟单独跑（test_uia_smoke_manual，默认 skip）。
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from uia_tree import (
    UiaNode,
    walk_elements,
    find_elements,
    node_to_dict,
    budget_trim,
    resolve_element_target,
    UIA_UNAVAILABLE,
    MAX_NODES,
    MAX_DEPTH,
)


def _node(name, ntype="Button", rect=(10, 20, 100, 40), enabled=True, offscreen=False, automation_id=""):
    return UiaNode(
        name=name, control_type=ntype,
        rect=rect, enabled=enabled, offscreen=offscreen,
        automation_id=automation_id,
    )


# ── 1. 树遍历与预算裁剪 ──────────────────────────────────────────────

def test_budget_trim_respects_node_cap():
    nodes = [_node(f"btn{i}") for i in range(MAX_NODES + 50)]
    trimmed = budget_trim(nodes, max_nodes=MAX_NODES)
    assert len(trimmed) == MAX_NODES
    assert trimmed[0].name == "btn0"


def test_budget_trim_custom_cap():
    nodes = [_node(f"n{i}") for i in range(30)]
    assert len(budget_trim(nodes, max_nodes=10)) == 10


class _FakeBackend:
    """符合 UiaBackend 协议的假后端：read_window 返回预置节点。"""

    def __init__(self, nodes):
        self._nodes = nodes

    def read_window(self, hwnd, max_nodes, max_depth):
        return self._nodes


def test_walk_uses_fake_backend_and_budgets():
    nodes = [_node("七"), _node("八", ntype="Text"), _node("九")]
    got = walk_elements(hwnd=0, backend=_FakeBackend(nodes), max_nodes=MAX_NODES)
    assert not isinstance(got, str)  # 假后端有值 → 一定是 list，非降级标记
    assert [n.name for n in got] == ["七", "八", "九"]


def test_walk_backend_raising_reports_unavailable():
    class _Boom:
        def read_window(self, hwnd, max_nodes, max_depth):
            raise OSError("COM dead")

    assert walk_elements(hwnd=1, backend=_Boom()) is UIA_UNAVAILABLE


def test_walk_none_backend_reports_unavailable():
    assert walk_elements(hwnd=123, backend=None) is UIA_UNAVAILABLE


# ── 2. find_elements 条件过滤 ────────────────────────────────────────

def test_find_by_name_substring_case_insensitive():
    fake = [_node("保存并关闭"), _node("取消")]
    hits = find_elements(fake, name="关闭")
    assert len(hits) == 1 and hits[0].name == "保存并关闭"


def test_find_by_control_type_and_name():
    fake = [_node("七", ntype="Button"), _node("七", ntype="Text")]
    hits = find_elements(fake, name="七", control_type="Button")
    assert len(hits) == 1 and hits[0].control_type == "Button"


def test_find_by_automation_id():
    fake = [_node("OK", automation_id="btnSubmit"), _node("Cancel", automation_id="btnCancel")]
    hits = find_elements(fake, automation_id="btnCancel")
    assert len(hits) == 1 and hits[0].automation_id == "btnCancel"


def test_find_skips_offscreen_and_disabled():
    fake = [_node("隐形", offscreen=True), _node("禁用", enabled=False), _node("可用")]
    hits = find_elements(fake, name="")
    assert [h.name for h in hits] == ["可用"]


def test_find_returns_all_when_no_conditions():
    fake = [_node("a"), _node("b")]
    assert len(find_elements(fake)) == 2


# ── 3. 坐标换算（物理→逻辑 DPI 补偿）────────────────────────────────

def test_node_center_and_dpi_compensation():
    n = _node("btn", rect=(200, 100, 300, 140))  # 物理像素
    d = node_to_dict(n, scale_factor=1.5)
    # 中心 (250, 120) 物理 → 逻辑 (167, 80)
    assert d["center"] == [167, 80]
    assert d["rect"] == [200, 100, 300, 140]


def test_node_center_scale_one():
    n = _node("btn", rect=(0, 0, 100, 50))
    d = node_to_dict(n, scale_factor=1.0)
    assert d["center"] == [50, 25]


# ── 4. resolve_element_target：find + 坐标一步到位 ───────────────────

def test_resolve_target_first_visible():
    fake = [_node("七", rect=(0, 0, 40, 20)), _node("七", rect=(40, 0, 80, 20))]
    ok, val = resolve_element_target(fake, {"name": "七"})
    assert ok is True and val == (20, 10)


def test_resolve_target_occurrence_beyond_range():
    fake = [_node("七", rect=(0, 0, 40, 20))]
    ok, err = resolve_element_target(fake, {"name": "七", "index": 2})
    assert ok is False and "index=2" in err and "超出范围" in err


def test_resolve_target_no_match_hints_fallback():
    fake = [_node("取消")]
    ok, err = resolve_element_target(fake, {"name": "确定"})
    assert ok is False and UIA_UNAVAILABLE[:10] not in err  # 明确的"未找到"而非不可用
    assert "click_text" in err  # 引导降级


def test_resolve_target_by_automation_id():
    fake = [_node("OK", automation_id="btnOk", rect=(0, 0, 60, 24))]
    ok, val = resolve_element_target(fake, {"automation_id": "btnOk"})
    assert ok is True and val == (30, 12)


# ── 5. 真机冒烟（需要真实 Windows 桌面；CI/无头默认跳过）────────────

@pytest.mark.skipif(os.name != "nt" or os.environ.get("OVOLVE_UIA_SMOKE") != "1",
                    reason="manual smoke: set OVOLVE_UIA_SMOKE=1 on a real desktop")
def test_uia_smoke_notepad_window_has_tree():
    import ctypes
    hwnd = ctypes.windll.user32.FindWindowW("Notepad", None)
    if not hwnd:
        pytest.skip("no Notepad window open")
    backend = None
    try:
        from uia_tree import CtypesUiaBackend
        backend = CtypesUiaBackend()
    except Exception:
        pytest.skip("UIA COM unavailable on this host")
    nodes = walk_elements(hwnd=hwnd, backend=backend, max_nodes=50)
    assert nodes is not UIA_UNAVAILABLE
    assert len(nodes) > 0

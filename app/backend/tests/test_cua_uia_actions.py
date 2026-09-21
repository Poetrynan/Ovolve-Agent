"""cua_actions 的 UIA 语义动作接入测试（element_tree / click_element）。

聚焦动作层契约：注册、能力路由、降级路径、后端注入、绝不盲点。
真实 COM 读取由 CtypesUiaBackend 的真机冒烟覆盖（OVOLVE_UIA_SMOKE=1）。

替身策略：全部走**依赖注入**——实例化真实的 CuaDesktopBackend，只替换它
的两个外部依赖（native 引擎、UIA 后端）。这样被测代码与生产完全同一条
路径；早先用"往假后端上混入方法"的写法，混入在 pytest 收集时不生效，
5 条测试全红且报错信息指向"后端不支持动作"，极具误导性。
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from result import Result
from cua_actions import (
    ACTION_SPECS, CuaActionRegistry, CuaDesktopBackend,
)
from uia_tree import UiaNode, UIA_UNAVAILABLE

#: 测试用的伪窗口句柄。待测动作只把它透传给 UIA 后端，不参与真实窗口查找。
_HWND = 0x1234


def _node(name, ntype="Button", rect=(0, 0, 100, 40), enabled=True,
          offscreen=False, automation_id=""):
    return UiaNode(name=name, control_type=ntype, rect=rect, enabled=enabled,
                   offscreen=offscreen, automation_id=automation_id)


class _FakeUiaBackend:
    """符合 uia_tree.UiaBackend 协议的假后端。"""

    def __init__(self, nodes, fail=False):
        self._nodes = nodes
        self._fail = fail
        self.seen_hwnd = None

    def read_window(self, hwnd, max_nodes, max_depth):
        self.seen_hwnd = hwnd
        if self._fail:
            return None
        return self._nodes[:max_nodes]


class _FakeEngine:
    """native 引擎替身。

    注意签名是 native 引擎的 ``click(x=, y=, button=, clicks=)``，与后端
    自身的动作方法 ``click(params, ctx)`` 不是一回事——click_element 复用
    的是前者。
    """

    def __init__(self):
        self.calls = []

    def click(self, x, y, button="left", clicks=1):
        self.calls.append({"x": x, "y": y, "button": button, "clicks": clicks})
        return True


class _FakeGuard:
    """永远放行的修饰键守卫替身。"""

    def wait_for_bare_state(self, timeout_ms=500, check_interval_ms=25, check_mouse=False):
        return (True, "clean (fake)")


class _FakeRules:
    """放行全部权限的规则替身（动作级权限路由单测在别处已覆盖）。"""

    def evaluate(self, spec, params, ctx):  # pragma: no cover - 未被触及时
        return None


def _make_registry(uia_backend, engine=None):
    """真实后端 + 注入依赖。engine 可外传以便断言点击调用。"""
    engine = engine if engine is not None else _FakeEngine()
    backend = CuaDesktopBackend(engine=engine,
                                ocr_fn=lambda *a, **k: Result.failure("no ocr"))
    backend._uia_backend = uia_backend  # 注入 UIA 后端（生产由懒加载提供）
    return CuaActionRegistry(backend=backend, modifier_guard=_FakeGuard(),
                             rules=_FakeRules()), engine


# ── 注册与元数据 ─────────────────────────────────────────────────────

def test_element_actions_registered():
    names = {s.name for s in ACTION_SPECS}
    assert "element_tree" in names and "click_element" in names


def test_capability_routing():
    by_name = {s.name: s for s in ACTION_SPECS}
    assert by_name["element_tree"].guard_tool == "snapshot"        # 感知类
    assert by_name["click_element"].guard_tool == "computer_click"  # 点击类


# ── element_tree ─────────────────────────────────────────────────────

def test_element_tree_returns_dicts():
    nodes = [_node("七", rect=(0, 0, 40, 20)), _node("八", ntype="Text")]
    reg, _ = _make_registry(_FakeUiaBackend(nodes))
    r = reg.execute("element_tree", {"hwnd": _HWND}, ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert [d["name"] for d in r.details["elements"]] == ["七", "八"]
    assert r.details["count"] == 2


def test_element_tree_filters_by_name():
    nodes = [_node("七"), _node("八"), _node("九")]
    reg, _ = _make_registry(_FakeUiaBackend(nodes))
    r = reg.execute("element_tree", {"hwnd": _HWND, "name": "八"},
                    ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert [d["name"] for d in r.details["elements"]] == ["八"]


def test_element_tree_unavailable_degrades_honestly():
    reg, _ = _make_registry(_FakeUiaBackend([], fail=True))
    r = reg.execute("element_tree", {"hwnd": _HWND}, ctx={"skip_feedback": True})
    assert not r.ok
    assert UIA_UNAVAILABLE in r.error
    assert "OCR" in r.error or "坐标" in r.error  # 引导降级


def test_element_tree_missing_hwnd():
    reg, _ = _make_registry(_FakeUiaBackend([_node("x")]))
    r = reg.execute("element_tree", {}, ctx={"skip_feedback": True})
    assert not r.ok and "hwnd" in r.error


# ── click_element ────────────────────────────────────────────────────

def test_click_element_resolves_and_clicks():
    nodes = [_node("七", rect=(200, 100, 240, 120))]
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend(nodes), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "七"}},
                    ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert engine.calls == [{"x": 220, "y": 110, "button": "left", "clicks": 1}]
    assert r.details["clicked"] == [220, 110]


def test_click_element_no_match_reports_and_never_clicks():
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend([_node("取消")]), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "确定"}},
                    ctx={"skip_feedback": True})
    assert not r.ok
    assert engine.calls == []          # 绝不盲点
    assert "click_text" in r.error     # 引导降级


def test_click_element_missing_target_param():
    reg, _ = _make_registry(_FakeUiaBackend([_node("x")]))
    r = reg.execute("click_element", {"hwnd": _HWND}, ctx={"skip_feedback": True})
    assert not r.ok and "target" in r.error


def test_click_element_respects_index():
    """index 是人类序数（从 1 起），越界必须报错而不是静默点第一个。"""
    nodes = [_node("七", rect=(0, 0, 10, 10)), _node("七", rect=(50, 50, 70, 70))]
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend(nodes), engine=engine)
    r = reg.execute("click_element",
                    {"hwnd": _HWND, "target": {"name": "七", "index": 2}},
                    ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert engine.calls[0]["x"] == 60 and engine.calls[0]["y"] == 60


def test_click_element_uia_unavailable_degrades():
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend([], fail=True), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "七"}},
                    ctx={"skip_feedback": True})
    assert not r.ok
    assert UIA_UNAVAILABLE in r.error
    assert engine.calls == []


# ── window_list：给 element_tree / click_element 提供 hwnd ───────────────
#
# 这两个动作都要求 hwnd，而模型没有别的地方能拿到它。少一个枚举窗口的动作，
# 它们就是"注册了但不可达"——schema 里看得见，实际用不了。

def test_window_list_registered_as_perceive_action():
    by_name = {s.name: s for s in ACTION_SPECS}
    assert "window_list" in by_name
    assert by_name["window_list"].guard_tool == "snapshot"   # 纯读，与截图同级
    assert by_name["window_list"].side_effect is False


def test_window_list_returns_hwnd_and_title(monkeypatch):
    import cua_actions

    fake = [{"hwnd": 0x1234, "title": "计算器", "pid": 42, "visible": True}]
    monkeypatch.setattr(cua_actions, "_list_top_level_windows", lambda: fake)
    backend = CuaDesktopBackend(engine=_FakeEngine(), ocr_fn=None)
    r = backend.window_list({}, {})
    assert r.ok, r.error
    assert r.value["windows"] == fake and r.value["count"] == 1


def test_window_list_filters_by_title(monkeypatch):
    import cua_actions

    fake = [
        {"hwnd": 1, "title": "计算器", "pid": 42, "visible": True},
        {"hwnd": 2, "title": "记事本", "pid": 43, "visible": True},
    ]
    monkeypatch.setattr(cua_actions, "_list_top_level_windows", lambda: fake)
    backend = CuaDesktopBackend(engine=_FakeEngine(), ocr_fn=None)
    r = backend.window_list({"title": "记事"}, {})
    assert r.ok and [w["hwnd"] for w in r.value["windows"]] == [2]


def test_window_list_respects_limit(monkeypatch):
    import cua_actions

    fake = [{"hwnd": i, "title": f"w{i}", "pid": 0, "visible": True}
            for i in range(30)]
    monkeypatch.setattr(cua_actions, "_list_top_level_windows", lambda: fake)
    backend = CuaDesktopBackend(engine=_FakeEngine(), ocr_fn=None)
    r = backend.window_list({"limit": 5}, {})
    assert r.ok and len(r.value["windows"]) == 5


def test_window_list_failure_degrades_honestly(monkeypatch):
    import cua_actions

    def _boom():
        raise OSError("no desktop session")

    monkeypatch.setattr(cua_actions, "_list_top_level_windows", _boom)
    backend = CuaDesktopBackend(engine=_FakeEngine(), ocr_fn=None)
    r = backend.window_list({}, {})
    assert not r.ok and "desktop" in r.error.lower()


def test_missing_hwnd_error_points_at_a_real_action():
    """错误文案里推荐的动作必须真实存在——推荐一个不存在的工具是死胡同。"""
    from cua_actions import ACTION_SPECS as _SPECS

    known = {s.name for s in _SPECS}
    backend = CuaDesktopBackend(engine=_FakeEngine(), ocr_fn=None)
    for action in ("element_tree", "click_element"):
        params = {"target": {"name": "x"}} if action == "click_element" else {}
        r = backend.__getattribute__(action)(params, {})
        assert not r.ok and "hwnd" in r.error
        mentioned = [n for n in known if n in r.error]
        assert mentioned, f"{action} 的错误文案没指向任何真实动作：{r.error}"


def test_click_element_refuses_offscreen_coordinate(monkeypatch):
    """最小化的窗口会把元素摆在 (-32000, -32000) 一带，UIA 照实报出来。
    照着点等于往屏幕外发 SendInput——什么都不会发生，但调用方以为点成功了。"""
    import cua_actions

    monkeypatch.setattr(cua_actions, "_virtual_screen_bounds",
                        lambda: (0, 0, 1536, 864))
    nodes = [_node("上一行", rect=(-24471, -25526, -24457, -25509))]
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend(nodes), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "上一行"}},
                    ctx={"skip_feedback": True})
    assert not r.ok
    assert engine.calls == []          # 绝不盲点
    assert "屏幕外" in r.error
    assert "window_list" in r.error    # 引导到真实存在的动作


def test_click_element_allows_negative_origin_multimonitor(monkeypatch):
    """多显示器左副屏的原点是负的——不能拿"坐标为负"当判据。"""
    import cua_actions

    monkeypatch.setattr(cua_actions, "_virtual_screen_bounds",
                        lambda: (-1920, 0, 3456, 1080))
    nodes = [_node("确定", rect=(-1000, 100, -960, 120))]   # 中心 (-980, 110)
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend(nodes), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "确定"}},
                    ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert engine.calls[0]["x"] == -980


def test_click_element_skips_guard_when_bounds_unknown(monkeypatch):
    """边界取不到时放行：这是尽力而为的检查，不是安全边界。"""
    import cua_actions

    monkeypatch.setattr(cua_actions, "_virtual_screen_bounds",
                        lambda: (0, 0, 0, 0))
    nodes = [_node("七", rect=(-5000, -5000, -4980, -4980))]
    engine = _FakeEngine()
    reg, _ = _make_registry(_FakeUiaBackend(nodes), engine=engine)
    r = reg.execute("click_element", {"hwnd": _HWND, "target": {"name": "七"}},
                    ctx={"skip_feedback": True})
    assert r.ok, r.error
    assert len(engine.calls) == 1


def test_no_reference_to_nonexistent_window_tool():
    """回归护栏：曾经有文案推荐 win_list_windows，而那个动作根本不存在。"""
    import cua_actions

    known = {s.name for s in ACTION_SPECS}
    src = open(cua_actions.__file__, encoding="utf-8").read()
    assert "win_list_windows" not in src, "文案又指向了不存在的动作"
    assert "window_list" in known

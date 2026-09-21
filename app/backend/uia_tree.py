# -*- coding: utf-8 -*-
"""uia_tree.py - Windows UI Automation（无障碍树）读取与语义元素定位。

## 解决什么

CUA 原有的目标定位只有两条路：OCR 文本锚点与裸坐标。对无文本 UI（图标
按钮、自绘控件、画布应用）命中率低。无障碍树给出第三条路：语义元素——
Name / ControlType / AutomationID / BoundingRectangle / IsEnabled，定位
精度与 token 成本双优。

## 结构（零第三方依赖）

    UiaNode            元素快照：纯数据，无 COM 对象泄漏到调用侧
    walk_elements      遍历入口：backend 可注入（测试用假后端）
    find_elements      条件过滤：name / control_type / automation_id
    budget_trim        节点预算裁剪：MAX_NODES / MAX_DEPTH 防上下文爆炸
    node_to_dict       序列化：中心点做 DPI 物理→逻辑补偿
    resolve_element_target    find + 坐标一步到位（click_element 用）
    UIA_UNAVAILABLE    降级标记：树拿不到时引导模型退回 click_text / 坐标

## 预算纪律

UIA 树在复杂窗口能轻易长到数千节点。硬顶 MAX_NODES=200 / MAX_DEPTH=8：
超出即截断，节点名截 80 字符。宁可信息少，不可上下文爆炸——这条与
tool_output_spill / SmartLogBox 是同一条纪律在三个层的落点。

## 与 CUA 的关系

本模块只做"读"。点击仍走既有管线：resolve_element_target 返回逻辑坐标
→ cua_actions 的 click 动作（Bezier 移动 + bare_modifier_guard 前置检查）
不变。语义定位只是换了一种"找坐标"的方式，执行与安全层零改动。

## 真后端

CtypesUiaBackend 用 ctypes 直调 IUIAutomation 的 vtable（零第三方依赖）。
UIA 的接口都是 IUnknown 派生、没有 IDispatch，晚绑定这条路根本走不通，
必须按槽位直调；槽位与控件类型编号全部取自系统自带的
UIAutomationCore.dll 类型库，并在真机上逐条核对过（见槽位常量处的注释）。

构造失败（无桌面会话 / COM 不可用）直接抛 OSError，调用方据此降级——
绝不静默假装可用。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol, Tuple, Union

if sys.platform == "win32":  # pragma: no cover - 纯函数层在非 Windows 也要可导入
    import ctypes

#: 节点硬顶与深度硬顶（防上下文爆炸，见模块 docstring 的预算纪律）
MAX_NODES = 200
MAX_DEPTH = 8

#: 降级标记：walk_elements 拿不到树时返回它（与假后端注入契约对齐）
UIA_UNAVAILABLE = "uia_unavailable"

#: 节点名截断长度
_NAME_CAP = 80


@dataclass
class UiaNode:
    """一个 UIA 元素的快照。坐标为物理像素（与截图一致）。"""

    name: str
    control_type: str
    rect: Tuple[int, int, int, int]          # (left, top, right, bottom) 物理像素
    enabled: bool = True
    offscreen: bool = False
    automation_id: str = ""

    @property
    def center_physical(self) -> Tuple[int, int]:
        left, top, right, bottom = self.rect
        return ((left + right) // 2, (top + bottom) // 2)


# ── 后端协议（鸭子类型，测试注入假实现）────────────────────────────

class UiaBackend(Protocol):
    """后端契约：给 hwnd 返回扁平元素快照列表，失败返回 None。"""

    def read_window(self, hwnd: int, max_nodes: int, max_depth: int) -> Optional[List[UiaNode]]:  # pragma: no cover
        ...


# ── 纯函数层（测试的主战场）────────────────────────────────────────

def budget_trim(nodes: List[UiaNode], max_nodes: int = MAX_NODES) -> List[UiaNode]:
    """节点预算裁剪：保序截断。"""
    if max_nodes <= 0:
        return []
    return nodes[:max_nodes]


def walk_elements(
    hwnd: int,
    backend: Optional[UiaBackend],
    max_nodes: int = MAX_NODES,
    max_depth: int = MAX_DEPTH,
) -> Union[List[UiaNode], str]:
    """遍历入口。backend 缺席或读失败 → 返回 UIA_UNAVAILABLE（降级契约）。"""
    if backend is None:
        return UIA_UNAVAILABLE
    try:
        got = backend.read_window(hwnd, max_nodes, max_depth)
    except Exception:
        return UIA_UNAVAILABLE
    if got is None:
        return UIA_UNAVAILABLE
    return budget_trim(list(got), max_nodes)


def _norm_text(v: Any) -> str:
    return str(v or "").strip().lower()


def find_elements(
    nodes: List[UiaNode],
    name: str = "",
    control_type: str = "",
    automation_id: str = "",
    include_offscreen: bool = False,
    include_disabled: bool = False,
) -> List[UiaNode]:
    """条件过滤。空条件 = 全取（仍受可见/可用默认过滤约束）。

    name 走大小写不敏感的子串匹配（与 cua_text_anchor 的 OCR 检索一致）；
    control_type / automation_id 精确匹配。
    """
    n_key = _norm_text(name)
    ct_key = _norm_text(control_type)
    aid_key = _norm_text(automation_id)
    hits: List[UiaNode] = []
    for nd in nodes:
        if not include_offscreen and nd.offscreen:
            continue
        if not include_disabled and not nd.enabled:
            continue
        if n_key and n_key not in _norm_text(nd.name):
            continue
        if ct_key and _norm_text(nd.control_type) != ct_key:
            continue
        if aid_key and _norm_text(nd.automation_id) != aid_key:
            continue
        hits.append(nd)
    return hits


def node_to_dict(node: UiaNode, scale_factor: float = 1.0) -> Dict[str, Any]:
    """序列化。中心点做 DPI 物理→逻辑补偿（截图是物理像素、SendInput 用
    逻辑坐标，与 cua_text_anchor.calculate_dpi_compensated_coords 同一约定）。"""
    factor = float(scale_factor or 1.0)
    if factor <= 0.01:
        factor = 1.0
    cx, cy = node.center_physical
    return {
        "name": node.name[:_NAME_CAP],
        "type": node.control_type,
        "automation_id": node.automation_id[:_NAME_CAP],
        "rect": [int(node.rect[0]), int(node.rect[1]), int(node.rect[2]), int(node.rect[3])],
        "center": [int(round(cx / factor)), int(round(cy / factor))],
        "enabled": node.enabled,
    }


def resolve_element_target(
    nodes: List[UiaNode],
    target: Dict[str, Any],
    scale_factor: float = 1.0,
) -> Tuple[bool, Union[Tuple[int, int], str]]:
    """find + 坐标一步到位（click_element 动作的定位核）。

    target: {name?, control_type?, automation_id?, index?}，index 从 1 起
    （人类序数，与 click_text 的 occurrence 语义一致）。

    返回 (True, (x, y)) 或 (False, 错误说明)。失败文案必须引导降级：
    提到 click_text / 坐标，模型才知道下一步怎么走。
    """
    try:
        idx = int(target.get("index") or 1)
    except (TypeError, ValueError):
        idx = 1
    if idx < 1:
        return (False, f"index 必须从 1 起，收到 {idx}。可改用 click_text 走 OCR 定位，或直接给坐标。")

    hits = find_elements(
        nodes,
        name=str(target.get("name") or ""),
        control_type=str(target.get("control_type") or ""),
        automation_id=str(target.get("automation_id") or ""),
    )
    if not hits:
        return (False, f"在无障碍树中未找到匹配元素（name={target.get('name')!r}）。"
                       "可改用 click_text 走 OCR 定位，或直接给坐标。")
    if idx > len(hits):
        return (False, f"匹配到 {len(hits)} 个元素，指定的 index={idx} 超出范围"
                       f"（occurrence={idx}）。可改用 click_text 走 OCR 定位，或直接给坐标。")
    d = node_to_dict(hits[idx - 1], scale_factor=scale_factor)
    return (True, (d["center"][0], d["center"][1]))


# ── 真后端：ctypes vtable 直调（零第三方依赖）────────────────────────

#: CUIAutomation coclass 的 CLSID（typelib 核实：COCLASS CUIAutomation）
_CLSID_CUIAUTOMATION = "{ff48dba4-60ef-4201-aa87-54103eef594e}"

#: IUIAutomation 的 IID。
#:
#: 注意：网上流传的 ``{30cbe57d-d9d3-4eac-bca0-3574289fd0f1}`` 是错的——前
#: 4 字节对、后半段是编的，用它 CoCreateInstance 会回 0x80040154
#: (REGDB_E_CLASSNOTREG)，且错误信息指向"类未注册"极易误导排查方向。真值
#: 取自 UIAutomationCore.dll 内嵌 typelib 中 IUIAutomation 的 TYPEATTR.guid。
_IID_IUIAUTOMATION = "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}"

#: vtable 槽位。全部由 UIAutomationCore.dll 的 typelib（ITypeInfo 的
#: FUNCDESC.oVft）导出，不是凭记忆写的——参见 scratch/uia_probe_vtable.py。
#: IUnknown 占 0/1/2，接口成员从 3 起。
_SLOT_IUIA_GET_ROOT = 5
_SLOT_IUIA_FROM_HANDLE = 6
_SLOT_IUIA_CONTROL_VIEW_WALKER = 14
_SLOT_ELEM_CURRENT_CONTROL_TYPE = 21
_SLOT_ELEM_CURRENT_NAME = 23
_SLOT_ELEM_CURRENT_ENABLED = 28
_SLOT_ELEM_CURRENT_AUTOMATION_ID = 29
_SLOT_ELEM_CURRENT_OFFSCREEN = 38
_SLOT_ELEM_CURRENT_BOUNDING_RECT = 43
_SLOT_WALKER_FIRST_CHILD = 4
_SLOT_WALKER_NEXT_SIBLING = 6

#: CONTROLTYPEID → 名称。UIA 的控件类型编号是 50000 基准（不是 0 基准）。
#: 这套编号在真机上逐条核对过：50000=开始/搜索按钮、50007=桌面图标列表项、
#: 50032=顶层窗口、50033=桌面/任务栏窗格、50011=菜单项、50019=选项卡。
_CONTROL_TYPE_NAMES = {
    50000: "Button", 50001: "Calendar", 50002: "CheckBox",
    50003: "ComboBox", 50004: "Edit", 50005: "Hyperlink", 50006: "Image",
    50007: "ListItem", 50008: "List", 50009: "Menu", 50010: "MenuBar",
    50011: "MenuItem", 50012: "ProgressBar", 50013: "RadioButton",
    50014: "ScrollBar", 50015: "Slider", 50016: "Spinner",
    50017: "StatusBar", 50018: "Tab", 50019: "TabItem", 50020: "Text",
    50021: "ToolBar", 50022: "ToolTip", 50023: "Tree", 50024: "TreeItem",
    50025: "Custom", 50026: "Group", 50027: "Thumb", 50028: "DataGrid",
    50029: "DataItem", 50030: "Document", 50031: "SplitButton",
    50032: "Window", 50033: "Pane", 50034: "Header", 50035: "HeaderItem",
    50036: "Table", 50037: "TitleBar", 50038: "Separator",
    50039: "SemanticZoom", 50040: "AppBar",
}


class _Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


def _vtable(ptr):
    """接口指针 → 函数指针数组。

    COM 对象首字段才是 vtable 指针，必须解两层；只解一层读到的是对象字段，
    调下去就是拿数据当代码执行（这个坑踩过一次，代价是半天）。
    """
    vptr = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p)).contents
    return ctypes.cast(vptr, ctypes.POINTER(ctypes.c_void_p))


def _com(ptr, slot, restype, *argtypes):
    """按槽位取 COM 成员函数；返回的函数已绑定 this 指针。"""
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    fn = ctypes.cast(_vtable(ptr)[slot], proto)

    def _invoke(*args):
        return fn(ptr, *args)

    return _invoke


class CtypesUiaBackend:
    """真实现：ctypes 直调 IUIAutomation vtable（零依赖）。

    读树路径固定为 ElementFromHandle → ControlViewWalker 深度优先
    （GetFirstChildElement / GetNextSiblingElement）。ControlView 只保留
    对用户有意义的可交互控件，天然滤掉 RawView 里成百上千个无名字容器，
    这是节点预算能压在 MAX_NODES 以内的前提。

    结构上不存在环（孩子 + 兄弟的树遍历），防失控靠 MAX_DEPTH / MAX_NODES
    双硬顶，不靠运行时 id 去重。

    构造失败（无桌面会话 / COM 拒绝）抛 OSError：调用方 catch 后降级到
    OCR / 坐标路径，绝不静默假装可用。
    """

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise OSError("CtypesUiaBackend only runs on Windows")
        self._ole32 = ctypes.windll.ole32
        self._oleaut32 = ctypes.windll.oleaut32
        # COINIT_APARTMENTTHREADED = 0x2；RPC_E_CHANGED_MODE(0x80010106) 说明
        # 宿主已用 MTA 初始化——照样能用，只是别 CoUninitialize。
        hr = self._ole32.CoInitializeEx(None, 0x2)
        self._coinited = hr in (0, 1)  # S_OK / S_FALSE
        self._uia = None
        try:
            self._uia = self._create_automation()
        except Exception as exc:
            if self._coinited:
                self._ole32.CoUninitialize()
            raise OSError(f"UIA COM unavailable: {exc}") from exc

    def _guid(self, text: str) -> "_GUID":
        g = _GUID()
        hr = self._ole32.CLSIDFromString(text, ctypes.byref(g))
        if hr != 0:
            raise OSError(f"CLSIDFromString({text}) failed: {hr:#x}")
        return g

    def _create_automation(self) -> ctypes.c_void_p:
        """CoCreateInstance(CUIAutomation, IID_IUIAutomation)。"""
        clsid = self._guid(_CLSID_CUIAUTOMATION)
        iid = self._guid(_IID_IUIAUTOMATION)
        out = ctypes.c_void_p()
        hr = self._ole32.CoCreateInstance(
            ctypes.byref(clsid), None, 1,  # CLSCTX_INPROC_SERVER
            ctypes.byref(iid), ctypes.byref(out))
        if hr != 0 or not out.value:
            raise OSError(f"CoCreateInstance(CUIAutomation) failed: {hr:#x}")
        return out

    # ── 属性读取（失败一律给安全默认值，绝不向上抛）────────────────

    def _bstr(self, el, slot) -> str:
        out = ctypes.c_void_p()
        try:
            if _com(el, slot, ctypes.c_long,
                    ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(out)) != 0:
                return ""
            if not out.value:
                return ""
            try:
                return ctypes.wstring_at(out.value)
            finally:
                self._oleaut32.SysFreeString(out)
        except Exception:
            return ""

    def _int(self, el, slot) -> int:
        v = ctypes.c_int(0)
        try:
            _com(el, slot, ctypes.c_long,
                 ctypes.POINTER(ctypes.c_int))(ctypes.byref(v))
        except Exception:
            return 0
        return int(v.value)

    def _flag(self, el, slot) -> bool:
        v = ctypes.c_int(0)
        try:
            hr = _com(el, slot, ctypes.c_long,
                      ctypes.POINTER(ctypes.c_int))(ctypes.byref(v))
        except Exception:
            return False
        return hr == 0 and bool(v.value)

    def _rect(self, el, slot) -> Tuple[int, int, int, int]:
        r = _Rect()
        try:
            if _com(el, slot, ctypes.c_long,
                    ctypes.POINTER(_Rect))(ctypes.byref(r)) != 0:
                return (0, 0, 0, 0)
        except Exception:
            return (0, 0, 0, 0)
        return (int(r.left), int(r.top), int(r.right), int(r.bottom))

    def _snapshot(self, el) -> UiaNode:
        return UiaNode(
            name=self._bstr(el, _SLOT_ELEM_CURRENT_NAME),
            control_type=_CONTROL_TYPE_NAMES.get(
                self._int(el, _SLOT_ELEM_CURRENT_CONTROL_TYPE), "Unknown"),
            rect=self._rect(el, _SLOT_ELEM_CURRENT_BOUNDING_RECT),
            enabled=self._flag(el, _SLOT_ELEM_CURRENT_ENABLED),
            offscreen=self._flag(el, _SLOT_ELEM_CURRENT_OFFSCREEN),
            automation_id=self._bstr(el, _SLOT_ELEM_CURRENT_AUTOMATION_ID),
        )

    def _release(self, ptr) -> None:
        if ptr and getattr(ptr, "value", None):
            try:
                _com(ptr, 2, ctypes.c_ulong)()
            except Exception:
                pass

    # ── 遍历 ──────────────────────────────────────────────────────

    def read_window(self, hwnd: int, max_nodes: int, max_depth: int) -> Optional[List[UiaNode]]:
        """读一棵窗口树；任何 COM 失败返回 None（上层降级）。"""
        try:
            return self._read(hwnd, max_nodes, max_depth)
        except Exception:
            return None

    def _read(self, hwnd: int, max_nodes: int, max_depth: int) -> Optional[List[UiaNode]]:
        """ElementFromHandle 取根 → ControlViewWalker 深度优先。

        深度上限取调用方给的 max_depth 与模块硬顶 MAX_DEPTH 的较小者——
        调用方要得再多也不许超过预算纪律。
        """
        root = ctypes.c_void_p()
        hr = _com(self._uia, _SLOT_IUIA_FROM_HANDLE, ctypes.c_long,
                  ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
            ctypes.c_void_p(hwnd), ctypes.byref(root))
        if hr != 0 or not root.value:
            return None

        walker = ctypes.c_void_p()
        hr = _com(self._uia, _SLOT_IUIA_CONTROL_VIEW_WALKER, ctypes.c_long,
                  ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(walker))
        if hr != 0 or not walker.value:
            self._release(root)
            return None

        cap = max(1, min(int(max_nodes or MAX_NODES), MAX_NODES))
        depth_cap = max(1, min(int(max_depth or MAX_DEPTH), MAX_DEPTH))
        out: List[UiaNode] = []
        try:
            self._walk(walker, root, out, 0, cap, depth_cap)
        finally:
            self._release(walker)
            self._release(root)
        return out

    def _walk(self, walker, el, out, depth, cap, depth_cap) -> None:
        if len(out) >= cap or depth > depth_cap:
            return
        out.append(self._snapshot(el))

        child = ctypes.c_void_p()
        ok = _com(walker, _SLOT_WALKER_FIRST_CHILD, ctypes.c_long,
                  ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
            el, ctypes.byref(child))
        if ok != 0 or not child.value:
            return
        try:
            while child.value and len(out) < cap:
                self._walk(walker, child, out, depth + 1, cap, depth_cap)
                nxt = ctypes.c_void_p()
                ok = _com(walker, _SLOT_WALKER_NEXT_SIBLING, ctypes.c_long,
                          ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
                    child, ctypes.byref(nxt))
                if ok != 0 or not nxt.value:
                    break
                self._release(child)
                child = nxt
        finally:
            self._release(child)

    def close(self) -> None:
        if getattr(self, "_uia", None):
            self._release(self._uia)
            self._uia = None
        if getattr(self, "_coinited", False):
            try:
                self._ole32.CoUninitialize()
            except Exception:
                pass
            self._coinited = False

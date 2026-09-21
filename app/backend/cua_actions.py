"""cua_actions.py - CUA 动作执行层：动作注册表 + 执行器抽象 + 截图 OCR 反馈闭环。

针对 Ovolve 适配（user_dirs /
~/.ovolve 目录约定），并组织动作编排、权限路由与反馈闭环。

## 解决什么

app_agent 已有分散的桌面原语（computer_click / computer_type / ...），但每个
原语只回一句确认文本——"点了 (10, 20)" 之后屏幕变成什么样，模型只能再发一次
截图工具去猜，一来一回都是 token。本模块把"感知-行动"闭环做进动作层的默认
行为，闭环不需要模型记得去做：

    动作执行 → 强制截图落盘 → 本地 OCR（edge/ocr，离线）→ 文本摘要进结果

下一轮决策直接读 OCR 文本就能判断动作是否生效，比把整张截图交给多模态模型
省一个数量级的 token——本地 OCR 是 Ovolve 已有的边缘推理资产（edge/ocr），
这里只是把它接进执行回路。

## 结构

    ActionSpec         动作元数据：能力声明 + 权限路由目标 + 是否需要截图反馈
    CuaBackend         执行器抽象（鸭子类型契约，见下）
    CuaActionRegistry  注册表 + 唯一入口 execute()：权限 → 执行 → 反馈
    CuaActionResult    统一结果契约：成败 / 动作名 / 截图路径 / OCR 摘要 / 耗时

后端约定：实现与动作**同名**的 callable，签名 ``(params: dict, ctx: dict) ->
Result``（value 为该动作的明细 dict）。桌面后端 :class:`CuaDesktopBackend`
包装 native_desktop 引擎实现全部十动作；测试注入假后端即可跑通全链路，
不依赖真实桌面。

## 权限路由（不新增决策点）

每个动作声明 ``guard_tool``——一个**既有** GUI 工具名。动作级语义分级完全
复用 gui_action_classifier 的四级（OK/AWARE/CONFIRM/HANDOFF），持久预批准
完全复用 permission_rules 的 standing 规则，本模块不建任何新规则表：

    DENY 规则   永远赢（与 permission_rules 的严格序一致）
    HANDOFF     一律拒绝——解验证码/绕安全提示就该人做
    CONFIRM     单次人工批准（ctx["confirmed"]，与 _proc_kill_impl 同一语义）
    AWARE       confirmed，或用户已留 ALLOW 规则；否则要求确认
    OK          放行（工具级风险由 ToolDef.risk_level 兜底）

动作名沿用 DOM / 桌面自动化行业的通用词汇。

## 升级接线（U1/U2/U5/U6）

    U1 OCR diff 反馈   副作用动作后的 OCR 摘要默认走 OcrDiffState 增量 diff——
                       只回传屏幕变化；后端无探测点（替身）或 diff 状态异常时
                       逐字回退旧 summarize_ocr，截图落盘行为不变。
    U2 场景地板        confirmation_class × scenario_tags（静态声明 + 参数语料
                       现检）× 预批准来源（PRE_APPROVAL_SOURCES 白名单）→
                       resolve_confirmation_tier 得地板档，与裸档 escalate 取高；
                       standing ALLOW 只解 AWARE，盖不过必弹场景的 CONFIRM 地板。
    U5 delivery_hint   统一结果契约新增载荷键（"" | "deliverable" | "handoff"，
                       与 goal_scheduler 门禁侧对接）；只由 element_info 的
                       expect_text 诚实匹配产生，绝不凭自我声明设置。
    U6 拖拽中途观察    drag 的 observe_midway=True 时，引擎具备 mouse_down /
                       mouse_up / move_cursor 分步原语才在中点停一拍截屏观察
                       （独立路径，不推进 diff 基线）；否则诚实降级。
    U4 Target 协议     桌面与浏览器标签实现同一 Target 接口（TargetBackend:
                       observe/act，TargetRef 统一目标引用）——TargetRouter
                       按域派发，权限两域单源同判；既有 CuaDesktopBackend
                       保持原样可用（迁移期兼容，v2 渐进接口），详见文末
                       「桌面/浏览器统一 Target 协议」一节。
"""
from __future__ import annotations

import os
import platform
import re
import tempfile
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Optional, Protocol, runtime_checkable

from result import Result
from browser_sessions import TabClaim
from cua_ocr_diff import OcrDiffState
from gui_action_classifier import (
    Tier,
    classify_action,
    detect_scenario_tags,
    escalate_tiers,
    is_pre_approval_source,
    resolve_confirmation_tier,
)

if TYPE_CHECKING:  # 仅类型标注；运行期浏览器域以构造注入的实例出现（鸭子类型）
    from browser_sessions import BrowserSessionManager

# ── 能力声明（capability）：动作的语义分组，供审计/前端/未来后端复用 ─────────

CAP_PERCEIVE = "perceive"    # 看屏幕（截图 / 元素信息）——不改变任何状态
CAP_POINT = "point"          # 指向与按压（点击 / 悬停 / 拖拽 / 滚动）
CAP_TYPE = "type"            # 键入（填文本 / 按键）
CAP_NAVIGATE = "navigate"    # 打开目标（URL）
CAP_WAIT = "wait"            # 等待状态就绪


@dataclass(frozen=True)
class ActionSpec:
    """一个 CUA 动作的完整声明。

    Attributes:
        name: 动作名（DOM/桌面自动化行业通用动词）。
        capability: 能力分组（CAP_* 常量之一）。
        guard_tool: 权限路由到的**既有** GUI 工具名——语义分级按它跑
            classify_action，持久规则按它匹配 permission_rules。
        risk_level: 交给工具目录的风险底档（低/中），兜住分级器弃权的部分。
        side_effect: True = 执行后屏幕状态可能变化 → 强制截图 + OCR 反馈。
            纯感知动作（screenshot/element_info/wait）自身就是观察，无需反馈。
        description: 一句话说明（describe() 输出给审计/前端）。
        confirmation_class: U2 确认政策粗分类（standard / pre_approval /
            always_confirm / handoff，词表见 gui_action_classifier）。
            默认 standard——十动作的裸档完全由 classify_action 按参数现裁，
            粗分类只给声明了政策的自定义动作用。
        scenario_tags: 静态声明的场景标签（SCENARIO_TAGS 子集）——与参数语料
            现检出的标签合并后进场景地板裁决。
    """

    name: str
    capability: str
    guard_tool: str
    risk_level: str
    side_effect: bool
    description: str = ""
    confirmation_class: str = "standard"
    scenario_tags: tuple[str, ...] = ()


#: 首批十动作（覆盖 90% 桌面/浏览器场景的定稿清单）。
ACTION_SPECS: tuple[ActionSpec, ...] = (
    ActionSpec("navigate", CAP_NAVIGATE, "navigate", "medium", True,
               "在默认浏览器中打开一个 http(s) URL"),
    ActionSpec("click", CAP_POINT, "computer_click", "medium", True,
               "在坐标处点击鼠标（可选按键与连击次数）"),
    ActionSpec("click_text", CAP_POINT, "computer_click", "medium", True,
               "通过 OCR 文本锚点定位并点击目标元素"),
    ActionSpec("fill", CAP_TYPE, "computer_type", "medium", True,
               "向焦点控件键入文本；给坐标时先点击聚焦再输入"),
    ActionSpec("scroll", CAP_POINT, "computer_scroll", "low", True,
               "滚动滚轮（正数向上，负数向下），可先移到坐标"),
    ActionSpec("hover", CAP_POINT, "computer_move_cursor", "low", True,
               "平滑移动光标到坐标（触发悬停态/工具提示）"),
    ActionSpec("drag", CAP_POINT, "computer_drag", "medium", True,
               "从起点坐标拖拽到终点坐标"),
    ActionSpec("keypress", CAP_TYPE, "computer_press_key", "medium", True,
               "按下按键或组合键（enter / ctrl+s / alt+f4）"),
    ActionSpec("screenshot", CAP_PERCEIVE, "computer_screenshot", "low", False,
               "截取屏幕并落盘（感知动作，自身即反馈）"),
    ActionSpec("window_list", CAP_PERCEIVE, "snapshot", "low", False,
               "枚举可见窗口（hwnd/标题/pid）；element_tree 与 click_element 的 hwnd 从这里取"),
    ActionSpec("element_tree", CAP_PERCEIVE, "snapshot", "low", False,
               "读取目标窗口的无障碍树（语义元素：名称/类型/位置），给坐标时优先用它"),
    ActionSpec("click_element", CAP_POINT, "computer_click", "medium", True,
               "按语义条件（名称/类型/automation_id）定位无障碍树元素并点击其中心"),
    ActionSpec("element_info", CAP_PERCEIVE, "snapshot", "low", False,
               "截屏 + 本地 OCR，返回可见文本元素及其位置；给坐标时附最近元素"),
    ActionSpec("wait", CAP_WAIT, "computer_screenshot", "low", False,
               "等待若干秒，或轮询 OCR 直到目标文本出现"),
)

#: 统一结果契约的键集（to_dict 输出；测试与前端按它对形状）。
#: delivery_hint 是与 goal_scheduler 门禁侧对接的载荷契约键，键名一字不改。
RESULT_KEYS = ("ok", "action", "error", "details", "screenshot_path",
               "ocr_summary", "feedback_note", "delivery_hint", "elapsed_ms")

#: delivery_hint 的合法值域（U5）：空串 = 无交付判定；deliverable = 动作确实
#: 命中了声明的目标（有屏幕证据）；handoff = 结果应移交人处理（预留）。
DELIVERY_HINTS: tuple[str, ...] = ("deliverable", "handoff")


@dataclass
class CuaActionResult:
    """一次动作执行的统一结果——成败、明细、截图路径与 OCR 摘要。"""

    ok: bool
    action: str
    error: str = ""
    details: dict = field(default_factory=dict)
    screenshot_path: str = ""     # 反馈截图落盘路径（side_effect 动作才有）
    ocr_summary: str = ""         # 反馈截图的 OCR 文本摘要（供下一轮决策）
    feedback_note: str = ""       # 反馈环节的降级说明（截图失败/OCR 不可用）
    delivery_hint: str = ""       # U5 交付判定（DELIVERY_HINTS 之一，默认空）
    elapsed_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "action": self.action,
            "error": self.error,
            "details": self.details,
            "screenshot_path": self.screenshot_path,
            "ocr_summary": self.ocr_summary,
            "feedback_note": self.feedback_note,
            "delivery_hint": self.delivery_hint,
            "elapsed_ms": self.elapsed_ms,
        }


# ── 反馈截图落盘位置 ─────────────────────────────────────────────────────────

#: OCR 摘要的体量上限——反馈的目的是让模型"读到屏幕上有什么"，不是重放全文。
OCR_SUMMARY_MAX_LINES = 24
OCR_SUMMARY_MAX_CHARS = 800

#: U6 拖拽中途观察的摘要预算——中途只是"停一拍看一眼"，预算比整屏更紧。
DRAG_MIDWAY_MAX_LINES = 6
DRAG_MIDWAY_MAX_CHARS = 300

#: U6 分步拖拽的鸭子契约原语：三者齐备才允许中途观察。现役 native_desktop
#: 引擎的按下/抬起封在 drag() 内部未单独暴露，真实环境因此诚实降级——
#: 契约先立，引擎补齐原语后自动启用。
_STEP_DRAG_PRIMITIVES = ("mouse_down", "mouse_up", "move_cursor")

#: 喂给场景判定器的 ctx 需剔除的纯控制键（U2 反自污染）：它们是路由信号
#: 不是世界内容——不剔除的话 "user_first_message" 里的 "message" 会让每次
#: 调用自我触发 third_party_comm 标签。
_CTX_CONTROL_KEYS = frozenset({"pre_approval_source"})


def feedback_dir(ctx: Optional[dict] = None) -> str:
    """反馈截图的落盘目录：ctx 注入优先（测试/会话隔离），否则用户数据根。

    放 ``~/.ovolve/cua_shots`` 而不是工作区——屏幕截图是会话产物，不该污染
    用户的项目目录（user_dirs 是用户级路径的唯一真相源）。
    """
    override = (ctx or {}).get("cua_screenshot_dir")
    if override:
        return str(override)
    try:
        from user_dirs import home_dir
        return str(home_dir() / "cua_shots")
    except Exception:
        return os.path.join(tempfile.gettempdir(), "ovolve_cua")


def feedback_path(action: str, ctx: Optional[dict] = None) -> str:
    """一次反馈截图的完整路径：毫秒级时间戳 + 动作名，同目录内不互相覆盖。"""
    ts = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}"
    return os.path.join(feedback_dir(ctx), f"{ts}_{action}.jpg")


def summarize_ocr(ocr_value: dict) -> str:
    """把 OCR 输出压成给模型读的文本摘要：限量行 + 限量字符。"""
    if not isinstance(ocr_value, dict):
        return ""
    lines = ocr_value.get("lines") or []
    texts = [str(l.get("text", "")).strip() for l in lines if isinstance(l, dict)]
    texts = [t for t in texts if t][:OCR_SUMMARY_MAX_LINES]
    joined = "\n".join(texts)
    if len(joined) > OCR_SUMMARY_MAX_CHARS:
        joined = joined[:OCR_SUMMARY_MAX_CHARS] + "\n... [OCR 文本已截断]"
    return joined


# ── 权限路由用的 URL 校验（navigate 专用）─────────────────────────────────────

#: navigate 的 URL 白名单字符集：http(s) 常见字符。不全量支持 RFC 3986——
#: 引号/空白/尖括号在三个平台的 shell 引号规则下都是注入面，安全优先。
_URL_PATTERN = re.compile(r"^https?://[A-Za-z0-9\-._~:/?#&=%]+$")


def validate_url(url: str) -> str:
    """校验 navigate 的目标 URL。返回归一化字符串，非法抛 ValueError。"""
    text = str(url or "").strip()
    if not _URL_PATTERN.match(text):
        raise ValueError("url 必须是 http(s) 链接，且只含常见 URL 字符")
    return text


def _detect_ctx_of(ctx: dict) -> dict:
    """U2：给场景判定器喂的 ctx 视图——剔除纯控制键（见 _CTX_CONTROL_KEYS）。"""
    return {k: v for k, v in ctx.items() if k not in _CTX_CONTROL_KEYS}


def _match_norm(text) -> str:
    """U5 expect_text 匹配用的归一化：去全部空白 + casefold。

    OCR 文本常带幻影空格、英文大小写不稳，"确实匹配到"按去噪后的包含关系判。
    """
    return "".join(str(text).split()).casefold()


# ── 桌面执行器 ───────────────────────────────────────────────────────────────

def _list_top_level_windows():
    """窗口枚举的间接层：测试可以替换它，不必起真桌面会话。"""
    from native_desktop import list_top_level_windows
    return list_top_level_windows()


def _virtual_screen_bounds() -> tuple:
    """虚拟屏幕 ``(x, y, w, h)``；拿不到时返回 ``(0, 0, 0, 0)``。

    多显示器下原点可以是负的（左副屏），所以"坐标为负"本身不是判据，
    必须拿真实边界比。
    """
    try:
        import sys as _sys
        import ctypes as _ctypes
        if _sys.platform != "win32":
            return (0, 0, 0, 0)
        u = _ctypes.windll.user32
        return (int(u.GetSystemMetrics(76)), int(u.GetSystemMetrics(77)),
                int(u.GetSystemMetrics(78)), int(u.GetSystemMetrics(79)))
    except Exception:
        return (0, 0, 0, 0)


class CuaDesktopBackend:
    """桌面动作后端：native_desktop 引擎 + 系统打开 URL + edge/ocr 感知。

    非本模块关心的失败（DPI、SendInput、OCR 模型缺失）一律包成 Result.failure
    返回明确错误，绝不向上抛——动作层的降级路径在 registry 里统一处理。
    """

    name = "desktop"

    def __init__(self, engine=None, ocr_fn: Optional[Callable[[str], Result]] = None):
        # engine / ocr_fn 可注入（测试）；默认走各自的进程级懒单例。
        self._engine = engine
        self._ocr_fn = ocr_fn
        # U1：观察目标 → OCR diff 滚动基线（键 "desktop" 起步，U4 多目标分键）
        self._ocr_diff_states: dict[str, OcrDiffState] = {}

    def _ocr_diff_state(self, target_ref: str = "desktop") -> OcrDiffState:
        """取观察目标的 diff 基线（懒建）。

        U1 整块桌面是一个目标；U4 接入浏览器/多显示器时按 target_ref 分键，
        反馈管线（registry 侧）无需再改。
        """
        key = str(target_ref or "desktop")
        state = self._ocr_diff_states.get(key)
        if state is None:
            state = OcrDiffState()
            self._ocr_diff_states[key] = state
        return state

    # ── 懒加载依赖 ────────────────────────────────────────────────────────

    def _get_engine(self):
        if self._engine is None:
            from native_desktop import get_native_desktop
            self._engine = get_native_desktop()
        return self._engine

    def _get_ocr_fn(self) -> Callable[[str], Result]:
        if self._ocr_fn is None:
            from edge.ocr import OCR
            holder: dict = {}

            def _recognize(path: str) -> Result:
                if "ocr" not in holder:
                    holder["ocr"] = OCR()
                return holder["ocr"].recognize(path)

            self._ocr_fn = _recognize
        return self._ocr_fn

    # ── 内部工具 ──────────────────────────────────────────────────────────

    @staticmethod
    def _roi_of(params: dict):
        roi = params.get("roi")
        if roi and len(roi) == 4:
            try:
                return (int(roi[0]), int(roi[1]), int(roi[2]), int(roi[3]))
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _save_capture(res: dict, path: str) -> str:
        if not path:
            fd, path = tempfile.mkstemp(prefix="ovolve_cua_", suffix=".png")
            os.close(fd)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        res["image"].save(path)
        return path

    # ── 动作实现（与 ActionSpec.name 一一对应）────────────────────────────

    def screenshot(self, params: dict, ctx: dict) -> Result:
        try:
            engine = self._get_engine()
            res = engine.capture_screen(
                roi=self._roi_of(params), quality=int(params.get("quality", 80)))
            path = str(params.get("save_path") or "")
            if path:
                path = self._save_capture(res, path)
            value = {"path": path, "width": res["width"], "height": res["height"],
                     "scale_factor": res["scale_factor"]}
            if params.get("with_data_uri"):
                value["data_uri"] = res["data_uri"]
            return Result.success(value)
        except Exception as e:
            return Result.failure(f"截图失败: {e}")

    # ── UIA 语义动作（无障碍树）────────────────────────────────────────

    def window_list(self, params: dict, ctx: dict) -> Result:
        """枚举可见窗口，给 element_tree / click_element 提供 hwnd。

        这两个动作都要 hwnd，而模型没有别的途径拿到它——少了这个动作，
        它们在 schema 里看得见、实际永远调不动。
        """
        try:
            rows = _list_top_level_windows()
        except Exception as exc:
            return Result.failure(
                f"无法枚举窗口（无桌面会话或权限不足）：{exc}。"
                "可改用 element_info 走 OCR，或直接给坐标。")
        want = str(params.get("title") or "").strip().lower()
        if want:
            rows = [r for r in rows if want in str(r.get("title") or "").lower()]
        try:
            limit = int(params.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20
        rows = rows[:max(1, min(limit, 100))]
        return Result.success({"count": len(rows), "windows": rows})

    def _get_uia_backend(self):
        """UIA 后端懒加载：进程内单例；不可用时返回 None（动作层降级）。"""
        if not hasattr(self, "_uia_backend_instance"):
            self._uia_backend_instance = None
            try:
                from uia_tree import CtypesUiaBackend
                self._uia_backend_instance = CtypesUiaBackend()
            except Exception as exc:
                print(f"[cua] UIA backend unavailable (degrading): {exc}")
        # 测试注入优先（self._uia_backend 由 registry 侧设置）
        injected = getattr(self, "_uia_backend", None)
        return injected if injected is not None else self._uia_backend_instance

    def element_tree(self, params: dict, ctx: dict) -> Result:
        """读取目标窗口的无障碍树，返回裁剪后的元素字典列表。"""
        target = int(params.get("hwnd") or 0)
        if not target:
            return Result.failure(
                "element_tree 缺少 hwnd 参数。先用 window_list 枚举可见窗口，" 
                "把它返回的 hwnd 传进来。")
        from uia_tree import walk_elements, find_elements, node_to_dict, UIA_UNAVAILABLE, MAX_NODES
        backend = self._get_uia_backend()
        got = walk_elements(hwnd=target, backend=backend, max_nodes=MAX_NODES)
        if got is UIA_UNAVAILABLE:
            return Result.failure(
                f"{UIA_UNAVAILABLE}: 目标窗口的无障碍树不可读（非标准控件或 COM 不可用）。"
                "请改用 element_info（OCR）或直接给坐标。")
        name = str(params.get("name") or "")
        ctype = str(params.get("control_type") or "")
        aid = str(params.get("automation_id") or "")
        hits = find_elements(got, name=name, control_type=ctype, automation_id=aid) if (name or ctype or aid) else got
        dpi = float(params.get("dpi_scale", 1.0))
        return Result.success({
            "count": len(hits),
            "elements": [node_to_dict(n, scale_factor=dpi) for n in hits],
        })

    def click_element(self, params: dict, ctx: dict) -> Result:
        """语义定位 + 点击：target 命中无障碍树元素后复用既有 click 管线。"""
        target = params.get("target")
        if not isinstance(target, dict) or not target:
            return Result.failure("click_element 缺少 target 参数（{name?/control_type?/automation_id?/index?}）")
        hwnd = int(params.get("hwnd") or 0)
        if not hwnd:
            return Result.failure(
                "click_element 缺少 hwnd 参数。先用 window_list 枚举可见窗口，" 
                "把它返回的 hwnd 传进来。")
        from uia_tree import walk_elements, resolve_element_target, UIA_UNAVAILABLE, MAX_NODES
        backend = self._get_uia_backend()
        got = walk_elements(hwnd=hwnd, backend=backend, max_nodes=MAX_NODES)
        if got is UIA_UNAVAILABLE:
            return Result.failure(
                f"{UIA_UNAVAILABLE}: 目标窗口的无障碍树不可读。可改用 click_text 走 OCR 定位，或直接给坐标。")
        dpi = float(params.get("dpi_scale", 1.0))
        ok, res = resolve_element_target(got, target, scale_factor=dpi)
        if not ok:
            return Result.failure(str(res))
        tx, ty = res
        offset_x = int(params.get("offset_x", 0))
        offset_y = int(params.get("offset_y", 0))
        tx += offset_x
        ty += offset_y

        # 前置守卫：坐标必须落在虚拟屏幕内。最小化的窗口在 Windows 上被摆在
        # (-32000, -32000) 一带，UIA 会照实报出那里的元素坐标——照着点等于往
        # 屏幕外发一次 SendInput：什么都不会发生，但调用方会以为点成功了。
        # 边界未知（非 Windows / 取不到）时放行：这是尽力而为的合理性检查，
        # 不是安全边界，不该把整条链路卡死。
        bx, by, bw, bh = _virtual_screen_bounds()
        if bw > 0 and bh > 0 and not (bx <= tx < bx + bw and by <= ty < by + bh):
            return Result.failure(
                f"目标元素解析到屏幕外坐标 ({tx}, {ty})，已拒绝点击。"
                f"当前虚拟屏幕为 ({bx}, {by}) 起 {bw}×{bh}——通常说明目标窗口"
                "被最小化了。先用 window_list 确认窗口状态，把它恢复/激活后"
                "再试，或改用 click_text 走 OCR 定位。")

        button = str(params.get("button", "left"))
        clicks = int(params.get("clicks", 1))
        try:
            engine = self._get_engine()
            engine.click(x=tx, y=ty, button=button, clicks=clicks)
            return Result.success({
                "clicked": [tx, ty],
                "target": dict(target),
                "button": button,
                "clicks": clicks,
            })
        except Exception as e:
            return Result.failure(f"点击目标元素失败: {e}")

    def click_text(self, params: dict, ctx: dict) -> Result:
        """通过 OCR 文本锚点定位并点击目标元素。"""
        target = str(params.get("text") or params.get("text_target") or "").strip()
        if not target:
            return Result.failure("click_text 缺少 text 或 text_target 参数")

        ocr_lines = params.get("ocr_lines")
        if not ocr_lines:
            try:
                engine = self._get_engine()
                res = engine.capture_screen(quality=80)
                path = self._save_capture(res, "")
                ocr = self._get_ocr_fn()(path)
                if not ocr.ok:
                    return Result.failure(f"OCR 不可用: {ocr.error}")
                ocr_lines = (ocr.value or {}).get("lines") or []
            except Exception as e:
                return Result.failure(f"屏幕感知获取失败: {e}")

        from cua_text_anchor import TextAnchorResolver
        exact = bool(params.get("exact", False))
        dpi_scale = float(params.get("dpi_scale", 1.0))
        ok, res_coords = TextAnchorResolver.resolve_click_target(
            ocr_boxes=ocr_lines,
            text=target,
            exact=exact,
            scale_factor=dpi_scale,
        )
        if not ok:
            return Result.failure(f"未在屏幕识别文本中找到目标锚点: {target} ({res_coords})")

        tx, ty = res_coords
        offset_x = int(params.get("offset_x", 0))
        offset_y = int(params.get("offset_y", 0))
        tx += offset_x
        ty += offset_y
        button = str(params.get("button", "left"))
        clicks = int(params.get("clicks", 1))
        try:
            engine = self._get_engine()
            engine.click(x=tx, y=ty, button=button, clicks=clicks)
            return Result.success({
                "clicked": [tx, ty],
                "text_target": target,
                "button": button,
                "clicks": clicks,
            })
        except Exception as e:
            return Result.failure(f"点击目标锚点失败: {e}")

    def click(self, params: dict, ctx: dict) -> Result:
        if params.get("text_target") or (params.get("text") and "x" not in params):
            return self.click_text(params, ctx)
        try:
            engine = self._get_engine()
            x, y = int(params.get("x", 0)), int(params.get("y", 0))
            button = str(params.get("button", "left"))
            clicks = int(params.get("clicks", 1))
            engine.click(x=x, y=y, button=button, clicks=clicks)
            return Result.success({"clicked": [x, y], "button": button, "clicks": clicks})
        except Exception as e:
            return Result.failure(f"点击失败: {e}")

    def hover(self, params: dict, ctx: dict) -> Result:
        try:
            engine = self._get_engine()
            x, y = int(params.get("x", 0)), int(params.get("y", 0))
            engine.move_cursor(x=x, y=y, smooth=bool(params.get("smooth", True)))
            return Result.success({"hovered": [x, y]})
        except Exception as e:
            return Result.failure(f"悬停失败: {e}")

    def fill(self, params: dict, ctx: dict) -> Result:
        try:
            engine = self._get_engine()
            text = str(params.get("text", ""))
            x, y = params.get("x"), params.get("y")
            focused = False
            if x is not None and y is not None:
                engine.click(x=int(x), y=int(y))
                focused = True
            if text:
                delay = float(params.get("delay_ms", 10)) / 1000.0
                engine.type_unicode(text, delay_per_char=delay)
            return Result.success({"typed_chars": len(text), "focused_by_click": focused})
        except Exception as e:
            return Result.failure(f"填充失败: {e}")

    def scroll(self, params: dict, ctx: dict) -> Result:
        try:
            engine = self._get_engine()
            clicks = int(params.get("clicks", 0))
            x, y = params.get("x"), params.get("y")
            x_val = int(x) if x is not None else None
            y_val = int(y) if y is not None else None
            engine.scroll(clicks, x=x_val, y=y_val)
            return Result.success({"scrolled": clicks})
        except Exception as e:
            return Result.failure(f"滚动失败: {e}")

    def drag(self, params: dict, ctx: dict) -> Result:
        """从起点拖拽到终点；observe_midway=True 时中途停一拍看一眼屏幕（U6）。

        引擎没有分步原语就诚实降级：拖拽照常完成，反馈说明观察不可用——
        绝不假装观察过。
        """
        try:
            engine = self._get_engine()
            sx, sy = int(params.get("start_x", 0)), int(params.get("start_y", 0))
            ex, ey = int(params.get("end_x", 0)), int(params.get("end_y", 0))
            duration = float(params.get("duration", 0.5))
            if params.get("observe_midway"):
                return self._drag_observed(engine, sx, sy, ex, ey, duration, ctx)
            engine.drag(sx, sy, ex, ey, duration=duration)
            return Result.success({"from": [sx, sy], "to": [ex, ey]})
        except Exception as e:
            return Result.failure(f"拖拽失败: {e}")

    # ── U6：拖拽中途观察 ──────────────────────────────────────────────────

    @staticmethod
    def _supports_step_drag(engine) -> bool:
        """鸭子契约探测：mouse_down(x, y) / mouse_up() / move_cursor(x, y)。"""
        return all(callable(getattr(engine, name, None))
                   for name in _STEP_DRAG_PRIMITIVES)

    def _drag_observed(self, engine, sx, sy, ex, ey, duration, ctx) -> Result:
        """分步拖拽 + 中途观察。任何异常向上抛（由 drag() 统一判失败），
        但按下之后 try/finally 保证抬起——绝不把按住的鼠标留给用户。"""
        value = {"from": [sx, sy], "to": [ex, ey]}
        if not self._supports_step_drag(engine):
            engine.drag(sx, sy, ex, ey, duration=duration)
            value["midway_note"] = "拖拽中途观察不可用（引擎不支持分步拖拽）"
            return Result.success(value)

        mid_x, mid_y = (sx + ex) // 2, (sy + ey) // 2
        pressed = False
        try:
            engine.mouse_down(sx, sy)
            pressed = True
            engine.move_cursor(mid_x, mid_y)
            summary, note, shot = self._midway_observe(ctx)
            engine.move_cursor(ex, ey)
        finally:
            if pressed:
                try:
                    engine.mouse_up()
                except Exception:
                    pass  # 抬起失败无处安放——不掩盖拖拽本身的成败
        if summary:
            value["midway_summary"] = summary
        if note:
            value["midway_note"] = note
        if shot:
            value["midway_screenshot"] = shot
        return Result.success(value)

    def _midway_observe(self, ctx: dict) -> tuple[str, str, str]:
        """拖拽中途的独立观察：截屏落盘 + OCR → (摘要, 降级说明, 截图路径)。

        独立路径——绝不触碰 OcrDiffState 基线：中途一帧只服务本次反馈，
        不能成为下一次动作 diff 的参照。失败一律折成 note，不炸拖拽。
        """
        try:
            engine = self._get_engine()
            res = engine.capture_screen(quality=70)
            path = self._save_capture(res, feedback_path("drag_midway", ctx))
        except Exception as e:
            return "", f"拖拽中途观察不可用（中途截图失败: {e}）", ""
        try:
            ocr = self._get_ocr_fn()(path)
            if not ocr.ok:
                return "", f"拖拽中途观察不可用（中途识别失败: {ocr.error}）", path
        except Exception as e:
            return "", f"拖拽中途观察不可用（中途识别失败: {e}）", path
        texts = []
        for item in (ocr.value or {}).get("lines") or []:
            if isinstance(item, dict):
                t = str(item.get("text", "")).strip()
                if t:
                    texts.append(t)
        body = "\n".join(texts[:DRAG_MIDWAY_MAX_LINES])
        if len(body) > DRAG_MIDWAY_MAX_CHARS:
            body = body[:DRAG_MIDWAY_MAX_CHARS]
        return f"拖拽中途观察:\n{body or '（未识别到文本）'}", "", path

    def keypress(self, params: dict, ctx: dict) -> Result:
        try:
            engine = self._get_engine()
            key = str(params.get("key", ""))
            if not key.strip():
                return Result.failure("key 不能为空")
            engine.press_key(key)
            return Result.success({"key": key})
        except Exception as e:
            return Result.failure(f"按键失败: {e}")

    def navigate(self, params: dict, ctx: dict) -> Result:
        try:
            url = validate_url(params.get("url", ""))
        except ValueError as e:
            return Result.failure(str(e))
        try:
            from executors import guarded_spawn
            if platform.system() == "Darwin":
                cmd = f'open "{url}"'
            elif platform.system() == "Windows":
                cmd = f'powershell "Start-Process \'{url}\'"'
            else:
                cmd = f'xdg-open "{url}"'
            # 与 _proc_list_impl 同一判定：guarded_spawn 在 deny 级规则上抛异常，
            # 没抛即已放行（非零退出码不阻断——浏览器打开 URL 的退出码不可靠）。
            from result import try_result
            r = try_result(lambda: guarded_spawn(cmd, timeout=10))
            return Result.success({"url": url}) if r.ok \
                else Result.failure(f"打开链接失败: {r.error}")
        except Exception as e:
            return Result.failure(f"打开链接失败: {e}")

    def element_info(self, params: dict, ctx: dict) -> Result:
        """截屏 + 本地 OCR → 可见文本元素清单。

        Ovolve 的"元素信息"由本地 OCR 承担：不依赖浏览器选择器（桌面窗口没有
        DOM），也不需要多模态模型。给 (x, y) 时附最近元素——模型据此决定下一步
        点哪里，这正是感知-行动闭环的读端。
        """
        try:
            engine = self._get_engine()
            res = engine.capture_screen(
                roi=self._roi_of(params), quality=int(params.get("quality", 80)))
            path = self._save_capture(res, str(params.get("save_path") or ""))
            ocr = self._get_ocr_fn()(path)
            if not ocr.ok:
                return Result.failure(f"OCR 不可用: {ocr.error}",
                                      meta={"screenshot_path": path})
            lines = (ocr.value or {}).get("lines") or []
            try:
                limit = max(1, min(100, int(params.get("limit", 20))))
            except (TypeError, ValueError):
                limit = 20
            items = []
            for l in lines[:limit]:
                if not isinstance(l, dict):
                    continue
                bbox = l.get("bbox") or []
                center = _bbox_center(bbox)
                items.append({"text": str(l.get("text", "")),
                              "center": center,
                              "confidence": l.get("confidence", 0.0)})
            out = {"elements": items, "count": len(lines), "screenshot_path": path}
            # U5 诚实启发：expect_text 确实出现在本轮 OCR 的全部行里才算命中，
            # 交付判定只认屏幕证据——params 里的同名自我声明键一律无视。
            expect = str(params.get("expect_text") or "").strip()
            if expect:
                needle = _match_norm(expect)
                if needle and any(
                        needle in _match_norm(str(l.get("text", "")))
                        for l in lines if isinstance(l, dict)):
                    out["delivery_hint"] = "deliverable"
            x, y = params.get("x"), params.get("y")
            if x is not None and y is not None and items:
                try:
                    px, py = float(x), float(y)
                    out["nearest"] = min(
                        items,
                        key=lambda it: (it["center"][0] - px) ** 2
                                       + (it["center"][1] - py) ** 2,
                    )
                except (TypeError, ValueError):
                    pass
            return Result.success(out)
        except Exception as e:
            return Result.failure(f"元素识别失败: {e}")

    def wait(self, params: dict, ctx: dict) -> Result:
        """等待：纯延时，或轮询 OCR 直到目标文本出现。

        ``found`` 为 False 时仍是 ok=True——"等了但没等到"是一次成功的观察，
        由模型决定下一步（换关键词再等 / 放弃 / 截图亲自看）。
        """
        def _clamp(name: str, default: float, lo: float, hi: float) -> float:
            try:
                v = float(params.get(name, default))
            except (TypeError, ValueError):
                v = default
            return max(lo, min(hi, v))

        seconds = _clamp("seconds", 1.0, 0.0, 30.0)
        timeout = _clamp("timeout", 10.0, 0.0, 60.0)
        for_text = str(params.get("for_text") or "").strip()
        if not for_text:
            time.sleep(seconds)
            return Result.success({"waited": seconds, "found": None})

        deadline = time.monotonic() + timeout
        polled = 0
        needle = for_text.lower()
        while True:
            polled += 1
            path = ""
            try:
                engine = self._get_engine()
                res = engine.capture_screen(quality=70)
                path = self._save_capture(res, "")
                ocr = self._get_ocr_fn()(path)
                text = (ocr.value or {}).get("text", "") if ocr.ok else ""
            except Exception as e:
                return Result.failure(f"等待轮询失败: {e}")
            if needle in str(text).lower():
                return Result.success({"waited": timeout - max(0.0, deadline - time.monotonic()),
                                       "found": True, "polled": polled,
                                       "screenshot_path": path})
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return Result.success({"waited": timeout, "found": False,
                                       "polled": polled, "screenshot_path": path})
            time.sleep(min(0.5, remaining))


def _bbox_center(bbox) -> list:
    """PaddleOCR 的四点 bbox → 中心点。畸形 bbox 返回 (0, 0)，不抛。"""
    try:
        pts = [p for p in bbox if isinstance(p, (list, tuple)) and len(p) >= 2]
        if not pts:
            return [0, 0]
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        return [round(sum(xs) / len(xs)), round(sum(ys) / len(ys))]
    except (TypeError, ValueError):
        return [0, 0]


# ── 注册表 + 唯一入口 ─────────────────────────────────────────────────────────

class CuaActionRegistry:
    """动作注册表 + 执行管线：权限路由 → 后端执行 → 截图 OCR 反馈。

    这是动作层的唯一入口。它不做任何策略决策——分级引用
    gui_action_classifier，预批准引用 permission_rules，本类只做组合与编排。
    """

    def __init__(self,
                 backend=None,
                 ocr_fn: Optional[Callable[[str], Result]] = None,
                 rules=None,
                 now_fn: Callable[[], float] = time.perf_counter,
                 modifier_guard=None):
        self.backend = backend
        self._ocr_fn = ocr_fn
        self._rules = rules          # 测试注入；生产环境懒加载 permission_rules
        self._now = now_fn
        if modifier_guard is None:
            from bare_modifier_guard import BareModifierGuard
            self.modifier_guard = BareModifierGuard()
        else:
            self.modifier_guard = modifier_guard
        self._specs: dict[str, ActionSpec] = {}
        for spec in ACTION_SPECS:
            self.register(spec)

    # ── 注册表 ────────────────────────────────────────────────────────────

    def register(self, spec: ActionSpec) -> None:
        self._specs[spec.name] = spec

    def get(self, name: str) -> Optional[ActionSpec]:
        return self._specs.get(str(name or "").strip())

    def names(self) -> list[str]:
        return sorted(self._specs)

    def describe(self) -> list[dict]:
        """全部动作的声明清单（审计 / 前端动作面板用）。"""
        return [{
            "name": s.name, "capability": s.capability, "guard_tool": s.guard_tool,
            "risk_level": s.risk_level, "side_effect": s.side_effect,
            "description": s.description,
        } for s in self._specs.values()]

    # ── 权限路由 ──────────────────────────────────────────────────────────

    def _match_rule(self, guard_tool: str, params: dict, ctx: dict):
        """查用户的持久规则。规则体系不可用时返回 None（不放宽——分级照跑）。"""
        store = self._rules
        if store is None:
            try:
                from permission_rules import get_permission_rules
                store = get_permission_rules()
            except Exception:
                return None
        try:
            return store.match(guard_tool, params,
                               workspace_root=str(ctx.get("workspace_root") or ""),
                               session_id=str(ctx.get("session_id") or ""))
        except Exception:
            return None

    def check_permission(self, spec: ActionSpec, params: dict,
                         ctx: dict) -> tuple[bool, str]:
        """一个动作是否放行。返回 (是否放行, 拒绝原因)。

        三级既有裁决依次叠加，本模块不打分、不造规则：
          1. permission_rules 的 standing 规则先裁（deny 永远赢）；
          2. gui_action_classifier 的裸档语义分级（classify_action）；
          3. U2 场景地板：confirmation_class × 场景标签（spec 静态声明 +
             参数语料现检）× 预批准来源 → resolve_confirmation_tier，
             与裸档 escalate_tiers 取高。
        反注入纪律：预批准的发言权只属于用户本人（PRE_APPROVAL_SOURCES）；
        standing ALLOW 只解 AWARE——地板先与裸档合成，必弹场景的 CONFIRM
        不会被 ALLOW 覆盖。理由里写明命中的场景标签；纯 standard 无标签时
        理由与旧实现逐字一致。
        """
        ctx = ctx or {}
        rule = self._match_rule(spec.guard_tool, params, ctx)
        if rule is not None:
            from permission_rules import RuleBehavior
            if rule.behavior is RuleBehavior.DENY:
                return False, (f"已有规则拒绝 {spec.guard_tool} 的这类调用"
                               f"（{rule.note or '用户设置'}）")
            if rule.behavior is RuleBehavior.ASK and not ctx.get("confirmed"):
                return False, (f"已有规则要求 {spec.guard_tool} 每次询问，"
                               "本次调用未获确认。")

        verdict = classify_action(spec.guard_tool, params)
        tags = tuple(spec.scenario_tags) + detect_scenario_tags(
            spec.name, params, _detect_ctx_of(ctx))
        pre_approved = is_pre_approval_source(ctx.get("pre_approval_source"))
        floor = resolve_confirmation_tier(spec.confirmation_class, tags, pre_approved)
        tier = escalate_tiers(verdict.tier, floor)

        reasons = list(verdict.reasons[:3])
        cls_norm = str(spec.confirmation_class or "standard").strip().lower()
        if cls_norm not in ("", "standard"):
            reasons.append(f"确认类别 {spec.confirmation_class}")
        if tags:
            reasons.append("场景标签 " + "、".join(tags))
        reason_txt = "；".join(reasons)

        if tier is Tier.HANDOFF:
            return False, f"这类动作需要用户亲手执行（{reason_txt}）"
        if tier is Tier.CONFIRM and not ctx.get("confirmed"):
            return False, (f"每次执行都需要当场单独确认，预批准不适用（{reason_txt}）。"
                           "获得用户对本次调用的批准后重试。")
        if tier is Tier.AWARE and not ctx.get("confirmed"):
            from permission_rules import RuleBehavior
            # 合法来源的预批准与 standing ALLOW 一样可满足 AWARE（无需 confirmed）
            if not (pre_approved
                    or (rule is not None and rule.behavior is RuleBehavior.ALLOW)):
                return False, (f"动作需要知情确认（{reason_txt}）。"
                               "用户批准本次调用、或留下一条允许规则后再试。")
        return True, ""

    # ── 执行 ──────────────────────────────────────────────────────────────

    def execute(self, name: str, params: Optional[dict] = None,
                ctx: Optional[dict] = None) -> CuaActionResult:
        """执行一个动作：查表 → 权限 → 后端 → 反馈闭环。绝不抛异常。"""
        t0 = self._now()
        spec = self.get(name)
        if spec is None:
            return CuaActionResult(
                ok=False, action=str(name or ""),
                error=f"未知动作: {name}。可用动作: {', '.join(self.names())}")
        params = params if isinstance(params, dict) else {}
        ctx = ctx if isinstance(ctx, dict) else {}

        allowed, reason = self.check_permission(spec, params, ctx)
        if not allowed:
            return CuaActionResult(ok=False, action=spec.name, error=reason)

        # 物理输入冲突防护拦截（仅针对外设控制动作 CAP_POINT / CAP_TYPE）
        if spec.capability in (CAP_POINT, CAP_TYPE) and not ctx.get("skip_modifier_guard"):
            if self.modifier_guard is not None:
                guard_res = self.modifier_guard.wait_for_bare_state(timeout_ms=250)
                is_clean = getattr(guard_res, "bare", guard_res[0] if isinstance(guard_res, (tuple, list)) else bool(guard_res))
                reason = getattr(guard_res, "reason", guard_res[1] if isinstance(guard_res, (tuple, list)) and len(guard_res) > 1 else str(guard_res))
                if not is_clean:
                    return CuaActionResult(
                        ok=False,
                        action=spec.name,
                        error=f"物理输入冲突防护拦截: {reason}",
                    )

        fn = getattr(self.backend, spec.name, None) if self.backend is not None else None
        if not callable(fn):
            return CuaActionResult(
                ok=False, action=spec.name,
                error=f"后端 {getattr(self.backend, 'name', type(self.backend).__name__)}"
                      f" 不支持动作 {spec.name}")

        try:
            r = fn(params, ctx)
        except Exception as e:
            r = Result.failure(f"动作执行异常: {e}")

        r_ok = bool(getattr(r, "ok", False))
        value = getattr(r, "value", None)
        result = CuaActionResult(
            ok=r_ok,
            action=spec.name,
            error=str(getattr(r, "error", "") or ""),
            details=dict(value) if (r_ok and isinstance(value, dict)) else {},
        )
        if r_ok and isinstance(value, dict):
            # U5：delivery_hint 只认后端按屏幕证据算出的合法值，其余一律落空
            hint = str(value.get("delivery_hint") or "")
            if hint in DELIVERY_HINTS:
                result.delivery_hint = hint
        if result.ok and spec.side_effect:
            self._apply_feedback(result, ctx)
        self._append_midway_note(result, value)
        result.elapsed_ms = int((self._now() - t0) * 1000)
        return result

    # ── 截图 OCR 反馈闭环 ─────────────────────────────────────────────────

    def _apply_feedback(self, result: CuaActionResult, ctx: dict) -> None:
        """副作用动作后的强制反馈：截图落盘 → OCR 摘要。

        反馈环节任何一步失败都只降级（记 note），绝不把已成功的动作改判为
        失败——动作已经作用于世界，抹掉成功只会诱导模型盲目重试。
        """
        try:
            shot = self.backend.screenshot(
                {"save_path": feedback_path(result.action, ctx), "quality": 70}, ctx)
            if not getattr(shot, "ok", False):
                result.feedback_note = f"反馈截图失败: {getattr(shot, 'error', '')}"
                return
            path = (shot.value or {}).get("path", "")
            result.screenshot_path = path
            ocr_fn = self._ocr_fn
            if ocr_fn is None and hasattr(self.backend, "_get_ocr_fn"):
                ocr_fn = self.backend._get_ocr_fn()
            if ocr_fn is None:
                result.feedback_note = "OCR 不可用: 未配置识别器"
                return
            ocr = ocr_fn(path)
            if ocr.ok:
                result.ocr_summary = self._diff_aware_summary(ocr.value or {})
            else:
                result.feedback_note = f"OCR 不可用: {ocr.error}"
        except Exception as e:
            result.feedback_note = f"反馈环节降级: {e}"

    def _diff_aware_summary(self, ocr_value: dict) -> str:
        """U1：优先走 OcrDiffState 的增量摘要，异常时逐字回退旧 summarize_ocr。

        后端没有探测点（测试替身/异构后端）→ 旧摘要；diff 状态机坏了 → 旧
        摘要。diff 是优化不是依赖，反馈闭环不因它新增失败面。
        """
        getter = getattr(self.backend, "_ocr_diff_state", None)
        if not callable(getter):
            return summarize_ocr(ocr_value)
        try:
            state = getter()  # target_ref 默认 "desktop"（U4 多目标时再显式传）
            summary, _diff = state.update_from_ocr(ocr_value)
            return summary
        except Exception:
            return summarize_ocr(ocr_value)

    @staticmethod
    def _append_midway_note(result: CuaActionResult, value) -> None:
        """U6：把拖拽中途观察的摘要/降级说明附进反馈通道。

        反馈文本是模型下一轮决策的输入——中途看到了什么、或为什么没看到，
        都该在这里出现，而不是埋在 details 里没人读。
        """
        if not isinstance(value, dict):
            return
        extra = str(value.get("midway_summary") or value.get("midway_note") or "")
        if not extra:
            return
        result.feedback_note = (result.feedback_note + "\n" + extra).strip() \
            if result.feedback_note else extra


# ── 进程级单例 ───────────────────────────────────────────────────────────────

_executor: Optional[CuaActionRegistry] = None


def get_cua_executor() -> CuaActionRegistry:
    """进程级动作层单例（桌面后端）。测试用 set_cua_executor 替换。"""
    global _executor
    if _executor is None:
        _executor = CuaActionRegistry(backend=CuaDesktopBackend())
    return _executor


def set_cua_executor(executor: Optional[CuaActionRegistry]) -> None:
    """替换单例（测试）。传 None 复位，下次取用时重建。"""
    global _executor
    _executor = executor


# ═══ 桌面/浏览器统一 Target 协议（U4）══════════════════════════════════════
#
# 只用标准库：桌面与
# 浏览器标签实现同一 Target 接口，动作层/权限层/反馈闭环零改动接入——域差异
# 被 TargetRef 与后端实现封装，派发前统一过同一份 registry.check_permission。
#
#     TargetRef             目标引用（desktop:0 | tab:{session_id}/{tab_id} | app:{pid}）
#     ObserveResult         观察产物（OCR 行 + 截图路径 + 诚实失败位）
#     TargetBackend         协议（typing.Protocol，runtime_checkable）：observe / act
#     DesktopTargetBackend  桌面域实现：包裹既有 CuaDesktopBackend + registry
#     BrowserTargetBackend  标签域实现：包裹 BrowserSessionManager（构造注入）
#     TargetRouter          注册 + 解析 + 派发 + 权限两域单源同判

#: 标签生命周期管理能力组（审计/前端分组用；命名风格与桌面 CAP_* 同族）。
CAP_TAB_MANAGE = "tab_manage"

#: 目标引用的合法域。desktop: 整块桌面（显示器编号自 0 起，为多显示器预留）；
#: tab: 任务会话里的一个浏览器标签；app: 本机进程窗口（按 PID，接口预留）。
TARGET_KINDS: tuple[str, ...] = ("desktop", "tab", "app")

#: 非法引用的报错尾注——消息必须列出全部合法形态，调用方（多为模型）拿它自查。
_TARGET_REF_USAGE = "target_ref 合法形态: desktop:0 | tab:{session_id}/{tab_id} | app:{pid}"


@dataclass(frozen=True)
class TargetRef:
    """一个可观察/可操作目标的统一引用（U4）。

    Attributes:
        kind: 目标域（TARGET_KINDS 之一：desktop / tab / app）。
        session_id: 域内会话号（tab 域 = 浏览器任务会话号；其余域为空串）。
        object_id: 域内对象号（desktop = 显示器编号；tab = 标签号；app = 进程 PID）。
    """

    kind: str
    session_id: str = ""
    object_id: str = ""

    def format(self) -> str:
        """规范字符串形态（format_target_ref 的便捷入口）。"""
        return format_target_ref(self)


def format_target_ref(ref: TargetRef) -> str:
    """TargetRef → 规范字符串。desktop/app 两段式；tab 三段式（会话号不可省）。"""
    kind = str(getattr(ref, "kind", "") or "").strip().lower()
    if kind == "tab":
        return f"tab:{ref.session_id}/{ref.object_id}"
    if kind in ("desktop", "app"):
        return f"{kind}:{ref.object_id}"
    raise ValueError(f"未知目标域: {kind!r}。{_TARGET_REF_USAGE}")


def parse_target_ref(target_ref: Optional[str]) -> TargetRef:
    """字符串 → TargetRef；None 缺省整块桌面（desktop:0）。

    空串 / 未知域 / 缺对象号 / 坏分隔 / 非数字编号一律 ValueError，消息列出
    全部合法形态——绝不猜、绝不静默回落桌面：引用错了就该大声失败，让调用方
    拿着纠错清单重试。
    """
    if target_ref is None:
        return TargetRef("desktop", "", "0")
    if isinstance(target_ref, TargetRef):
        return target_ref
    text = str(target_ref).strip()
    if not text:
        raise ValueError(f"target_ref 不能为空。{_TARGET_REF_USAGE}")
    domain, sep, body = text.partition(":")
    if not sep:
        raise ValueError(
            f"target_ref 缺少域分隔符 ':': {text!r}。{_TARGET_REF_USAGE}")
    domain = domain.strip().lower()
    if domain not in TARGET_KINDS:
        raise ValueError(f"未知目标域 {domain!r}。{_TARGET_REF_USAGE}")
    body = body.strip()
    if not body:
        raise ValueError(f"target_ref 缺少对象号: {text!r}。{_TARGET_REF_USAGE}")
    if domain == "tab":
        session_id, slash, tab_id = body.partition("/")
        session_id, tab_id = session_id.strip(), tab_id.strip()
        if not slash or not session_id or not tab_id or "/" in tab_id:
            raise ValueError(
                f"tab 域引用需要会话号与标签号两段齐全、以单个 '/' 分隔: "
                f"{text!r}。{_TARGET_REF_USAGE}")
        return TargetRef("tab", session_id, tab_id)
    if not body.isdigit():   # desktop = 显示器编号；app = 进程 PID——都必须是数字
        what = "显示器编号" if domain == "desktop" else "进程 PID"
        raise ValueError(
            f"{domain} 域对象号必须是数字（{what}）: {text!r}。{_TARGET_REF_USAGE}")
    return TargetRef(domain, "", body)


def _as_target_ref(target_ref) -> TargetRef:
    """后端入口的防御性归一：接受 TargetRef 或其字符串形态。"""
    return target_ref if isinstance(target_ref, TargetRef) \
        else parse_target_ref(target_ref)


@dataclass
class ObserveResult:
    """一次目标观察的统一产物（U4）——桌面与浏览器同一形状。

    ok=False 是诚实失败位：截图/识别任何一步失败都如实在此报告，绝不返回
    装作"屏幕为空"的假成功；失败时已拿到的中间产物（截图路径）照样带上。
    """

    ocr_lines: list[str]                       # OCR 提取的可见文本行（去空行）
    screenshot_path: str = ""                  # 观察截图落盘路径
    meta: dict = field(default_factory=dict)   # 域内明细（target_ref/宽高/标签号…）
    ok: bool = True
    error: str = ""


def _ocr_lines_of(ocr_value) -> list[str]:
    """从 OCR 引擎输出提取非空文本行（与 summarize_ocr 同一提取约定）。"""
    lines: list[str] = []
    if isinstance(ocr_value, dict):
        for item in ocr_value.get("lines") or []:
            if isinstance(item, dict):
                t = str(item.get("text", "")).strip()
                if t:
                    lines.append(t)
    return lines


@runtime_checkable
class TargetBackend(Protocol):
    """桌面/浏览器统一目标协议（U4）：observe 只读世界，act 改世界。

    后端只长这张脸（鸭子类型；runtime_checkable 供接线自检）。动作层/权限层
    不区分域——同一动作同一参数在两域的权限结论必须逐字一致（单源同判，
    见 TargetRouter）。
    """

    name: str

    def observe(self, target_ref: TargetRef, ctx: Optional[dict]) -> ObserveResult:
        """观察目标：截图 + OCR 提取行，产物是 ObserveResult（诚实失败位）。"""
        ...

    def act(self, target_ref: TargetRef, action: str, params: dict,
            ctx: Optional[dict]) -> Result:
        """对目标执行一个动作：结果是与全库同纪律的 Result（绝不抛异常）。"""
        ...


#: 标签域自有动作声明（U4）。guard_tool 全部映射既有 GUI 工具词表里的
#: window_focus 语义原语——标签的激活/关闭/挂起/恢复/认领与"把焦点交给哪个
#: 窗口"同族（窗口级管理动作）；语义分级、场景地板、standing 规则一律按
#: 既有体系跑，本表不造新工具名、不建新规则。共享动作（navigate/click/...）
#: 不在此表——直接取注册表里与桌面域同一份 ActionSpec（对象级单源）。
BROWSER_ACTION_SPECS: dict[str, ActionSpec] = {
    "activate": ActionSpec(
        "activate", CAP_TAB_MANAGE, "window_focus", "low", True,
        "激活（聚焦）任务会话里的一个标签；挂起中的标签被激活即唤醒并夺焦点"),
    "close": ActionSpec(
        "close", CAP_TAB_MANAGE, "window_focus", "medium", True,
        "关闭任务会话里的一个标签（终态不可再操作；焦点交给最近的在世标签）"),
    "suspend": ActionSpec(
        "suspend", CAP_TAB_MANAGE, "window_focus", "low", True,
        "挂起一个活动标签以省内存（页面实体拆下、状态保留，可 resume 恢复）"),
    "resume": ActionSpec(
        "resume", CAP_TAB_MANAGE, "window_focus", "low", True,
        "恢复一个挂起的标签（不夺焦点——聚焦是 activate 的事）"),
    "claim": ActionSpec(
        "claim", CAP_TAB_MANAGE, "window_focus", "low", True,
        "凭「提及即引用」快照认领既有标签：标题与 URL 逐一全等比对，不符即拒"),
}


class DesktopTargetBackend:
    """桌面域 Target 后端（U4）：包裹既有 CuaDesktopBackend + registry。

    act 原样走 registry.execute——权限→执行→反馈闭环零损耗（registry 自己
    还会再过一遍权限，与 router 的前置裁决同源同判，结论必然一致；保留这层
    是让不经 router 的直连路径保有完整闭环）。observe 走 screenshot+OCR
    提取行。既有 CuaDesktopBackend 本体保持原样可用——迁移期兼容，v2 渐进。
    """

    name = "desktop"

    def __init__(self, desktop_backend: Optional[CuaDesktopBackend] = None,
                 registry: Optional[CuaActionRegistry] = None):
        if registry is not None:
            self._registry = registry
            self._desktop = desktop_backend if desktop_backend is not None \
                else registry.backend
        elif desktop_backend is not None:
            self._desktop = desktop_backend
            self._registry = CuaActionRegistry(backend=desktop_backend)
        else:
            self._registry = get_cua_executor()
            self._desktop = self._registry.backend

    # ── 协议实现 ──────────────────────────────────────────────────────────

    def observe(self, target_ref, ctx: Optional[dict] = None) -> ObserveResult:
        """观察桌面：截图落盘 → OCR 提取文本行。失败诚实报告，不装空屏。"""
        ctx = ctx if isinstance(ctx, dict) else {}
        ref = _as_target_ref(target_ref)
        try:
            shot = self._desktop.screenshot(
                {"save_path": feedback_path("observe", ctx), "quality": 70}, ctx)
        except Exception as e:
            return ObserveResult(ocr_lines=[], ok=False,
                                 error=f"观察截图失败: {e}")
        if not getattr(shot, "ok", False):
            return ObserveResult(
                ocr_lines=[], ok=False,
                error=f"观察截图失败: {getattr(shot, 'error', '')}")
        value = shot.value if isinstance(shot.value, dict) else {}
        path = str(value.get("path", ""))
        meta = {"target_ref": format_target_ref(ref), "screenshot_path": path}
        for key in ("width", "height", "scale_factor"):
            if value.get(key) is not None:
                meta[key] = value[key]
        try:
            ocr = self._desktop._get_ocr_fn()(path)
        except Exception as e:
            return ObserveResult(ocr_lines=[], ok=False,
                                 error=f"观察识别失败: {e}",
                                 screenshot_path=path, meta=meta)
        if not getattr(ocr, "ok", False):
            return ObserveResult(
                ocr_lines=[], ok=False,
                error=f"OCR 不可用: {getattr(ocr, 'error', '')}",
                screenshot_path=path, meta=meta)
        return ObserveResult(ocr_lines=_ocr_lines_of(ocr.value),
                             screenshot_path=path, meta=meta)

    def act(self, target_ref, action: str, params: Optional[dict] = None,
            ctx: Optional[dict] = None) -> Result:
        """桌面动作：原样走 registry.execute（CuaActionResult → Result 转换）。"""
        car = self._registry.execute(str(action or ""), params, ctx)
        if car.ok:
            return Result.success(car.to_dict())
        return Result.failure(car.error, action=car.action, elapsed_ms=car.elapsed_ms)


class BrowserTargetBackend:
    """标签域 Target 后端（U4）：包裹 BrowserSessionManager（构造注入，绝不自建单例）。

    SUPPORTED_ACTIONS 之外的动作诚实失败（"浏览器后端暂不支持动作 X"）——
    绝不假装执行。observe 走 capture_tab + OCR 提取行。所有失败原样透传
    会话层的 Result——文案的单一真相源在 browser_sessions。
    """

    name = "browser"

    #: 本域真正支持的动作集（能力诚实性的唯一依据；与 BROWSER_ACTION_SPECS +
    #: 共享动作 navigate 对齐）。navigate 是共享动作（声明在桌面注册表，
    #: 复用 validate_url 把坏 URL 挡在桥前），其余五个是标签域自有声明。
    SUPPORTED_ACTIONS = frozenset(
        {"navigate", "activate", "close", "suspend", "resume", "claim"})

    def __init__(self, manager: "BrowserSessionManager",
                 ocr_fn: Optional[Callable[[str], Result]] = None):
        self._manager = manager
        self._ocr_fn = ocr_fn

    def _get_ocr_fn(self) -> Callable[[str], Result]:
        if self._ocr_fn is None:
            from edge.ocr import OCR
            holder: dict = {}

            def _recognize(path: str) -> Result:
                if "ocr" not in holder:
                    holder["ocr"] = OCR()
                return holder["ocr"].recognize(path)

            self._ocr_fn = _recognize
        return self._ocr_fn

    # ── 协议实现 ──────────────────────────────────────────────────────────

    def observe(self, target_ref, ctx: Optional[dict] = None) -> ObserveResult:
        """观察标签：capture_tab 落盘 → OCR 提取文本行。失败诚实报告。"""
        ctx = ctx if isinstance(ctx, dict) else {}
        ref = _as_target_ref(target_ref)
        task_id = str(ref.session_id or "")
        if not task_id:
            return ObserveResult(
                ocr_lines=[], ok=False,
                error=f"观察失败: 缺少会话号。{_TARGET_REF_USAGE}")
        object_id = str(ref.object_id or "")
        try:
            save_path = os.path.join(
                feedback_dir(ctx),
                f"tab_{object_id or 'focus'}_{time.strftime('%Y%m%d_%H%M%S')}"
                f"_{int(time.time() * 1000) % 1000:03d}.png")
        except Exception:
            save_path = ""
        try:
            r = self._manager.capture_tab(task_id, tab_id=object_id or None,
                                          save_path=save_path or None)
        except Exception as e:
            return ObserveResult(ocr_lines=[], ok=False,
                                 error=f"标签截图失败: {e}")
        if not getattr(r, "ok", False):
            return ObserveResult(
                ocr_lines=[], ok=False,
                error=str(getattr(r, "error", "") or "标签截图失败"))
        info = r.value if isinstance(r.value, dict) else {}
        path = str(info.get("path", ""))
        meta = {"target_ref": format_target_ref(ref), "screenshot_path": path}
        for key in ("tab_id", "session_id", "width", "height"):
            if info.get(key) is not None:
                meta[key] = info[key]
        try:
            ocr = self._get_ocr_fn()(path)
        except Exception as e:
            return ObserveResult(ocr_lines=[], ok=False,
                                 error=f"观察识别失败: {e}",
                                 screenshot_path=path, meta=meta)
        if not getattr(ocr, "ok", False):
            return ObserveResult(
                ocr_lines=[], ok=False,
                error=f"OCR 不可用: {getattr(ocr, 'error', '')}",
                screenshot_path=path, meta=meta)
        return ObserveResult(ocr_lines=_ocr_lines_of(ocr.value),
                             screenshot_path=path, meta=meta)

    def act(self, target_ref, action: str, params: Optional[dict] = None,
            ctx: Optional[dict] = None) -> Result:
        """标签动作：六支持动作直通会话层，其余诚实失败（消息含动作名）。"""
        params = params if isinstance(params, dict) else {}
        ref = _as_target_ref(target_ref)
        if str(ref.kind or "") != "tab":
            return Result.failure(
                f"浏览器后端只服务 tab 域目标，收到: {format_target_ref(ref)}")
        task_id = str(ref.session_id or "")
        tab_id = str(ref.object_id or "")
        if not task_id:
            return Result.failure(f"浏览器后端缺少会话号。{_TARGET_REF_USAGE}")
        action = str(action or "").strip()
        if action == "navigate":
            try:
                url = validate_url(params.get("url", ""))
            except ValueError as e:
                return Result.failure(str(e))      # 坏 URL 挡在桥前
            return self._manager.navigate_tab(task_id, url, tab_id=tab_id or None)
        if action == "activate":
            return self._manager.activate_tab(task_id, tab_id)
        if action == "close":
            return self._manager.close_tab(task_id, tab_id)
        if action == "suspend":
            return self._manager.suspend_tab(task_id, tab_id)
        if action == "resume":
            return self._manager.resume_tab(task_id, tab_id)
        if action == "claim":
            # 「提及即引用」：params 的快照两键组凭据，标签号取自 target_ref；
            # 失败文案（不存在/已变化/不属于本会话）由会话层原样给出。
            claim = TabClaim(
                object_id=tab_id,
                title_snapshot=str(params.get("title_snapshot") or ""),
                url_snapshot=str(params.get("url_snapshot") or ""))
            return self._manager.claim_tab(task_id, claim)
        return Result.failure(f"浏览器后端暂不支持动作 {action}")


class TargetRouter:
    """目标路由器（U4）：按 TargetRef 的域派发 observe/act，权限两域单源同判。

    权限一致性是本类的存在理由：
      · 共享动作（navigate/click/fill/...）——直接取注册表里与桌面域同一份
        ActionSpec（对象级同一，不是复制）；
      · 标签域自有动作（activate/close/suspend/resume/claim）——取
        BROWSER_ACTION_SPECS（guard_tool 映射既有 window_focus 语义原语）；
      · 最终裁决统一走 registry.check_permission——裸档 + U2 场景地板 +
        standing 规则 + 预批准来源白名单，两域一条路径。
    能力诚实性判定放在权限放行之后：后端不支持的动作如实报"暂不支持"，
    绝不让"不支持"冒充"被拒"，也不让权限话术掩盖能力事实。
    """

    def __init__(self, registry: Optional[CuaActionRegistry] = None):
        self._registry = registry
        self._backends: dict[str, object] = {}

    # ── 注册与解析 ────────────────────────────────────────────────────────

    @property
    def registry(self) -> CuaActionRegistry:
        """权限/声明单源：未注入时懒取进程级桌面注册表。"""
        if self._registry is None:
            self._registry = get_cua_executor()
        return self._registry

    def register_backend(self, kind: str, backend) -> None:
        """注册一个域的后端。kind 必须在 TARGET_KINDS 词表内，未知域 ValueError。"""
        kind = str(kind or "").strip().lower()
        if kind not in TARGET_KINDS:
            raise ValueError(
                f"未知目标域: {kind!r}。合法域: {', '.join(TARGET_KINDS)}")
        self._backends[kind] = backend

    def resolve(self, target_ref) -> Result:
        """TargetRef/字符串 → 承接该域的后端。未注册域诚实失败。"""
        try:
            ref = _as_target_ref(target_ref)
        except ValueError as e:
            return Result.failure(str(e))
        backend = self._backends.get(ref.kind)
        if backend is None:
            registered = ", ".join(sorted(self._backends)) or "无"
            return Result.failure(
                f"目标域 {ref.kind} 未注册后端（已注册: {registered}）——"
                "该域目标当前不可观察也不可操作")
        return Result.success(backend)

    # ── 权限单源 ──────────────────────────────────────────────────────────

    def _spec_for(self, kind: str, action: str) -> Optional[ActionSpec]:
        """一个动作在指定域的权限声明：共享动作取注册表同一份，标签自有取专表。"""
        spec = self.registry.get(action)
        if spec is not None:
            return spec
        if kind == "tab":
            return BROWSER_ACTION_SPECS.get(action)
        return None

    def action_names(self, kind: str) -> list[str]:
        """指定域的可用动作全集（共享 ∪ 域自有），供报错信息与前端面板。"""
        names = set(self.registry.names())
        if str(kind or "").strip().lower() == "tab":
            names.update(BROWSER_ACTION_SPECS)
        return sorted(names)

    # ── 门面 ──────────────────────────────────────────────────────────────

    def observe(self, target_ref, ctx: Optional[dict] = None) -> ObserveResult:
        """统一观察入口：解析 → 解析域 → 后端观察。失败诚实落在 ObserveResult。"""
        try:
            ref = _as_target_ref(target_ref)
        except ValueError as e:
            return ObserveResult(ocr_lines=[], ok=False, error=str(e))
        resolved = self.resolve(ref)
        if not resolved.ok:
            return ObserveResult(ocr_lines=[], ok=False, error=str(resolved.error))
        try:
            return resolved.value.observe(ref, ctx if isinstance(ctx, dict) else {})
        except Exception as e:
            return ObserveResult(ocr_lines=[], ok=False, error=f"观察失败: {e}")

    def act(self, target_ref, action: str, params: Optional[dict] = None,
            ctx: Optional[dict] = None) -> Result:
        """统一动作入口：解析 → 域后端 → 权限单源裁决 → 能力诚实性 → 执行。"""
        try:
            ref = _as_target_ref(target_ref)
        except ValueError as e:
            return Result.failure(str(e))
        params = params if isinstance(params, dict) else {}
        ctx = ctx if isinstance(ctx, dict) else {}
        action = str(action or "").strip()
        resolved = self.resolve(ref)
        if not resolved.ok:
            return Result.failure(str(resolved.error))
        spec = self._spec_for(ref.kind, action)
        if spec is None:
            return Result.failure(
                f"未知动作: {action}。可用动作: {', '.join(self.action_names(ref.kind))}")
        allowed, reason = self.registry.check_permission(spec, params, ctx)
        if not allowed:
            return Result.failure(reason)
        try:
            return resolved.value.act(ref, action, params, ctx)
        except Exception as e:
            return Result.failure(f"动作派发异常: {e}")

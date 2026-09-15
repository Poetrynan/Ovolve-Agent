"""
browser_sessions.py — 浏览器多标签会话管理。


每 AI 任务独立浏览器会话"机制——只借鉴三条结构判据: 标签生命周期状态机 /
任务级会话隔离 / 每标签视口控制与截图 surface。实现、命名与文案 100% 自研。

职责分界（与 Electron 侧 electron/browserManager.ts）:
  - Electron 管窗口与 guest 页面实体: 标签视图的创建/挂载/挂起分离/销毁、
    像素级截图、每标签视口 bounds 的实际生效；
  - Python（本模块）管会话状态与编排: 每个AI 任务一个 BrowserSession，内含
    多个 Tab 的生命周期 (active/suspended/closed)，任务切换时的状态快照/恢
    复，以及跨任务互不干扰（标签归属校验 + 会话间零共享）。
  - 两侧通过既有 8766 HTTP 桥通信（桥客户端注入，本模块不 import
    browser_agent——是它 import 本模块，桥客户端运行期才惰性构造）。

Result 纪律: 所有会话操作返回 Result，绝不抛异常。桥调用失败时不提交状态
变更（Python 与 Electron 两侧不因一次失败而漂移）。
"""
from __future__ import annotations

import base64
import os
import tempfile
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Optional

from result import Result

# ── 标签生命周期状态 ─────────────────────────────────────────────────────────
TAB_ACTIVE = "active"          # 在世且可用（焦点与否由 session.active_tab_id 决定）
TAB_SUSPENDED = "suspended"    # 挂起省内存：Electron 已拆下页面，状态保留
TAB_CLOSED = "closed"          # 终态：不可再操作

_LIVE_STATES = (TAB_ACTIVE, TAB_SUSPENDED)

#: 找不到任务级会话时使用的兜底任务号（单任务/手工使用的默认会话）。
DEFAULT_TASK_ID = "default"

#: 同时在册的会话上限——内存护栏，防止失控任务把标签表撑爆。
MAX_SESSIONS = 16


def resolve_task_id(args: dict, ctx: dict = None) -> str:
    """从工具参数/上下文解析任务号: args.task_id > ctx.task_id > ctx.session_id > default。

    会话按任务号隔离，所以任务号的来源必须稳定可解释；三者都缺时落回
    "default"（交互式单任务场景），绝不静默串会话。
    """
    args = args or {}
    ctx = ctx or {}
    for source in (args.get("task_id"), ctx.get("task_id"), ctx.get("session_id")):
        if source:
            return str(source)
    return DEFAULT_TASK_ID


@dataclass
class TabRecord:
    """一个标签的会话内状态（Python 是生命周期状态的权威，Electron 是实体）。"""
    tab_id: str
    url: str = ""
    title: str = ""
    state: str = TAB_ACTIVE
    viewport: Optional[dict] = None   # {"width": int, "height": int}；None = 填满窗口
    opened_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "tab_id": self.tab_id,
            "url": self.url,
            "title": self.title,
            "state": self.state,
            "viewport": dict(self.viewport) if self.viewport else None,
            "opened_at": self.opened_at,
        }


# ═══ 会话（纯状态机，不碰桥）═══

class BrowserSession:
    """一个 AI 任务的浏览器会话：若干标签 + 焦点指针 + 生命周期状态机。

    严格状态机:
      open    → active（新标签；默认夺焦点，与浏览器 UX 一致）
      activate: active/suspended → active（挂起标签被激活即唤醒）并夺焦点
      suspend : active → suspended（重复挂起/对挂起标签挂起 → 拒绝）
      resume  : suspended → active（不夺焦点——激活是 activate 的事）
      close   : active/suspended → closed（终态；此后一切操作拒绝）
    """

    def __init__(self, session_id: str, task_id: str):
        self.session_id = session_id
        self.task_id = task_id
        self.tabs: dict[str, TabRecord] = {}   # dict 保插入序 = 打开序
        self.active_tab_id: Optional[str] = None
        self.created_at = time.time()
        self.last_active = self.created_at
        self.active_until: float = 0.0

    def touch(self, now: Optional[float] = None) -> None:
        """刷新活跃时间戳。"""
        ts = now if now is not None else time.time()
        self.last_active = ts
        if self.active_tab_id and self.active_tab_id in self.tabs:
            self.tabs[self.active_tab_id].last_active = ts

    def mark_run_active(self, duration_s: float = 300.0, now: Optional[float] = None) -> None:
        """标记活跃 Run，防止被空闲收割。"""
        ts = now if now is not None else time.time()
        self.active_until = max(getattr(self, "active_until", 0.0), ts + duration_s)

    # ── 查询 ──

    def get_tab(self, tab_id: str) -> Optional[TabRecord]:
        return self.tabs.get(tab_id)

    def is_owned(self, tab_id: str) -> bool:
        return tab_id in self.tabs

    def live_tabs(self) -> list[TabRecord]:
        return [t for t in self.tabs.values() if t.state in _LIVE_STATES]

    def latest_live_tab_id(self) -> Optional[str]:
        for tab in reversed(self.live_tabs()):
            return tab.tab_id
        return None

    def latest_focusable_tab_id(self) -> Optional[str]:
        """最近一个“可立即成为焦点”的标签（active；挂起标签需先唤醒）。"""
        for tab in reversed(self.tabs.values()):
            if tab.state == TAB_ACTIVE:
                return tab.tab_id
        return None

    def _set_focus(self, tab_id: Optional[str]) -> None:
        self.active_tab_id = tab_id

    def _refocus_after_loss(self, lost_tab_id: str) -> Optional[str]:
        """焦点标签退场（关闭/挂起）时，把焦点交给最近的其他 active 标签。"""
        if self.active_tab_id != lost_tab_id:
            return self.active_tab_id
        nxt = self.latest_focusable_tab_id()
        self._set_focus(nxt)
        return nxt

    # ── 状态机 ──

    def open_tab(self, tab_id: str, url: str = "", title: str = "",
                 focus: bool = True) -> Result:
        if tab_id in self.tabs:
            return Result.failure(f"tab id already exists in this session: {tab_id}")
        record = TabRecord(tab_id=tab_id, url=url or "", title=title or "")
        self.tabs[tab_id] = record
        if focus:
            self._set_focus(tab_id)
        return Result.success(record.to_dict())

    def activate_tab(self, tab_id: str) -> Result:
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be activated")
        record.state = TAB_ACTIVE
        self._set_focus(tab_id)
        return Result.success(record.to_dict())

    def suspend_tab(self, tab_id: str) -> Result:
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be suspended")
        if record.state == TAB_SUSPENDED:
            return Result.failure(f"tab '{tab_id}' is already suspended")
        record.state = TAB_SUSPENDED
        new_focus = self._refocus_after_loss(tab_id)
        return Result.success({**record.to_dict(), "new_focus": new_focus})

    def resume_tab(self, tab_id: str) -> Result:
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be resumed")
        if record.state == TAB_ACTIVE:
            return Result.failure(f"tab '{tab_id}' is not suspended")
        record.state = TAB_ACTIVE
        return Result.success(record.to_dict())

    def close_tab(self, tab_id: str) -> Result:
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is already closed")
        record.state = TAB_CLOSED
        new_focus = self._refocus_after_loss(tab_id)
        return Result.success({**record.to_dict(), "new_focus": new_focus})

    def set_viewport(self, tab_id: str, width: int, height: int) -> Result:
        record = self._live_tab_for_viewport(tab_id)
        if isinstance(record, Result):
            return record
        try:
            w, h = int(width), int(height)
        except (TypeError, ValueError):
            return Result.failure(f"viewport needs numeric width/height, got {width!r}x{height!r}")
        if w <= 0 or h <= 0 or w > 10000 or h > 10000:
            return Result.failure(f"viewport out of range (1..10000): {w}x{h}")
        record.viewport = {"width": w, "height": h}
        return Result.success(record.to_dict())

    def reset_viewport(self, tab_id: str) -> Result:
        record = self._live_tab_for_viewport(tab_id)
        if isinstance(record, Result):
            return record
        record.viewport = None
        return Result.success(record.to_dict())

    def _live_tab_for_viewport(self, tab_id: str):
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be resized")
        return record

    def note_navigation(self, tab_id: str, url: str, title: str = "") -> Result:
        """导航落定后回写标签事实（url/标题/唤醒/夺焦点）。

        导航即唤醒即展示：对挂起标签导航，Electron 侧会重新挂载并显示，
        Python 侧同步把状态与焦点对齐，避免两侧各说各话。
        """
        record = self.tabs.get(tab_id)
        if record is None:
            return Result.failure(f"unknown tab '{tab_id}' in task '{self.task_id}'")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be navigated")
        record.url = url
        if title:
            record.title = title
        if record.state == TAB_SUSPENDED:
            record.state = TAB_ACTIVE
        self._set_focus(tab_id)
        return Result.success(record.to_dict())

    # ── 快照 / 恢复（任务切换时保存/恢复会话状态）──

    def snapshot_state(self) -> dict:
        """可序列化快照：只存“事实”（在世标签 + 焦点），closed 不入快照。"""
        return {
            "session_id": self.session_id,
            "task_id": self.task_id,
            "saved_at": time.time(),
            "active_tab_id": self.active_tab_id
            if self.active_tab_id and self.active_tab_id in {t.tab_id for t in self.live_tabs()}
            else None,
            "tabs": [t.to_dict() for t in self.live_tabs()],
        }

    def restore_state(self, state: dict) -> Result:
        """把快照覆盖回会话（Python 是状态权威；Electron 侧由编排层去收敛）。

        快照里没有的本会话标签保持原样（不误杀快照后新开的东西）。
        """
        if not isinstance(state, dict) or not isinstance(state.get("tabs"), list):
            return Result.failure("malformed session snapshot (tabs list missing)")
        if state.get("session_id") and state["session_id"] != self.session_id:
            return Result.failure(
                f"snapshot belongs to session {state['session_id']!r}, not {self.session_id!r}")
        for raw in state["tabs"]:
            if not isinstance(raw, dict) or not raw.get("tab_id"):
                return Result.failure("malformed tab entry in session snapshot")
            tab_id = str(raw["tab_id"])
            state_name = raw.get("state", TAB_ACTIVE)
            if state_name not in (TAB_ACTIVE, TAB_SUSPENDED, TAB_CLOSED):
                return Result.failure(f"unknown tab state in snapshot: {state_name!r}")
            viewport = raw.get("viewport")
            if viewport is not None and (
                not isinstance(viewport, dict)
                or not isinstance(viewport.get("width"), int)
                or not isinstance(viewport.get("height"), int)
            ):
                viewport = None
            existing = self.tabs.get(tab_id)
            if existing is None:
                existing = TabRecord(
                    tab_id=tab_id,
                    url=str(raw.get("url") or ""),
                    title=str(raw.get("title") or ""),
                    opened_at=float(raw.get("opened_at") or time.time()),
                )
                self.tabs[tab_id] = existing
            existing.url = str(raw.get("url") or existing.url)
            existing.title = str(raw.get("title") or existing.title)
            existing.viewport = dict(viewport) if viewport else None
            existing.state = state_name
        focus = state.get("active_tab_id")
        focus_record = self.tabs.get(focus) if focus else None
        if focus_record is not None and focus_record.state in _LIVE_STATES:
            self._set_focus(focus)
        else:
            self._set_focus(self.latest_live_tab_id())
        return Result.success({
            "restored_tabs": len(state["tabs"]),
            "active_tab_id": self.active_tab_id,
        })

    def summary(self) -> dict:
        return {
            "session_id": self.session_id,
            "task_id": self.task_id,
            "active_tab_id": self.active_tab_id,
            "tabs": [t.to_dict() for t in self.tabs.values()],
            "live_count": len(self.live_tabs()),
        }


# ═══ 编排层（会话状态 + 桥驱动）═══

class BrowserSessionManager:
    """会话编排：每个 AI 任务一个 BrowserSession，桥调用失败不提交状态。

    桥客户端只需长着 ``call(endpoint, payload, timeout=35) -> Result`` 这张
    脸（生产环境注入 browser_agent.ElectronBrowserClient；测试注入假桥）。
    """

    def __init__(self, client=None, workspace: str = None,
                 id_factory: Optional[Callable[[], str]] = None,
                 session_id: str = "bs"):
        self._client = client
        self.workspace = workspace
        self.session_id = session_id
        self._id_factory = id_factory or self._default_id_factory
        self._sessions: dict[str, BrowserSession] = {}
        self._snapshots: dict[str, dict] = {}
        self._seq = 0
        #: 有界事件流水（可观测性；不接异步 EventBus，避免同步编排层被拖进事件循环）
        self.event_log: deque = deque(maxlen=200)

    # ── 基础设施 ──

    def _default_id_factory(self) -> str:
        self._seq += 1
        return f"tab-{self._seq:04d}-{uuid.uuid4().hex[:6]}"

    def _bridge(self):
        if self._client is None:
            # 运行期才导入，避免与 browser_agent 的模块级循环
            from browser_agent import ElectronBrowserClient
            self._client = ElectronBrowserClient()
        return self._client

    def _call(self, endpoint: str, payload: dict, timeout: int = 35) -> Result:
        return self._bridge().call(endpoint, payload, timeout=timeout)

    def _log(self, event: str, task_id: str, tab_id: str = None, detail: str = "") -> None:
        self.event_log.append({
            "ts": time.time(), "event": event, "task_id": task_id,
            "tab_id": tab_id, "detail": detail,
        })

    def _session_for(self, task_id: str, auto_begin: bool = True) -> Result:
        session = self._sessions.get(task_id)
        if session is not None:
            return Result.success(session)
        if not auto_begin:
            return Result.failure(f"no active browser session for task '{task_id}'")
        begun = self.begin_session(task_id)
        if not begun.ok:
            return begun
        return Result.success(self._sessions[task_id])

    def _resolve_tab(self, session: BrowserSession, tab_id: Optional[str]) -> Result:
        """把“可选标签号”解析成在世标签：缺省落在焦点标签上。"""
        target = tab_id or session.active_tab_id
        if not target:
            return Result.failure(
                f"no tab given and task '{session.task_id}' has no focused tab — open one first")
        record = session.get_tab(target)
        if record is None:
            return Result.failure(
                f"unknown tab '{target}' in task '{session.task_id}' "
                "(tabs are private to their task's session)")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{target}' is closed")
        return Result.success(record)

    # ── 会话级生命周期 ──

    def begin_session(self, task_id: str) -> Result:
        existing = self._sessions.get(task_id)
        if existing is not None:
            return Result.success({**existing.summary(), "created": False})
        if len(self._sessions) >= MAX_SESSIONS:
            return Result.failure(
                f"too many live browser sessions ({MAX_SESSIONS}); end one before beginning another")
        session = BrowserSession(session_id=f"{self.session_id}-{task_id}", task_id=task_id)
        self._sessions[task_id] = session
        self._log("session_begin", task_id)
        return Result.success({**session.summary(), "created": True})

    def end_session(self, task_id: str) -> Result:
        session = self._sessions.get(task_id)
        if session is None:
            return Result.failure(f"no active browser session for task '{task_id}'")
        closed, errors = 0, []
        for record in session.live_tabs():
            br = self._call("tab_close", {"tab_id": record.tab_id})
            if br.ok:
                closed += 1
            else:
                errors.append(f"{record.tab_id}: {br.error}")
        self._sessions.pop(task_id, None)
        self._snapshots.pop(task_id, None)
        self._log("session_end", task_id, detail=f"closed={closed} errors={len(errors)}")
        return Result.success({"closed": closed, "bridge_errors": errors})

    def touch(self, task_id: str, now: Optional[float] = None) -> None:
        """刷新会话及当前焦点标签的活跃时间戳。"""
        session = self._sessions.get(task_id)
        if session is not None:
            session.touch(now=now)

    def mark_run_active(self, task_id: str, duration_s: float = 300.0, now: Optional[float] = None) -> None:
        """标记活跃 Run，防止被空闲收割。"""
        session = self._sessions.get(task_id)
        if session is not None:
            session.mark_run_active(duration_s=duration_s, now=now)

    def suspend_session(self, task_id: str) -> Result:
        """任务切换走人：先拍快照（纯事实），再把所有 active 标签挂起省内存。"""
        session = self._sessions.get(task_id)
        if session is None:
            return Result.failure(f"no active browser session for task '{task_id}'")
        snap = session.snapshot_state()
        self._snapshots[task_id] = snap
        suspended, errors = 0, []
        for record in list(session.live_tabs()):
            if record.state != TAB_ACTIVE:
                continue
            br = self._call("tab_suspend", {"tab_id": record.tab_id})
            if br.ok:
                session.suspend_tab(record.tab_id)
                suspended += 1
            else:
                errors.append(f"{record.tab_id}: {br.error}")
        self._log("session_suspend", task_id, detail=f"suspended={suspended}")
        return Result.success({
            "suspended": suspended,
            "snapshot_tabs": len(snap["tabs"]),
            "active_tab_id": session.active_tab_id,
            "bridge_errors": errors,
        })

    def resume_session(self, task_id: str) -> Result:
        """任务切回来：Python 先恢复权威状态，再驱动 Electron 收敛到同一事实。"""
        session = self._sessions.get(task_id)
        if session is None:
            return Result.failure(f"no active browser session for task '{task_id}'")
        snap = self._snapshots.pop(task_id, None)
        if not snap:
            return Result.failure(
                f"no saved state to restore for task '{task_id}' (suspend it first)")
        restored = session.restore_state(snap)
        if not restored.ok:
            return restored
        errors = []
        for raw in snap["tabs"]:
            endpoint = "tab_resume" if raw.get("state") == TAB_ACTIVE else "tab_suspend"
            br = self._call(endpoint, {"tab_id": raw["tab_id"]})
            if not br.ok:
                errors.append(f"{raw['tab_id']}: {br.error}")
        focus = session.active_tab_id
        if focus:
            br = self._call("tab_activate", {"tab_id": focus})
            if not br.ok:
                errors.append(f"focus {focus}: {br.error}")
        self._log("session_resume", task_id, detail=f"tabs={restored.value['restored_tabs']}")
        return Result.success({
            "restored_tabs": restored.value["restored_tabs"],
            "active_tab_id": focus,
            "bridge_errors": errors,
        })

    def switch_task(self, from_task: str, to_task: str) -> Result:
        """任务切换的一站式入口：挂起旧任务 → 恢复（或新建）新任务。"""
        notes: dict = {}
        if self._sessions.get(from_task) is not None:
            r = self.suspend_session(from_task)
            if not r.ok:
                return r
            notes["from"] = r.value
        if to_task == from_task:
            # 切回自己＝纯恢复
            if to_task in self._snapshots:
                r = self.resume_session(to_task)
                if not r.ok:
                    return r
                notes["to"] = r.value
            return Result.success(notes)
        begun = self.begin_session(to_task)
        if not begun.ok:
            return begun
        if to_task in self._snapshots:
            r = self.resume_session(to_task)
            if not r.ok:
                return r
            notes["to"] = r.value
        else:
            notes["to"] = {"created": True, "active_tab_id": None}
        return Result.success(notes)

    # ── 标签级操作（校验 → 桥 → 提交）──

    def open_tab(self, task_id: str, url: str = "", focus: bool = True,
                 visible: bool = True) -> Result:
        session_r = self._session_for(task_id)
        if not session_r.ok:
            return session_r
        session = session_r.value
        tab_id = self._id_factory()
        br = self._call("tab_open", {"tab_id": tab_id, "url": url or "", "visible": bool(visible)})
        if not br.ok:
            return br
        info = br.value if isinstance(br.value, dict) else {}
        committed = session.open_tab(
            tab_id, url=str(info.get("url") or url or ""),
            title=str(info.get("title") or ""), focus=focus)
        if not committed.ok:
            return committed
        self._log("tab_open", task_id, tab_id)
        return Result.success(committed.value)

    def navigate_tab(self, task_id: str, url: str, tab_id: str = None,
                     visible: bool = True) -> Result:
        """导航 = 会话内事实变更。会话还没有在世标签时顺手开第一个。"""
        session_r = self._session_for(task_id)
        if not session_r.ok:
            return session_r
        session = session_r.value
        target = tab_id or session.active_tab_id
        if target:
            record = session.get_tab(target)
            if record is None:
                return Result.failure(
                    f"unknown tab '{target}' in task '{task_id}' "
                    "(tabs are private to their task's session)")
            if record.state == TAB_CLOSED:
                return Result.failure(f"tab '{target}' is closed")
            br = self._call("navigate", {"url": url, "visible": bool(visible), "tab_id": target})
            if not br.ok:
                return br
            info = br.value if isinstance(br.value, dict) else {}
            committed = session.note_navigation(target, url, str(info.get("title") or ""))
            if not committed.ok:
                return committed
            self._log("navigate", task_id, target)
            return Result.success({**committed.value, "opened": False})
        # 第一个标签：一次 tab_open 完成“建实体 + 加载”
        return self.open_tab(task_id, url=url, focus=True, visible=visible)

    def activate_tab(self, task_id: str, tab_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        session = session_r.value
        # 只读预检（unknown/closed），避免对坏请求打桥；状态变更留给桥成功后的提交
        record = session.get_tab(tab_id)
        if record is None:
            return Result.failure(
                f"unknown tab '{tab_id}' in task '{task_id}' "
                "(tabs are private to their task's session)")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is closed and cannot be activated")
        br = self._call("tab_activate", {"tab_id": tab_id})
        if not br.ok:
            return br
        committed = session.activate_tab(tab_id)
        if not committed.ok:
            return committed
        self._log("tab_activate", task_id, tab_id)
        return committed

    def close_tab(self, task_id: str, tab_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        session = session_r.value
        record = session.get_tab(tab_id)
        if record is None:
            return Result.failure(
                f"unknown tab '{tab_id}' in task '{task_id}' "
                "(tabs are private to their task's session)")
        if record.state == TAB_CLOSED:
            return Result.failure(f"tab '{tab_id}' is already closed")
        br = self._call("tab_close", {"tab_id": tab_id})
        if not br.ok:
            return br
        committed = session.close_tab(tab_id)
        if not committed.ok:
            return committed
        self._log("tab_close", task_id, tab_id)
        return committed

    def suspend_tab(self, task_id: str, tab_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        session = session_r.value
        record = session.get_tab(tab_id)
        if record is None:
            return Result.failure(
                f"unknown tab '{tab_id}' in task '{task_id}' "
                "(tabs are private to their task's session)")
        if record.state != TAB_ACTIVE:
            return Result.failure(
                f"tab '{tab_id}' cannot be suspended from state '{record.state}'")
        br = self._call("tab_suspend", {"tab_id": tab_id})
        if not br.ok:
            return br
        committed = session.suspend_tab(tab_id)
        if not committed.ok:
            return committed
        new_focus = committed.value.get("new_focus")
        # 挂起的是焦点标签时，把窗口交给最近的其他在世标签（有就展示）
        if new_focus:
            fr = self._call("tab_activate", {"tab_id": new_focus})
            if fr.ok:
                session.activate_tab(new_focus)
        self._log("tab_suspend", task_id, tab_id)
        return committed

    def resume_tab(self, task_id: str, tab_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        session = session_r.value
        record = session.get_tab(tab_id)
        if record is None:
            return Result.failure(
                f"unknown tab '{tab_id}' in task '{task_id}' "
                "(tabs are private to their task's session)")
        if record.state != TAB_SUSPENDED:
            return Result.failure(
                f"tab '{tab_id}' cannot be resumed from state '{record.state}'")
        br = self._call("tab_resume", {"tab_id": tab_id})
        if not br.ok:
            return br
        committed = session.resume_tab(tab_id)
        if not committed.ok:
            return committed
        # 恢复后若会话没有有效焦点（窗口空着），顺手把舞台交给它
        if session.active_tab_id is None or session.get_tab(
                session.active_tab_id) is None or session.get_tab(
                session.active_tab_id).state == TAB_SUSPENDED:
            fr = self._call("tab_activate", {"tab_id": tab_id})
            if fr.ok:
                session.activate_tab(tab_id)
        self._log("tab_resume", task_id, tab_id)
        return committed

    # ── 视口（每标签独立，挂起/恢复后由 Electron 依据其标签记录重现）──

    def set_viewport(self, task_id: str, width: int, height: int,
                     tab_id: str = None) -> Result:
        session_r = self._session_for(task_id)
        if not session_r.ok:
            return session_r
        session = session_r.value
        target_r = self._resolve_tab(session, tab_id)
        if not target_r.ok:
            return target_r
        precheck = session.set_viewport(target_r.value.tab_id, width, height)
        if not precheck.ok:
            return precheck
        br = self._call("viewport", {
            "tab_id": target_r.value.tab_id,
            "width": precheck.value["viewport"]["width"],
            "height": precheck.value["viewport"]["height"],
        })
        if not br.ok:
            # 桥失败不提交：两侧不漂移
            session.reset_viewport(target_r.value.tab_id)
            return br
        self._log("viewport_set", task_id, target_r.value.tab_id,
                  detail=f"{precheck.value['viewport']['width']}x{precheck.value['viewport']['height']}")
        return precheck

    def reset_viewport(self, task_id: str, tab_id: str = None) -> Result:
        session_r = self._session_for(task_id)
        if not session_r.ok:
            return session_r
        session = session_r.value
        target_r = self._resolve_tab(session, tab_id)
        if not target_r.ok:
            return target_r
        br = self._call("viewport", {"tab_id": target_r.value.tab_id, "reset": True})
        if not br.ok:
            return br
        committed = session.reset_viewport(target_r.value.tab_id)
        if not committed.ok:
            return committed
        self._log("viewport_reset", task_id, target_r.value.tab_id)
        return committed

    # ── 查询 / 截图 ──

    def list_tabs(self, task_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        return Result.success(session_r.value.summary())

    def session_state(self, task_id: str) -> Result:
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        snap = self._snapshots.get(task_id)
        return Result.success({**session_r.value.summary(),
                               "has_saved_snapshot": snap is not None})

    def capture_tab(self, task_id: str, tab_id: str = None,
                    save_path: str = None) -> Result:
        """截取一个标签的画面（截图就绪接口：供 CUA 动作层未来复用）。

        返回 value 形状 {"path", "width", "height", "tab_id", "session_id"}，
        与 cua_actions 桌面后端的截图结果同族，方便那侧以后直接调用。
        挂起标签由 Electron 侧唤醒后拍摄（ detachment 期间不产像素）。
        """
        session_r = self._session_for(task_id, auto_begin=False)
        if not session_r.ok:
            return session_r
        session = session_r.value
        target_r = self._resolve_tab(session, tab_id)
        if not target_r.ok:
            return target_r
        target = target_r.value.tab_id
        br = self._call("tab_snapshot", {"tab_id": target}, timeout=60)
        if not br.ok:
            return br
        info = br.value if isinstance(br.value, dict) else {}
        data_uri = str(info.get("dataUri") or "")
        if not data_uri:
            return Result.failure(f"tab '{target}' returned no image payload")
        if not save_path:
            base_dir = self.workspace or tempfile.gettempdir()
            save_path = os.path.join(
                base_dir, "screenshots", f"tab_{target}_{int(time.time())}.png")
        saved = _save_data_uri(data_uri, save_path)
        if not saved.ok:
            return saved
        if session.get_tab(target) and session.get_tab(target).state == TAB_SUSPENDED:
            # Electron 为拍摄唤醒了它——两侧对齐成 active + 焦点
            session.activate_tab(target)
        self._log("tab_snapshot", task_id, target, detail=str(saved.value))
        return Result.success({
            "path": saved.value,
            "width": info.get("width"),
            "height": info.get("height"),
            "tab_id": target,
            "session_id": session.session_id,
        })


def _save_data_uri(data_uri: str, path: str) -> Result:
    try:
        _, _, b64 = data_uri.partition(",")
        if not b64:
            return Result.failure("screenshot data uri has no payload")
        raw = base64.b64decode(b64)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as f:
            f.write(raw)
        return Result.success(path)
    except Exception as e:
        return Result.failure(f"failed to save screenshot: {e}")


# ═══ 认领协议（「提及即引用」，fail-closed）═══
#
# 用户话语里提到的既有对象不是一段描述，而是一张引用凭据: Agent 接管（聚焦/
# 操作）前必须出示提及当时记下的快照，与现状逐一全等比对，任一不符即拒绝——
# 绝不静默接管"长得差不多"的对象。比对是原始全等（==）: 无相似度、无 url
# 前缀豁免、不归一化空白与大小写；宁可请用户重新引用一次，也不替用户做主。


@dataclass
class TabClaim:
    """标签认领凭据——「提及即引用」的载体。

    用户提及某个既有标签时，Agent 当场记下 (object_id, 标题, url) 快照；
    接管前用 claim_tab 把快照与标签现状逐一全等比对。claimed_at_ms 由认领
    成功时自动回填（失败绝不盖章），可当作"该引用仍然有效"的凭据。
    """
    object_id: str                 # 提及的标签号（会话内私有 id）
    title_snapshot: str = ""       # 提及时的标题快照
    url_snapshot: str = ""         # 提及时的 url 快照
    kind: str = "tab"              # 对象类别；tab 域认领恒为 "tab"
    claimed_at_ms: int = 0         # 成功认领的毫秒时间戳；仅成功时盖章


@dataclass
class AppClaim:
    """应用窗口认领凭据（app 域预留）: (窗口标题, 进程号, 启动时间) 三元组。

    与 TabClaim 同一协议思想——提及即引用、快照比对、fail-closed；实现随
    远程执行体系另行落地，此处先固定凭据形状供工具层预留参数。
    """
    window_title: str = ""
    process_id: int = 0
    started_at_ms: int = 0


def _session_claim_tab(self: BrowserSession, claim: TabClaim) -> Result:
    """认领一个既有标签——fail-closed 三查，全过才接管。

    1) 存在性: 标签必须在册且在世（closed 是终态，视同不存在）;
    2) 快照比对: (标题, url) 与凭据快照逐一原始全等；不全等即拒绝，且拒绝
       消息同时给出"引用时的快照"与"当前现状"，请用户重新引用后再认领;
    3) 接管: 复用 activate_tab 聚焦（挂起标签顺带唤醒），并回填 claimed_at_ms。

    比对不过绝不触碰会话状态（不聚焦、不唤醒、不盖章）——fail-closed，
    不存在"相似也算过"的静默接管路径。
    """
    if not isinstance(claim, TabClaim) or claim.kind != "tab":
        return Result.failure("认领失败: 凭据类型不符（claim_tab 只接受 TabClaim）")
    record = self.tabs.get(claim.object_id)
    if record is None or record.state == TAB_CLOSED:
        return Result.failure(f"认领失败: 标签 {claim.object_id} 不存在（可能已关闭）")
    if claim.title_snapshot != record.title or claim.url_snapshot != record.url:
        return Result.failure(
            f"认领失败: 对象已变化（引用时: {claim.title_snapshot} | "
            f"{claim.url_snapshot} → 当前: {record.title} | {record.url}），"
            "请重新引用后再认领")
    activated = self.activate_tab(claim.object_id)
    if not activated.ok:
        return activated
    claim.claimed_at_ms = int(time.time() * 1000)
    return Result.success({"tab": activated.value, "claim": claim})


def _manager_claim_tab(self: BrowserSessionManager, task_id: str,
                       claim: TabClaim) -> Result:
    """编排层认领: 门槛（会话存在 + 归属）在此，比对与接管下放会话。

    - auto_begin=False: 认领不偷偷建会话——无会话的任务得到既有的
      "no active browser session" 失败，而不是凭空冒出一个空会话；
    - is_owned: 标签私有于其任务会话，别家任务的标签（或幽灵 id）一律拒绝，
      且此路径不产生任何桥调用（对方会话零波及）；
    - 认领只提交 Python 侧焦点/唤醒事实，桥零调用；Electron 侧的实际聚焦由
      编排层（browser_agent）随后用既有 tab_activate 收敛，分工与
      restore_state 同理。
    """
    session_r = self._session_for(task_id, auto_begin=False)
    if not session_r.ok:
        return session_r
    session = session_r.value
    if not session.is_owned(getattr(claim, "object_id", None)):
        return Result.failure("认领失败: 标签不属于当前任务会话")
    claimed = session.claim_tab(claim)
    if claimed.ok:
        self._log("claim_tab", task_id, getattr(claim, "object_id", None))
    return claimed


def _manager_claim_app_window(self: BrowserSessionManager, task_id: str,
                              claim: AppClaim) -> Result:
    """app 域认领桩: 接口已预留，实现随远程执行体系另行落地。"""
    return Result.failure("认领失败: app 窗口认领接口已预留，实现随远程执行体系另行落地")


# 分区约束（既有类体不可改）: 新方法以模块级函数定义后挂载到类上
BrowserSession.claim_tab = _session_claim_tab
BrowserSessionManager.claim_tab = _manager_claim_tab
BrowserSessionManager.claim_app_window = _manager_claim_app_window


# ── 共享单例（无 agent 上下文时的兜底；BrowserAgent 自持实例并注入其桥客户端）──

_manager: Optional[BrowserSessionManager] = None


def get_shared_session_manager(workspace: str = None,
                               client=None) -> BrowserSessionManager:
    global _manager
    if _manager is None:
        _manager = BrowserSessionManager(workspace=workspace, client=client)
    return _manager

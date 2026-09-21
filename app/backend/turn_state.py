"""turn_state.py — 回合状态：从二值升级为持久化枚举（2.1）。

## 为什么需要它

在这之前，「回合在不在跑」是一个**活性探测**而不是状态：
`http_server._turn_running()` 问的是「那个 asyncio task 还在吗」，前端只有一个
`isWorking: boolean`。这带来三个具体的坏后果：

1. **「在等用户」表达不出来。** 前端只能从 `toolCalls` 里反推
   （`agentStore.isAwaitingUser`）——用工具调用的形状去猜回合的状态，猜错了
   界面就骗人。
2. **「暂停」根本不存在。** 点停止之后回合就没了，没有「回来接着跑」这回事。
3. **重启后回合本身丢失。** `ask_user` 有 kv 账本、问题卡片能恢复，但**回合**
   恢复不了；`risk_control._pending_confirmations` 连账本都没有，重启后待确认
   的工具调用彻底消失。`http_server.py` 里那句「这组问题已经不在等待中了
   （可能已回答或后端重启过）」就是缺状态打出来的补丁。

## 两条轴，别混在一起

- **status**（这一层）：`idle / running / waiting_user / paused / completed /
  error`。少而稳，是前端和恢复逻辑真正要判断的东西。
- **substatus**：直接从现成的 `agent_phases.TurnPhase` **折叠**出来，不新造词。
  phase 有 12 个值、每回合会跳很多次，一比一存进去等于把状态表当日志写。折叠
  成 5 个桶之后它就是「现在大致在干什么」，够前端叙述用，也不会一秒写十次库。

## 非法迁移只记日志，不抛

沿用全仓既有基调——可观测性绝不弄死回合。状态机写错了最坏是界面显示得不准，
而抛异常会让一个**本来能跑完**的回合挂在状态更新上。这个取舍在这个模块里是
单向的：宁可状态不准，不可回合中断。
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Optional


class TurnStatus(str, Enum):
    """一个会话当前处在哪个回合状态。

    值就是落库和上线的字符串，**不要重命名**——前端按字符串判断，库里也存着
    历史行。新增状态往后加。
    """

    IDLE = "idle"
    #: 没有回合在跑，也没有任何东西等着人。全新会话和正常收工都是这个。

    RUNNING = "running"
    #: 回合正在跑。`substatus` 说明具体在哪一段。

    WAITING_USER = "waiting_user"
    #: 回合停在「必须等人」上——ask_user 的问题卡片，或者一个待确认的工具调用。
    #: 关键点：这**不是** idle。回合还在，只是球在用户那边。

    PAUSED = "paused"
    #: 用户点了停止。和 error 的区别是它**可以继续**（`resume_turn`）。

    COMPLETED = "completed"
    #: 回合正常跑完了。

    ERROR = "error"
    #: 回合失败收场。


#: 允许的迁移。白名单而不是黑名单：漏掉一条合法迁移会在日志里立刻现形，
#: 而漏掉一条**非法**迁移会静默地让状态图变成一团乱麻。
_ALLOWED: dict[TurnStatus, frozenset] = {
    TurnStatus.IDLE: frozenset({TurnStatus.RUNNING}),
    TurnStatus.RUNNING: frozenset({
        TurnStatus.WAITING_USER, TurnStatus.PAUSED,
        TurnStatus.COMPLETED, TurnStatus.ERROR,
    }),
    # 等人之后：人回答了就继续跑，人点了停止就暂停，等超时/放弃就收尾。
    TurnStatus.WAITING_USER: frozenset({
        TurnStatus.RUNNING, TurnStatus.PAUSED,
        TurnStatus.COMPLETED, TurnStatus.ERROR,
    }),
    # 暂停之后：resume 回到 running，或者用户干脆丢掉这个回合（→ idle）。
    TurnStatus.PAUSED: frozenset({TurnStatus.RUNNING, TurnStatus.IDLE}),
    # 终态回到 idle 是「翻页」，也是下一个回合的起点。
    TurnStatus.COMPLETED: frozenset({TurnStatus.IDLE, TurnStatus.RUNNING}),
    TurnStatus.ERROR: frozenset({TurnStatus.IDLE, TurnStatus.RUNNING}),
}

#: 重启后哪些状态能活下来。
#:
#: `running` **不能**——那个 asyncio task 已经随进程一起没了，留着它前端会永远
#: 转圈等一个不会回来的回合。开机时把它改写成 `error`，用户看到的是「上次那轮
#: 没跑完」，这是真话。
#:
#: `waiting_user` 和 `paused` 能活：前者有 ask_user 的持久账本把卡片恢复出来，
#: 后者本来就是「停在这儿等你决定」，进程重启不改变这个事实。
SURVIVES_RESTART: frozenset = frozenset({
    TurnStatus.IDLE, TurnStatus.WAITING_USER, TurnStatus.PAUSED,
    TurnStatus.COMPLETED, TurnStatus.ERROR,
})

#: `TurnPhase` → substatus 的折叠表。
#:
#: 键是 `agent_phases.TurnPhase` 的 wire 字符串（那个枚举的契约是值永不重命名，
#: 所以按字符串索引是安全的）。刻意**不 import** agent_phases：状态机不该为了
#: 一张查表去依赖发事件的那一侧，字符串是这里唯一需要的契约。
_PHASE_FOLD: dict[str, str] = {
    "turn_entered": "preparing",
    "permission_resolved": "preparing",
    "workspace_ready": "preparing",
    "context_engine": "preparing",
    "context_assembled": "preparing",
    "model_call_started": "thinking",
    "assistant_output_started": "thinking",
    "tool_execution_started": "tooling",
    "tool_execution_finished": "tooling",
    "step_boundary": "stepping",
    "assistant_reply_finalized": "finishing",
    "post_turn_hooks": "finishing",
    "turn_completed": "",
}


def fold_phase(phase: str) -> str:
    """把一个 `TurnPhase` 值折成 substatus。

    认不出的 phase 返回空串而不是原值：新加的 phase 在这张表补全之前，让
    substatus 空着比让它显示一个 `foo_bar` 更诚实——空着是「不知道」，原值是
    「假装知道」。
    """
    return _PHASE_FOLD.get(str(phase or "").strip(), "")


class TurnStateMachine:
    """迁移的唯一入口。

    独占的意义：全仓只有这一个地方能改 `turn_status`，所以「状态怎么变的」是
    可以只读这一个文件回答的问题。绕过它直接 UPDATE 就等于把状态图散回原来
    那种到处是 `isWorking = true` 的形态。
    """

    def __init__(self, storage) -> None:
        self.storage = storage

    # ── 读 ────────────────────────────────────────────────────────────────

    def current(self, session_id: str) -> TurnStatus:
        """当前状态。读不到（会话不存在 / 列还没迁移）一律当 idle。"""
        row = None
        try:
            row = self.storage.get_session(session_id)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        raw = (row or {}).get("turn_status") or ""
        try:
            return TurnStatus(str(raw))
        except ValueError:
            return TurnStatus.IDLE

    def snapshot(self, session_id: str) -> dict:
        """给前端的一份状态快照。连接时拉一次就能恢复。"""
        row = {}
        try:
            row = self.storage.get_session(session_id) or {}
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        status = self.current(session_id)
        return {
            "sessionId": session_id,
            "status": status.value,
            "substatus": row.get("turn_substatus") or "",
            "updatedAt": row.get("status_updated_at") or 0,
            # 前端的 isWorking 从此是这个的派生值，而不是一个独立的真相来源。
            "working": status is TurnStatus.RUNNING,
        }

    # ── 写 ────────────────────────────────────────────────────────────────

    def transition(self, session_id: str, to: TurnStatus,
                   substatus: str = "", *, force: bool = False) -> bool:
        """迁移到 `to`。返回是否真的写了。

        Args:
            session_id: 目标会话。
            to: 目标状态。
            substatus: 可选子态（用 `fold_phase` 折出来的那种）。
            force: 跳过白名单校验。只给两个地方用——开机时的陈旧态清理，和
                「无论如何都要落到 idle」的兜底。业务代码不该传它。

        Returns:
            True 写入成功；False 表示被白名单拦下或写库失败。**两种情况都不抛**。
        """
        if not session_id:
            return False
        frm = self.current(session_id)
        if to is frm:
            # 同态迁移不是错误，但也不该刷 status_updated_at —— 那个时间戳的
            # 意思是「状态什么时候变的」，不是「什么时候被写过」。substatus
            # 变了才值得落一次。
            if substatus:
                return self._write(session_id, to, substatus)
            return False
        if not force and to not in _ALLOWED.get(frm, frozenset()):
            print(f"[turn_state] illegal transition {frm.value} -> {to.value} "
                  f"(session={session_id}); ignored")
            return False
        return self._write(session_id, to, substatus)

    def note_phase(self, session_id: str, phase: str) -> None:
        """回合内的 phase 推进，只更新 substatus。

        刻意不碰 status：phase 每回合跳很多次，如果它能改 status，那
        `waiting_user` 会在下一个 phase 到达时被悄悄冲掉，而「在等人」恰恰是
        最不能丢的那个状态。
        """
        folded = fold_phase(phase)
        if not folded:
            return
        if self.current(session_id) is not TurnStatus.RUNNING:
            return
        self._write(session_id, TurnStatus.RUNNING, folded)

    def reset_stale(self) -> int:
        """开机清理：把上一条命留下的 `running` 改写成 `error`。

        必须在服务起来之前跑一次。不跑的话前端一连上就会看到一个永远转圈的
        回合——它等的那个 task 在上一个进程里，不会回来了。

        Returns:
            改写了几行。
        """
        try:
            return int(self.storage.reset_stale_turn_status(
                stale=TurnStatus.RUNNING.value, to=TurnStatus.ERROR.value,
            ))
        except Exception as exc:  # noqa: BLE001
            print(f"[turn_state] stale reset skipped: {exc}")
            return 0

    def _write(self, session_id: str, to: TurnStatus, substatus: str) -> bool:
        try:
            self.storage.set_turn_status(
                session_id, to.value, substatus, int(time.time()),
            )
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"[turn_state] write failed (session={session_id}): {exc}")
            return False


_machine: Optional[TurnStateMachine] = None


def get_turn_state() -> TurnStateMachine:
    """进程内单例。状态的权威在库里，这个对象只是通往库的那扇门。"""
    global _machine
    if _machine is None:
        from storage import get_storage
        _machine = TurnStateMachine(get_storage())
    return _machine

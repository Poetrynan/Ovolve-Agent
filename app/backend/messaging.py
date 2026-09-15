"""
messaging.py — 双层消息队列（Pi 工程范式 §五）

send_message(msg, deliver_as="steer"|"followUp"|"nextTurn")
  - steer:    立即打断当前循环，注入新指令（用户改需求）
  - followUp: 等 Agent 本轮跑完再投递（用户补充背景）
  - nextTurn: 排到下一轮

解决"用户等不及 Agent 跑完"的体验问题。


"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


#: A steer message goes stale after this many seconds. If it was queued while a
#: slow tool was running and the user has since moved on, injecting it into the
#: next step boundary would derail a conversation the user has already forgotten
#: about. Long enough to survive any single tool call we run, short enough to
#: keep zombie steers from resurfacing after the topic changed.
STEER_TTL_S: float = 300.0

#: Steer 队列高低水位背压（High/Low Watermark Backpressure）。
#: 超过 30 条暂停入队并拒绝，防止无节制转向压垮 Agent 迭代；
#: 消费排空至 15 条以下后自动恢复入队。
STEER_HIGH_WATERMARK: int = 30
STEER_LOW_WATERMARK: int = 15

#: How many characters total we're willing to inject into ``messages`` in one
#: drain. A user hammering the steer box (dozens of tries during a stuck tool)
#: shouldn't be able to flood the next model call with 40k tokens of nagging.
#: Anything past the cap is dropped, oldest-first, with a one-line note left in
#: place of the drops so the model can see there was more it didn't see.
MAX_STEER_MERGED_CHARS: int = 24_000


class DeliverAs(Enum):
    STEER = "steer"        # 立即打断
    FOLLOW_UP = "followUp"  # 本轮完成后投递
    NEXT_TURN = "nextTurn"  # 下一轮


@dataclass
class QueuedMessage:
    """队列中的消息。"""
    content: str
    deliver_as: DeliverAs
    sender: str = "user"
    timestamp: float = 0.0
    metadata: dict = field(default_factory=dict)


class MessageQueue:
    """双层消息队列：steer / followUp / nextTurn 三档。

    - steer 队列：Agent 循环每次迭代前检查，有则立即打断
    - followUp 队列：Agent 本轮结束后检查，有则立即投递下一轮
    - nextTurn 队列：排到下一轮对话

    另有一条 **UI 待发送队列**（``_items``）：这是给桌面端"待发送 N 条"面板用的
    单一事实来源。它带稳定 id、支持增删改、拖拽重排、暂停/恢复，并可导出快照
    让重连/刷新后的客户端重新同步。后端持有它，渲染进程只是它的镜像。
    """

    def __init__(self):
        self._steer: list[QueuedMessage] = []
        self._follow_up: list[QueuedMessage] = []
        self._next_turn: list[QueuedMessage] = []
        self._lock = asyncio.Lock()
        self._notifier = asyncio.Event()
        #: How many steer messages have been dropped for being past their TTL.
        #: Cheap counter, only ever incremented under the lock in poll_steer.
        self._expired_steers: int = 0
        self._steer_saturated: bool = False
        self._steer_closing: bool = False
        # ── UI 待发送队列 ──
        self._items: list[dict] = []
        self._paused: bool = False
        self._pause_reason: Optional[str] = None
        self._seq: int = 0

    async def send_message(
        self,
        content: str,
        deliver_as: DeliverAs | str = DeliverAs.FOLLOW_UP,
        sender: str = "user",
        **metadata,
    ) -> QueuedMessage:
        """发送消息到指定队列。"""
        if isinstance(deliver_as, str):
            deliver_as = DeliverAs(deliver_as)

        msg = QueuedMessage(
            content=content,
            deliver_as=deliver_as,
            sender=sender,
            timestamp=time.time(),
            metadata=metadata,
        )

        async with self._lock:
            if deliver_as == DeliverAs.STEER:
                if self._steer_closing:
                    # 收件箱正在收尾关闭：将纠偏消息原子降级并入 followUp 桶，杜绝收尾竞态丢失
                    msg.deliver_as = DeliverAs.FOLLOW_UP
                    self._follow_up.append(msg)
                else:
                    if len(self._steer) >= STEER_HIGH_WATERMARK:
                        self._steer_saturated = True
                        raise ValueError(
                            f"转向过多，请等待排空（当前已达高水位 {len(self._steer)}/{STEER_HIGH_WATERMARK} 条限制）"
                        )
                    self._steer.append(msg)
            elif deliver_as == DeliverAs.FOLLOW_UP:
                self._follow_up.append(msg)
            else:
                self._next_turn.append(msg)
            self._notifier.set()

        return msg

    async def submit_steer(
        self,
        content: str,
        sender: str = "user",
        **metadata,
    ) -> QueuedMessage:
        """发送转向/纠偏消息到 steer 队列（若收尾关闭则自动降级到 followUp）。"""
        return await self.send_message(
            content=content,
            deliver_as=DeliverAs.STEER,
            sender=sender,
            **metadata,
        )

    async def close_steer_inbox(self) -> bool:
        """原子关闭 steer 收件（close_if_empty 语义）。

        若 steer 队列为空则置 _steer_closing=True 并返回 True；
        若非空则返回 False（提示调用方应继续排空后再收件）。
        """
        async with self._lock:
            if not self._steer:
                self._steer_closing = True
                return True
            return False

    async def reopen_steer_inbox(self) -> None:
        """新一轮 run 开始时重置 steer 收件状态。"""
        async with self._lock:
            self._steer_closing = False

    def steer_inbox_closed(self) -> bool:
        """查询 steer 收件箱是否已关闭。"""
        return self._steer_closing

    @property
    def is_steer_closed(self) -> bool:
        """属性访问支持：steer 收件箱是否处于关闭状态。"""
        return self._steer_closing

    async def poll_steer(self, ttl_s: float = STEER_TTL_S) -> Optional[QueuedMessage]:
        """检查 steer 队列（Agent 循环每次迭代前调用）。

        过期的 steer 会被丢弃而不是投递。这不是洁癖：steer 是"趁 Agent 还在跑
        赶紧改需求"，一条五分钟前排进来的纠偏，等到现在再注入，用户早就换话题
        了——它会把一个已经收敛的对话拽回旧岔路，比丢掉它更糟。

        返回第一条**仍然新鲜**的消息；过期的沿途丢掉，不通知（用户已经看不到
        它了，事后再解释一条他忘了的消息只会更困惑）。
        """
        now = time.time()
        async with self._lock:
            while self._steer:
                msg = self._steer.pop(0)
                if len(self._steer) <= STEER_LOW_WATERMARK:
                    self._steer_saturated = False
                if ttl_s > 0 and msg.timestamp and (now - msg.timestamp) > ttl_s:
                    self._expired_steers += 1
                    continue
                return msg
            self._steer_saturated = False
            return None

    @property
    def is_steer_saturated(self) -> bool:
        """是否处于转向饱和状态（高于高水位触发，降至低水位以下复位）。"""
        return self._steer_saturated or len(self._steer) >= STEER_HIGH_WATERMARK

    @property
    def expired_steers(self) -> int:
        """TTL 丢弃过多少条 steer —— 给诊断面板看，也便于自测断言。"""
        return self._expired_steers

    async def poll_follow_up(self) -> Optional[QueuedMessage]:
        """检查 followUp 队列（Agent 本轮结束后调用）。"""
        async with self._lock:
            if self._follow_up:
                return self._follow_up.pop(0)
            return None

    async def poll_next_turn(self) -> Optional[QueuedMessage]:
        """检查 nextTurn 队列。"""
        async with self._lock:
            if self._next_turn:
                return self._next_turn.pop(0)
            return None

    async def drain_all(self) -> list[QueuedMessage]:
        """取出所有队列中的消息（按优先级 steer > followUp > nextTurn）。"""
        async with self._lock:
            msgs = list(self._steer) + list(self._follow_up) + list(self._next_turn)
            self._steer.clear()
            self._follow_up.clear()
            self._next_turn.clear()
            return msgs

    def has_pending(self) -> bool:
        """是否有待处理消息。"""
        return bool(self._steer or self._follow_up or self._next_turn)

    async def wait_for_message(self, timeout: float | None = None) -> Optional[QueuedMessage]:
        """阻塞等待新消息（用于 Bot 远程控制等场景）。"""
        self._notifier.clear()
        try:
            if timeout:
                await asyncio.wait_for(self._notifier.wait(), timeout)
            else:
                await self._notifier.wait()
        except asyncio.TimeoutError:
            return None
        return await self.drain_all()[0] if self.has_pending() else None

    # ── UI 待发送队列（桌面端"待发送 N 条"面板的单一事实来源）──────────────

    async def ui_enqueue(self, text: str, urgent: bool = False,
                         requested: str = "", reason: str = "") -> dict:
        """入队一条待发送 prompt。``urgent`` 插到队首（插队）。

        ``requested`` / ``reason`` 是 2.4 的准入留痕。原来这里只记 ``delivery``——
        也就是**准入的结果**——用户当时想干什么被丢掉了。于是"回合正在跑的时候点
        发送"和"主动排一条"在数据上长得一模一样，界面没法解释为什么这条没立刻发
        出去，用户只看到自己按了发送、然后什么都没发生。

        ``requested`` 记用户要的那档（``send`` / ``steer`` / ``queue``），
        ``reason`` 是给人看的一句话——由调用点决定要不要填，因为"这次和用户预期
        差在哪"只有调用点知道：``steer`` 在无回合可打断时仍然排到队首，
        ``delivery`` 看起来没变，可用户的预期确实落空了。两个都不传时行为与改动
        前完全一致。
        """
        import time
        async with self._lock:
            self._seq += 1
            admitted = "steer" if urgent else "queue"
            item = {
                "id": f"q{self._seq}-{int(time.time() * 1000)}",
                "text": text,
                "delivery": admitted,
                "queuedAt": time.time(),
                # 用户要的那一档。没传就等于"就是要排队"，不算降级。
                "requested": requested or admitted,
                # 空串 = 没什么要解释的，前端据此决定要不要显示那行小字。
                "fallbackReason": reason or "",
            }
            if urgent:
                self._items.insert(0, item)
            else:
                self._items.append(item)
            return item

    async def ui_remove(self, item_id: str) -> None:
        async with self._lock:
            self._items = [i for i in self._items if i["id"] != item_id]

    async def ui_clear(self) -> None:
        async with self._lock:
            self._items.clear()

    async def ui_update_text(self, item_id: str, text: str) -> None:
        async with self._lock:
            for i in self._items:
                if i["id"] == item_id:
                    i["text"] = text
                    break

    async def ui_promote(self, item_id: str) -> None:
        """把某条移到队首，让它成为下一个要发的。"""
        async with self._lock:
            idx = next((n for n, i in enumerate(self._items) if i["id"] == item_id), -1)
            if idx > 0:
                self._items.insert(0, self._items.pop(idx))

    async def ui_reorder(self, ordered_ids: list[str]) -> None:
        """按客户端拖拽后的 id 顺序重排。未出现在列表里的项保持原相对次序追加在后。"""
        async with self._lock:
            by_id = {i["id"]: i for i in self._items}
            reordered = [by_id[i] for i in ordered_ids if i in by_id]
            leftover = [i for i in self._items if i["id"] not in set(ordered_ids)]
            self._items = reordered + leftover

    async def ui_take_next(self) -> Optional[dict]:
        """取出队首（暂停时返回 None）。"""
        async with self._lock:
            if self._paused or not self._items:
                return None
            return self._items.pop(0)

    async def ui_pause(self, reason: str = "manual") -> None:
        async with self._lock:
            self._paused = True
            self._pause_reason = reason

    async def ui_resume(self) -> None:
        async with self._lock:
            self._paused = False
            self._pause_reason = None

    def ui_snapshot(self) -> dict:
        """当前队列快照 —— 新连接/刷新后的客户端用它重建 UI。"""
        return {
            "items": [dict(i) for i in self._items],
            "paused": self._paused,
            "pauseReason": self._pause_reason,
        }

    @property
    def ui_pending(self) -> int:
        return len(self._items)


# 全局消息队列
_queue: Optional[MessageQueue] = None


def get_message_queue() -> MessageQueue:
    global _queue
    if _queue is None:
        _queue = MessageQueue()
    return _queue

"""steer_protocol.py — Mid-flight Steer Queue & Prompt Formatting Protocol.

Formats mid-turn user steer messages for the agent runtime.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, List, Optional


@dataclass
class SteerItem:
    text: str
    source: str = "user"
    timestamp: float = field(default_factory=time.time)


class SteerQueue:
    """Thread-safe queue holding mid-flight steering instructions for an active turn.

    When bound to a MessageQueue, acts as a synchronous adapter delegating to
    MessageQueue so that MessageQueue remains the single source of truth across
    the entire runtime.
    """

    def __init__(self, msg_queue: Optional[Any] = None):
        self._lock = threading.Lock()
        self._items: List[SteerItem] = []
        self._msg_queue: Optional[Any] = None
        if msg_queue is not None:
            self.bind_message_queue(msg_queue)

    def bind_message_queue(self, msg_queue: Any) -> None:
        """Bind underlying MessageQueue as the single source of truth."""
        with self._lock:
            self._msg_queue = msg_queue
            if self._items and self._msg_queue:
                items = list(self._items)
                self._items.clear()
                for item in items:
                    self._enqueue_to_msg_queue(item.text, item.source, item.timestamp)

    def _enqueue_to_msg_queue(self, text: str, source: str, ts: float) -> None:
        mq = self._msg_queue
        if mq is None:
            return
        from messaging import DeliverAs, QueuedMessage
        msg = QueuedMessage(
            content=text,
            deliver_as=DeliverAs.STEER,
            sender=source,
            timestamp=ts,
            metadata={},
        )
        if hasattr(mq, "_steer"):
            mq._steer.append(msg)
            if hasattr(mq, "_notifier") and hasattr(mq._notifier, "set"):
                mq._notifier.set()

    def enqueue(self, text: str, source: str = "user") -> None:
        t = (text or "").strip()
        if not t:
            return
        with self._lock:
            ts = time.time()
            if self._msg_queue is not None:
                if hasattr(self._msg_queue, "_steer") and len(self._msg_queue._steer) >= 30:
                    raise ValueError("转向过多，请等待排空（当前已达高水位 30 条限制）")
                self._enqueue_to_msg_queue(t, source, ts)
            else:
                if len(self._items) >= 30:
                    raise ValueError("转向过多，请等待排空（当前已达高水位 30 条限制）")
                self._items.append(SteerItem(text=t, source=source, timestamp=ts))

    def has_pending(self) -> bool:
        with self._lock:
            if self._msg_queue is not None and hasattr(self._msg_queue, "_steer"):
                return len(self._msg_queue._steer) > 0
            return len(self._items) > 0

    def pending_count(self) -> int:
        with self._lock:
            if self._msg_queue is not None and hasattr(self._msg_queue, "_steer"):
                return len(self._msg_queue._steer)
            return len(self._items)

    def drain_all(self) -> List[SteerItem]:
        with self._lock:
            if self._msg_queue is not None and hasattr(self._msg_queue, "_steer"):
                drained = []
                while self._msg_queue._steer:
                    msg = self._msg_queue._steer.pop(0)
                    drained.append(SteerItem(
                        text=getattr(msg, "content", ""),
                        source=getattr(msg, "sender", "user"),
                        timestamp=getattr(msg, "timestamp", 0.0),
                    ))
                return drained
            items = list(self._items)
            self._items.clear()
            return items


def format_steer_prompt(steer_items: List[SteerItem]) -> str:
    """Render drained steering items into a formal system nudge for the model."""
    if not steer_items:
        return ""
    joined = "\n".join(f"- {item.text}" for item in steer_items)
    return (
        "[系统与用户转向提示] 用户在执行过程中补充/更新了指令，请根据最新意图立即校准并调整接下来的行动方案：\n"
        f"{joined}\n"
        "请确认已收到用户最新调整，并继续推进。"
    )

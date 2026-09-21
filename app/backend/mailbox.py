"""
mailbox.py — §13 Mailbox 原语（Phase 7 收口）。

信箱是子代理/后台任务/系统组件之间的**持久投递通道**：父运行投递任务与控制
消息，后台 review 投递摘要，任何组件都能查询未读。消费即标记（consumed=1）
而不删除——信箱同时是"谁在什么时候被告知了什么"的审计线索。

与 TeamBoard 的分工：Board 管"任务做到哪一步"，Mailbox 管"谁需要知道什么"。

F1 teammate-message 协议：
- format_teammate_message: 封装 sender + summary + content 为统一格式
- strip_teammate_message: 降级为 [@sender] summary（截断时 summary 幸存）
- send_teammate: 便捷投递，自动提取 summary

P1-3 未投递补投（）：目标方离线时消息
进 **deferred 延迟投递队列**（mailbox_deferred 表，持久化、重启不丢），上线/
重连时 ``mark_online`` 按序补投，逐条拿到投递确认后才从队列移除——头条未
确认，后面的不许越过。
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

KIND_TASK = "task"
KIND_CONTROL = "control"
KIND_RESULT = "result"
KIND_INFO = "info"
KINDS = (KIND_TASK, KIND_CONTROL, KIND_RESULT, KIND_INFO)

# F1: teammate-message 协议常量
TEAMMATE_MESSAGE_MAX_SUMMARY = 80  # summary 截断长度
TEAMMATE_MESSAGE_TAG_RE = re.compile(
    r'\[teammate-message\s+sender="([^"]*)"(?:\s+summary="([^"]*)")?\s*\](.*?)\[/teammate-message\]',
    re.DOTALL,
)
TEAMMATE_MESSAGE_PLAIN_RE = re.compile(
    r'\[@(\w+)\]\s*(.*)',  # [@sender] summary 降级格式
)


def format_teammate_message(sender: str, content: str, summary: str = "") -> str:
    """F1: 封装 teammate-message。

    格式: [teammate-message sender="X" summary="Y"]content[/teammate-message]
    - summary 超 80 字符自动截断
    - content 为空时 summary 兜底为 "(no content)"
    - 不抛异常：任何输入都产出可用字符串
    """
    if not summary:
        # 自动从 content 提取 summary：首行前 80 字符
        first_line = (content or "").strip().split("\n", 1)[0].strip()
        summary = first_line[:TEAMMATE_MESSAGE_MAX_SUMMARY] if first_line else "(no content)"
    else:
        summary = summary[:TEAMMATE_MESSAGE_MAX_SUMMARY]

    # 清理 content 中的换行，保持单行
    clean_content = (content or "").replace("\n", " ").strip()
    return f'[teammate-message sender="{sender}" summary="{summary}"]{clean_content}[/teammate-message]'


def strip_teammate_message(text: str) -> str:
    """F1: 剥离 teammate-message 标签，降级为 [@sender] summary。

    三类输入均不抛异常：
    - 正常标签 → [@sender] summary
    - 畸形标签 → 原文返回
    - 无标签 → 原文返回
    """
    if not text:
        return ""
    m = TEAMMATE_MESSAGE_TAG_RE.search(text)
    if m:
        sender = m.group(1)
        summary = m.group(2) or "(no summary)"
        return f"[@{sender}] {summary}"
    # 尝试降级格式
    m2 = TEAMMATE_MESSAGE_PLAIN_RE.match(text.strip())
    if m2:
        return f"[@{m2.group(1)}] {m2.group(2)}"
    return text


def make_teammate_payload(sender: str, content: str, summary: str = "") -> Dict[str, Any]:
    """F1: 构造结构化的 teammate-message payload（存储与渲染解耦）。"""
    if not summary:
        first_line = (content or "").strip().split("\n", 1)[0].strip()
        summary = first_line[:TEAMMATE_MESSAGE_MAX_SUMMARY] if first_line else "(no content)"
    return {
        "formatted": format_teammate_message(sender, content, summary),
        "sender": sender,
        "summary": summary[:TEAMMATE_MESSAGE_MAX_SUMMARY],
        "content": content or "",
    }


def _ensure_table(storage) -> None:
    c = storage._db("sessions")
    c.execute(
        "CREATE TABLE IF NOT EXISTS mailbox_messages ("
        "id TEXT PRIMARY KEY,"
        " box_id TEXT NOT NULL,"
        " sender TEXT NOT NULL,"
        " kind TEXT NOT NULL DEFAULT 'info',"
        " payload TEXT NOT NULL DEFAULT '{}',"
        " consumed INTEGER NOT NULL DEFAULT 0,"
        " created_at INTEGER NOT NULL)"
    )
    c.commit()


def send(storage, box_id: str, sender: str, *, kind: str = KIND_INFO,
         payload: Dict[str, Any] | None = None, summary: str = "") -> str:
    """投递一条消息。未知 kind 视为 info——投递永远不该因为打错标签而失败。

    F1: 新增 summary 参数，存入 payload.summary；summary 为空时自动从
    payload.content 或 payload.formatted 首行提取。
    """
    if kind not in KINDS:
        kind = KIND_INFO
    payload = dict(payload or {})
    # F1: 自动提取 summary
    if summary:
        payload["summary"] = summary[:TEAMMATE_MESSAGE_MAX_SUMMARY]
    elif "summary" not in payload:
        # 尝试从 content 或 formatted 提取
        content = payload.get("content", "") or payload.get("formatted", "")
        if content:
            # 尝试剥离 teammate-message 标签提取 summary
            m = TEAMMATE_MESSAGE_TAG_RE.search(content)
            if m and m.group(2):
                payload["summary"] = m.group(2)[:TEAMMATE_MESSAGE_MAX_SUMMARY]
            else:
                first_line = content.strip().split("\n", 1)[0].strip()
                payload["summary"] = first_line[:TEAMMATE_MESSAGE_MAX_SUMMARY] if first_line else "(no content)"
        else:
            payload["summary"] = "(no content)"
    mid = uuid.uuid4().hex[:12]
    c = storage._db("sessions")
    c.execute(
        "INSERT INTO mailbox_messages"
        " (id, box_id, sender, kind, payload, consumed, created_at)"
        " VALUES (?,?,?,?,?,0,?)",
        (mid, str(box_id), str(sender or "unknown"), kind,
         json.dumps(payload, ensure_ascii=False), int(time.time())),
    )
    c.commit()
    return mid


def send_teammate(storage, box_id: str, sender: str, content: str,
                  summary: str = "") -> str:
    """F1: 便捷函数——封装 teammate-message 并投递到信箱。

    内部调用 send(kind=KIND_INFO, payload=make_teammate_payload(...))。
    """
    payload = make_teammate_payload(sender, content, summary)
    return send(storage, box_id, sender, kind=KIND_INFO, payload=payload)


def unread(storage, box_id: str, *, limit: int = 50) -> List[Dict[str, Any]]:
    rows = storage._db("sessions").execute(
        "SELECT * FROM mailbox_messages"
        " WHERE box_id=? AND consumed=0 ORDER BY created_at, rowid LIMIT ?",
        (str(box_id), int(limit)),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.get("payload") or "{}")
        except (json.JSONDecodeError, TypeError):
            d["payload"] = {}
        out.append(d)
    return out


def drain(storage, box_id: str, *, limit: int = 50) -> List[Dict[str, Any]]:
    """取走全部未读并标记已消费。第二次 drain 返回空——每条只送达一次。

    返回的快照在标记后同步置 consumed=1：调用方拿到的就是投递后的真实状态，
    而不是数据库更新前的旧影。
    """
    msgs = unread(storage, box_id, limit=limit)
    if msgs:
        ids = [m["id"] for m in msgs]
        c = storage._db("sessions")
        c.execute(f"UPDATE mailbox_messages SET consumed=1 "
                  f"WHERE id IN ({','.join('?' * len(ids))})", ids)
        c.commit()
        for m in msgs:
            m["consumed"] = 1
    return msgs


def consume(storage, message_id: str) -> bool:
    """标记单条消息为已消费。已消费过的返回 False——不可重复消费。"""
    c = storage._db("sessions")
    cur = c.execute(
        "UPDATE mailbox_messages SET consumed=1"
        " WHERE id=? AND consumed=0",
        (message_id,),
    )
    c.commit()
    return cur.rowcount > 0


# ── deferred 延迟投递队列（P1-3：未投递补投）───────────────────────────────
#
# ——只学"离线进队 + 上线按序补投 +
# 确认后移除"的队列纪律。目标方离线时 send 会立即制造一条"永远读不到的未读"
# ——积压没有形状，也无法区分"没消息"和"人在别处"。deferred 队列给积压一个
# 持久的形状：进队、按序补投、投递确认后才出队，重启不丢。
#
# 与 mailbox_messages 的分工：后者是"已送达待阅读"（审计线索，消费只标记）；
# deferred 是"还没送达"（投递队列，确认后真删——同一条消息不该同时存在于
# 两个轨道）。

def _ensure_deferred_table(storage) -> None:
    c = storage._db("sessions")
    c.execute(
        "CREATE TABLE IF NOT EXISTS mailbox_deferred ("
        "id TEXT PRIMARY KEY,"
        " box_id TEXT NOT NULL,"
        " sender TEXT NOT NULL,"
        " kind TEXT NOT NULL DEFAULT 'info',"
        " payload TEXT NOT NULL DEFAULT '{}',"
        " created_at INTEGER NOT NULL,"
        " attempts INTEGER NOT NULL DEFAULT 0,"
        " last_attempt_at INTEGER NOT NULL DEFAULT 0)"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_mailbox_deferred_box"
        " ON mailbox_deferred(box_id, created_at)"
    )
    c.commit()


def defer(storage, box_id: str, sender: str, *, kind: str = KIND_INFO,
          payload: Dict[str, Any] | None = None) -> str:
    """目标方离线：消息进延迟队列等补投。返回队列消息 id。"""
    if kind not in KINDS:
        kind = KIND_INFO
    _ensure_deferred_table(storage)
    did = uuid.uuid4().hex[:12]
    c = storage._db("sessions")
    c.execute(
        "INSERT INTO mailbox_deferred"
        " (id, box_id, sender, kind, payload, created_at, attempts, last_attempt_at)"
        " VALUES (?,?,?,?,?,?,0,0)",
        (did, str(box_id), str(sender or "unknown"), kind,
         json.dumps(dict(payload or {}), ensure_ascii=False), int(time.time())),
    )
    c.commit()
    return did


def send_or_defer(storage, box_id: str, sender: str, *, kind: str = KIND_INFO,
                  payload: Dict[str, Any] | None = None,
                  online: Union[bool, Callable[[Any, str], bool], None] = None
                  ) -> Tuple[str, bool]:
    """按目标方在线状态路由：在线→立即 send（走既有轨道）；离线→defer。

    ``online`` 可以是布尔，也可以是 ``callable(storage, box_id)``——由调用方
    定义"在线"（会话活跃、渠道连着、worker 活着都行），信箱不越权判定。
    返回 ``(消息 id, 是否已即时投递)``。
    """
    is_online = online(storage, box_id) if callable(online) else bool(online)
    if is_online:
        return send(storage, box_id, sender, kind=kind, payload=payload), True
    return defer(storage, box_id, sender, kind=kind, payload=payload), False


def _deferred_row_to_msg(r) -> Dict[str, Any]:
    d = dict(r)
    try:
        d["payload"] = json.loads(d.get("payload") or "{}")
    except (json.JSONDecodeError, TypeError):
        d["payload"] = {}
    return d


def pending(storage, box_id: str, *, limit: int = 50) -> List[Dict[str, Any]]:
    """窥视延迟队列（按投递顺序，不出队）。"""
    _ensure_deferred_table(storage)
    rows = storage._db("sessions").execute(
        "SELECT * FROM mailbox_deferred WHERE box_id=?"
        " ORDER BY created_at, rowid LIMIT ?",
        (str(box_id), int(limit)),
    ).fetchall()
    return [_deferred_row_to_msg(r) for r in rows]


def pending_count(storage, box_id: str) -> int:
    _ensure_deferred_table(storage)
    r = storage._db("sessions").execute(
        "SELECT COUNT(*) AS n FROM mailbox_deferred WHERE box_id=?",
        (str(box_id),),
    ).fetchone()
    return int(r["n"]) if r else 0


def _promote_to_mailbox(storage, msg: Dict[str, Any]) -> bool:
    """默认投递动作：把延迟消息升格为正式未读（保留原 id/时间/序）。

    INSERT OR IGNORE 让"升格成功但删除前崩溃"的重试不产生重复——重投一次，
    队列照删，事实只落一次。
    """
    c = storage._db("sessions")
    c.execute(
        "INSERT OR IGNORE INTO mailbox_messages"
        " (id, box_id, sender, kind, payload, consumed, created_at)"
        " VALUES (?,?,?,?,?,0,?)",
        (str(msg["id"]), str(msg["box_id"]), str(msg.get("sender") or "unknown"),
         str(msg.get("kind") or KIND_INFO),
         json.dumps(msg.get("payload") or {}, ensure_ascii=False),
         int(msg.get("created_at") or time.time())),
    )
    c.commit()
    return True


def deliver_pending(storage, box_id: str, *,
                    deliver: Optional[Callable[[Dict[str, Any]], bool]] = None,
                    limit: int = 50) -> Dict[str, Any]:
    """按序补投延迟队列，逐条确认，确认后才出队。

    ``deliver(msg) -> bool`` 是投递动作（True=对端确认收到）。缺省升格进正式
    信箱（unread 可见）。纪律：**头条未确认，后面不许越过**——第一条失败即停，
    整队保持顺序；重试计数留在行上供观测。
    """
    _ensure_deferred_table(storage)
    if deliver is None:
        def deliver(msg: Dict[str, Any]) -> bool:
            return _promote_to_mailbox(storage, msg)

    c = storage._db("sessions")
    delivered, stopped_at, error = 0, None, None
    for msg in pending(storage, box_id, limit=limit):
        ok = False
        try:
            ok = bool(deliver(msg))
        except Exception as exc:  # noqa: BLE001 — 投递动作的失败是数据不是崩溃
            error = f"{type(exc).__name__}: {exc}"
        now = int(time.time())
        if ok:
            c.execute("DELETE FROM mailbox_deferred WHERE id=?", (msg["id"],))
            c.commit()
            delivered += 1
        else:
            c.execute("UPDATE mailbox_deferred SET attempts=attempts+1,"
                      " last_attempt_at=? WHERE id=?", (now, msg["id"]))
            c.commit()
            stopped_at = msg["id"]
            break
    return {"box_id": str(box_id), "delivered": delivered,
            "remaining": pending_count(storage, box_id),
            "stopped_at": stopped_at, "error": error}


def mark_online(storage, box_id: str, *,
                deliver: Optional[Callable[[Dict[str, Any]], bool]] = None,
                limit: int = 50) -> Dict[str, Any]:
    """目标方上线/重连时调用：按序补投全部积压（deliver_pending 的语义名）。"""
    return deliver_pending(storage, box_id, deliver=deliver, limit=limit)

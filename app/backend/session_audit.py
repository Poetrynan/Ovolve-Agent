"""
session_audit.py — 会话模型 I/O 审计轨（P1-3 / G6）。

"结构化库 +
逐会话 jsonl 流水 + 父子关联字段"的轨道分工思想。SQLite（sessions/usage/events.db）
是**查询面**，本模块的逐会话 jsonl 是**审计/回放面**——两者并行写入，互不替代。

Ovolve 适配点：用户目录走 ``user_dirs.home_dir()``（``~/.ovolve``），日志目录
环境变量为 ``OVOLVE_LOGS_DIR``（兼容 session_logger 现行的 ``OVOLVE_LOGS_DIR``）。

设计纪律
--------
* append-only: 每会话一个 ``model_io.jsonl``，只追加不改写；按大小滚动保留
  N 份编号文件（``model_io.jsonl.1`` 最新，编号越大越旧），会话目录布局与
  ``session_logger``（transcript.jsonl 同目录）完全一致。
* fail-open: 审计写入失败**绝不阻塞主流程**——记 warning、计数丢弃，产品继续
  跑。审计丢一段流水是可观测的损失；让一轮对话失败是不可接受的损失。
* 可回放: 每条记录自带 canonical ``event_type``（EventType 值），``read()``
  出来的整段流可重放进一个全新 EventStore 并过 ``verify_chain``——与
  golden replay（eval_harness.replay_golden）同一语义，jsonl 因此成为回放
  数据源之一。
* 父子关联: 每条记录带 ``parent_ref``（父会话 id，自造字段名）。子代理会话
  id 形如 ``bench-x::sub::y``，Windows 非法文件名字符照 session_logger 的
  ``_fs_safe`` 清洗——逻辑 id 不动，只清洗落盘目录名。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:
    from session_logger import SessionLogger
    from user_dirs import home_dir as _user_home_dir
except ImportError:  # pragma: no cover - packaged import shape
    from app.backend.session_logger import SessionLogger
    from app.backend.user_dirs import home_dir as _user_home_dir

log = logging.getLogger(__name__)

#: 每条记录的方向。request=发往模型的输入，response=模型返回，event=轮次
#: 事件（usage/turn 生命周期等无方向事实）。
DIRECTION_REQUEST = "request"
DIRECTION_RESPONSE = "response"
DIRECTION_EVENT = "event"
DIRECTIONS = (DIRECTION_REQUEST, DIRECTION_RESPONSE, DIRECTION_EVENT)

#: 轮次事件短名 → canonical EventType 值（回放映射）。表外名字一律落
#: DIRECTION_EVENT 的兜底值——审计轨宁可记下原始名也不拒绝一条流水。
_EVENT_TYPE_FOR_EVENT_NAME = {
    "usage": "llm.response_completed",
    "turn_started": "agent.turn_started",
    "turn_completed": "agent.turn_completed",
    "turn_paused": "agent.turn_paused",
    "turn_resumed": "agent.turn_resumed",
    "turn_cancelled": "agent.turn_cancelled",
    "error": "llm.error_encountered",
    "subagent_spawned": "subagent.spawned",
    "subagent_completed": "subagent.completed",
    "subagent_failed": "subagent.failed",
    "tool_call": "tool.call_requested",
}

_DEFAULT_EVENT_TYPE = {
    DIRECTION_REQUEST: "llm.request_sent",
    DIRECTION_RESPONSE: "llm.response_completed",
    DIRECTION_EVENT: "agent.turn_started",
}

#: 单条 payload 超过此字节数截断——审计轨是流水不是垃圾场，一条失控的
#: 工具输出不应独自吃掉整个滚动配额。
_MAX_PAYLOAD_CHARS = 256 * 1024

_TRUNCATION_MARK = "…[truncated by session audit track]"


def _truncate_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """序列化超限时收缩 payload：截断过长的字符串值，事实仍落盘。"""
    try:
        encoded = json.dumps(payload, ensure_ascii=False)
        if len(encoded.encode("utf-8", "replace")) <= _MAX_PAYLOAD_CHARS:
            return payload
    except (TypeError, ValueError):
        payload = {"unserializable": repr(payload)[:2000]}
        return payload

    def _cut(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: _cut(v) for k, v in node.items()}
        if isinstance(node, (list, tuple)):
            return [_cut(x) for x in node]
        if isinstance(node, str) and len(node.encode("utf-8", "replace")) > _MAX_PAYLOAD_CHARS:
            return node[:_MAX_PAYLOAD_CHARS] + _TRUNCATION_MARK
        return node

    return _cut(payload)


class SessionAuditTrack:
    """逐会话模型 I/O jsonl 审计轨。线程安全；全部写路径 fail-open。"""

    FILE_NAME = "model_io.jsonl"

    def __init__(
        self,
        base_dir: Optional[str] = None,
        session_logger: Optional[SessionLogger] = None,
        parent_lookup: Optional[Callable[[str], str]] = None,
        *,
        rotate_bytes: int = 8 * 1024 * 1024,
        keep_files: int = 4,
    ):
        """``session_logger`` 传入时复用其会话目录（model_io.jsonl 与
        transcript.jsonl 同目录）；否则用 ``base_dir`` / 环境变量独立布局。
        ``parent_lookup(sid)`` 是父会话 id 的惰性查询函数，查不到返回 ""。
        """
        if session_logger is not None:
            self._logger = session_logger
            self.base_dir = Path(session_logger.base_dir)
        else:
            self._logger = None
            override = os.environ.get("OVOLVE_LOGS_DIR") or os.environ.get("OVOLVE_LOGS_DIR")
            self.base_dir = Path(base_dir) if base_dir else (
                Path(override) if override
                else _user_home_dir() / "logs" / "sessions"  # user_dirs 约定的默认布局
            )
        self.rotate_bytes = max(64, int(rotate_bytes))
        self.keep_files = max(1, int(keep_files))
        self._lock = threading.Lock()
        self._seq_counters: Dict[str, int] = {}
        self._parent_cache: Dict[str, str] = {}
        self._parent_lock = threading.Lock()
        self._parent_lookup = parent_lookup
        #: 观测面：fail-open 丢弃了多少条审计——丢失要可数，不能不可见。
        self.dropped_writes = 0

    # ── 路径与命名 ────────────────────────────────────────────────────────

    def _session_dir(self, session_id: str) -> Path:
        if self._logger is not None:
            return self._logger.get_session_dir(session_id)
        sdir = self.base_dir / SessionLogger._fs_safe(session_id)
        sdir.mkdir(parents=True, exist_ok=True)
        return sdir

    def _live_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / self.FILE_NAME

    def _rotated_paths(self, session_id: str) -> List[Path]:
        """滚动文件，旧→新顺序返回（.N … .1）。"""
        sdir = self._session_dir(session_id)
        paths = []
        for i in range(self.keep_files, 0, -1):
            p = sdir / f"{self.FILE_NAME}.{i}"
            if p.exists():
                paths.append(p)
        return paths

    # ── 父子关联 ─────────────────────────────────────────────────────────

    def note_parent(self, session_id: str, parent_session_id: str) -> None:
        """直接登记父会话（create_session 时已知 parent_id，免查询）。"""
        with self._parent_lock:
            self._parent_cache[session_id] = str(parent_session_id or "")

    def _resolve_parent(self, session_id: str) -> str:
        with self._parent_lock:
            cached = self._parent_cache.get(session_id)
        if cached is not None:
            return cached
        resolved = ""
        if self._parent_lookup is not None:
            try:
                resolved = str(self._parent_lookup(session_id) or "")
            except Exception:  # noqa: BLE001 — 查询失败不影响审计落盘
                resolved = ""
        with self._parent_lock:
            self._parent_cache[session_id] = resolved
        return resolved

    # ── 写入 ─────────────────────────────────────────────────────────────

    def _count_lines(self, paths: List[Path]) -> int:
        n = 0
        for p in paths:
            try:
                with open(p, "rb") as fh:
                    n += sum(1 for _ in fh)
            except OSError:
                continue
        return n

    def _next_seq(self, session_id: str) -> int:
        """跨进程重启延续 seq：首次见到该会话时按现有文件行数续号。"""
        with self._lock:
            cur = self._seq_counters.get(session_id)
            if cur is None:
                cur = self._count_lines(self._rotated_paths(session_id))
                live = self._live_path(session_id)
                if live.exists():
                    cur += self._count_lines([live])
            nxt = cur + 1
            self._seq_counters[session_id] = nxt
            return nxt

    def _rotate_if_needed(self, session_id: str) -> None:
        live = self._live_path(session_id)
        try:
            size = live.stat().st_size
        except OSError:
            return
        if size < self.rotate_bytes:
            return
        sdir = live.parent
        for i in range(self.keep_files - 1, 0, -1):
            src = sdir / f"{self.FILE_NAME}.{i}"
            dst = sdir / f"{self.FILE_NAME}.{i + 1}"
            if src.exists():
                os.replace(src, dst)
        os.replace(live, sdir / f"{self.FILE_NAME}.1")
        self._seq_counters.pop(session_id, None)  # 行数变了，下次重数

    def record(
        self,
        session_id: str,
        direction: str,
        *,
        model: str = "",
        turn: Optional[int] = None,
        turn_id: str = "",
        event: str = "",
        event_type: str = "",
        tokens: Optional[Dict[str, Any]] = None,
        payload: Optional[Dict[str, Any]] = None,
        parent_ref: Optional[str] = None,
    ) -> bool:
        """追加一条模型 I/O 流水。返回是否落盘成功（fail-open：失败只记
        warning，永不抛——审计轨没有资格弄垮它正在审计的会话）。"""
        try:
            if direction not in DIRECTIONS:
                direction = DIRECTION_EVENT
            etype = str(event_type or "").strip()
            if not etype:
                if direction == DIRECTION_EVENT and event:
                    etype = _EVENT_TYPE_FOR_EVENT_NAME.get(str(event), _DEFAULT_EVENT_TYPE[direction])
                else:
                    etype = _DEFAULT_EVENT_TYPE[direction]
            entry = {
                "seq": self._next_seq(session_id),
                "ts": datetime.now(timezone.utc).isoformat(),
                "ts_epoch": time.time(),
                "session_id": session_id,
                "direction": direction,
                "event_type": etype,
                "model": str(model or ""),
                "turn": int(turn) if turn is not None else None,
                "turn_id": str(turn_id or ""),
                "parent_ref": str(parent_ref if parent_ref is not None
                                  else self._resolve_parent(session_id)),
                "tokens": dict(tokens or {}),
                "event": str(event or ""),
                "payload": _truncate_payload(dict(payload or {})),
            }
            line = json.dumps(entry, ensure_ascii=False)
            with self._lock:
                self._rotate_if_needed(session_id)
                with open(self._live_path(session_id), "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            return True
        except Exception as exc:  # noqa: BLE001 — fail-open 纪律
            self.dropped_writes += 1
            log.warning("[session_audit] model I/O track write failed for "
                        "session=%s direction=%s: %r", session_id, direction, exc)
            return False

    # ── 读取 / 回放 / 归档 ────────────────────────────────────────────────

    def read(self, session_id: str) -> List[Dict[str, Any]]:
        """读回整段流水（旧→新）。损坏行跳过、目录不可读返回已读到的部分，
        绝不抛——审计读取同样 fail-open。"""
        entries: List[Dict[str, Any]] = []
        try:
            paths = self._rotated_paths(session_id)
            live = self._live_path(session_id)
            if live.exists():
                paths.append(live)
            for p in paths:
                try:
                    with open(p, "r", encoding="utf-8", errors="replace") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                entries.append(json.loads(line))
                            except json.JSONDecodeError:
                                continue
                except OSError:
                    continue
        except Exception as exc:  # noqa: BLE001 — 读不出目录时返回已收集部分
            log.warning("[session_audit] read failed for session=%s: %r",
                        session_id, exc)
        entries.sort(key=lambda e: e.get("seq", 0))
        return entries

    def replay_into_store(self, session_id: str, store) -> Dict[str, Any]:
        """把 jsonl 流水重放进一个 EventStore（golden replay 同语义）。

        每条记录按其 canonical ``event_type`` append，seq/审计元数据一并进
        payload；之后调用方 ``store.verify_chain(session_id)`` 自证链完整性。
        """
        entries = self.read(session_id)
        appended = 0
        problems: List[str] = []
        for e in entries:
            payload_out = {k: v for k, v in e.items() if k != "seq"}
            try:
                store.append(session_id, e.get("event_type") or "llm.request_sent", payload_out)
                appended += 1
            except Exception as exc:  # noqa: BLE001
                problems.append(f"replay append failed at seq={e.get('seq')}: {exc}")
        return {"session_id": session_id, "appended": appended,
                "total": len(entries), "problems": problems}

    def archive_session(self, session_id: str, dest_name: str = "") -> Optional[str]:
        """会话归档：把该会话全部 model_io 文件移入归档子目录，返回目标目录
        字符串（无可归档文件时 None）。调用后该会话从 0 重新计 seq。"""
        try:
            sdir = self._session_dir(session_id)
            dest = sdir / "model_io_archive" / (dest_name or datetime.now().strftime("%Y%m%d-%H%M%S"))
            moved = 0
            with self._lock:
                candidates = list(self._rotated_paths(session_id))
                live = self._live_path(session_id)
                if live.exists():
                    candidates.append(live)
                if not candidates:
                    return None
                dest.mkdir(parents=True, exist_ok=True)
                for p in candidates:
                    os.replace(p, dest / p.name)
                    moved += 1
                self._seq_counters.pop(session_id, None)
            log.info("[session_audit] archived %d model I/O files of session=%s -> %s",
                     moved, session_id, dest)
            return str(dest)
        except Exception as exc:  # noqa: BLE001 — 归档失败不影响主流程
            log.warning("[session_audit] archive failed for session=%s: %r", session_id, exc)
            return None


# ── 进程级单例 ───────────────────────────────────────────────────────────────

_GLOBAL_AUDIT_TRACK: Optional[SessionAuditTrack] = None
_AUDIT_LOCK = threading.Lock()


def get_session_audit_track(
    base_dir: Optional[str] = None,
    session_logger: Optional[SessionLogger] = None,
    parent_lookup: Optional[Callable[[str], str]] = None,
) -> SessionAuditTrack:
    global _GLOBAL_AUDIT_TRACK
    with _AUDIT_LOCK:
        if _GLOBAL_AUDIT_TRACK is None:
            _GLOBAL_AUDIT_TRACK = SessionAuditTrack(
                base_dir=base_dir, session_logger=session_logger,
                parent_lookup=parent_lookup,
            )
        return _GLOBAL_AUDIT_TRACK

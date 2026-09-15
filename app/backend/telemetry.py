"""
telemetry.py — 遥测契约化（Pi 工程范式 §八）

schema 定义 span 名与属性（含 sensitive/cardinality 元数据），
代码里只能通过 schema 生成的类型调用，编译期杜绝打错属性名。

落盘与保留：finished span 走本地 JSONL（`~/.ovolve/telemetry/YYYY-MM-DD.jsonl`），
按天一个文件、超过保留天数自动删除，**不做远端上报**。内存里只留最近
MAX_BUFFERED_SPANS 条环形缓冲供诊断面板读取。sensitive 属性默认连 key 一起丢掉，
只有显式开启详细诊断模式才写真值。


"""

from __future__ import annotations

import os
import time
import json
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional
from enum import Enum


class SpanName(Enum):
    """预定义 span 名（契约化）。"""
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    LLM_REQUEST = "llm_request"
    LLM_RESPONSE = "llm_response"
    AGENT_DISPATCH = "agent_dispatch"
    SKILL_LOAD = "skill_load"
    RISK_CHECK = "risk_check"
    OUTPUT_GUARD = "output_guard"
    GOAL_ITERATION = "goal_iteration"
    CRON_EXECUTE = "cron_execute"
    BOT_MESSAGE = "bot_message"
    MEMORY_EXTRACT = "memory_extract"
    MEMORY_RECALL = "memory_recall"
    SESSION_START = "session_start"
    SESSION_COMPACT = "session_compact"
    CONTRACT_ENFORCE = "contract_enforce"
    SUBAGENT_QUARANTINE = "subagent_quarantine"


# 属性元数据：标记哪些属性含敏感数据（需脱敏）、哪些高基数（需采样）
ATTRIBUTE_METADATA = {
    "tool_name": {"sensitive": False, "high_cardinality": True},
    "tool_args": {"sensitive": True, "high_cardinality": True},
    "tool_result": {"sensitive": True, "high_cardinality": True},
    "error": {"sensitive": False, "high_cardinality": True},
    "duration_ms": {"sensitive": False, "high_cardinality": True},
    "session_id": {"sensitive": True, "high_cardinality": True},
    "user_id": {"sensitive": True, "high_cardinality": True},
    "agent_name": {"sensitive": False, "high_cardinality": False},
    "risk_level": {"sensitive": False, "high_cardinality": False},
    "model_name": {"sensitive": False, "high_cardinality": False},
    "input_tokens": {"sensitive": False, "high_cardinality": True},
    "output_tokens": {"sensitive": False, "high_cardinality": True},
}


@dataclass
class Span:
    """一个遥测 span。"""
    name: str
    start_time: float
    end_time: float = 0.0
    attributes: dict = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    status: str = "ok"  # ok / error
    error_message: str = ""

    @property
    def duration_ms(self) -> float:
        return (self.end_time - self.start_time) * 1000 if self.end_time else 0

    def add_event(self, name: str, **attrs):
        self.events.append({"name": name, "time": time.time(), "attrs": attrs})

    def set_error(self, message: str):
        self.status = "error"
        self.error_message = message

    def to_dict(self, verbose: bool = False) -> dict:
        return {
            "name": self.name,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "durationMs": self.duration_ms,
            "attributes": self._redact_attributes(verbose),
            "status": self.status,
            "errorMessage": self.error_message,
        }

    def _redact_attributes(self, verbose: bool = False) -> dict:
        """Strip sensitive attribute values before a span leaves memory.

        Default (``verbose=False``): a sensitive key is DROPPED entirely, not
        replaced with a placeholder. A ``"<redacted>"`` value still discloses
        that content existed at that key for that span — which arg was non-empty,
        which turns carried a user_id — and that shape is itself signal. The key
        only reappears when the user has explicitly opted into verbose diagnostics
        for the current process, and even then it is the real value, never a
        half-measure that leaks structure while claiming to protect it.
        """
        out = {}
        for key, val in self.attributes.items():
            meta = ATTRIBUTE_METADATA.get(key, {})
            if meta.get("sensitive") and val is not None and not verbose:
                continue
            out[key] = val
        return out


#: How many finished spans the in-memory buffer keeps. It exists to serve the
#: diagnostics panel, nothing else — the durable copy is on disk. Unbounded
#: growth here was a slow leak in a desktop process that stays up for weeks.
MAX_BUFFERED_SPANS = 2000

#: A span left open (start without end) can only be an escaped exception. Cap
#: the stack so those don't accumulate either; oldest is dropped first.
MAX_OPEN_SPANS = 64

#: Local-only retention. Telemetry never leaves the machine, so the privacy
#: question is "how long does it sit on disk", not "who receives it".
TELEMETRY_RETENTION_DAYS = 7

TELEMETRY_DIR_ENV = "OVOLVE_TELEMETRY_DIR"
TELEMETRY_OFF_ENV = "OVOLVE_TELEMETRY_OFF"
TELEMETRY_VERBOSE_ENV = "OVOLVE_TELEMETRY_VERBOSE"


def default_telemetry_dir() -> str:
    """Where daily span files live. Sits beside the DB, under the user's home."""
    override = os.environ.get(TELEMETRY_DIR_ENV)
    if override:
        return override
    try:
        from user_dirs import home_dir
    except ImportError:  # pragma: no cover - packaged import shape
        from app.backend.user_dirs import home_dir
    return str(home_dir() / "telemetry")


class JsonlSpanSink:
    """Append finished spans to ``<dir>/YYYY-MM-DD.jsonl``, one JSON per line.

    Deliberately the dumbest durable thing that works: no remote endpoint, no
    background flusher, no index. Spans were being collected and then thrown
    away at process exit, so any answer to "why was yesterday's turn slow" had
    to be guessed. A day-per-file layout makes retention a directory listing and
    makes reading the recent past a tail of one file.

    Every method swallows its own errors. Telemetry that can break a turn is
    worse than no telemetry.
    """

    def __init__(self, directory: str = None,
                 retention_days: int = TELEMETRY_RETENTION_DAYS):
        self.directory = directory or default_telemetry_dir()
        self.retention_days = max(1, int(retention_days))
        self._lock = threading.Lock()
        self._day = ""
        self._ready = False

    def _day_key(self, when: float) -> str:
        return time.strftime("%Y-%m-%d", time.localtime(when))

    def path_for(self, when: float) -> str:
        return os.path.join(self.directory, f"{self._day_key(when)}.jsonl")

    def __call__(self, span_dict: dict) -> None:
        """Exporter protocol: called with an already-redacted span dict."""
        now = span_dict.get("endTime") or time.time()
        line = json.dumps(span_dict, ensure_ascii=False, default=str)
        with self._lock:
            try:
                if not self._ready:
                    os.makedirs(self.directory, exist_ok=True)
                    self._ready = True
                day = self._day_key(now)
                if day != self._day:
                    # First write of a new day: also the natural moment to prune.
                    self._day = day
                    self._prune_locked()
                with open(self.path_for(now), "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

    def _prune_locked(self) -> None:
        cutoff = time.time() - self.retention_days * 86400
        try:
            names = os.listdir(self.directory)
        except OSError:
            return
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            stem = name[:-6]
            try:
                when = time.mktime(time.strptime(stem, "%Y-%m-%d"))
            except ValueError:
                continue
            # Compare on the file's own date, not mtime: an old day's file that
            # happened to be touched by a backup tool should still expire.
            if when < cutoff:
                try:
                    os.remove(os.path.join(self.directory, name))
                except OSError:
                    pass  # fail-open: 可选增强，失败不影响主流程

    def read_recent(self, limit: int = 200, days: int = 2) -> list[dict]:
        """Most recent spans from disk, newest first.

        Reads whole day-files rather than seeking backwards. At a few thousand
        lines a day that is well under a millisecond, and correctness beats
        cleverness for a diagnostics read that runs on demand.
        """
        out: list[dict] = []
        now = time.time()
        for back in range(max(1, int(days))):
            path = self.path_for(now - back * 86400)
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    rows = fh.readlines()
            except OSError:
                continue
            for raw in reversed(rows):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    out.append(json.loads(raw))
                except json.JSONDecodeError:
                    continue
                if len(out) >= limit:
                    return out
        return out


class Telemetry:
    """遥测收集器。"""

    def __init__(self, enabled: bool = True, exporter: Any = None,
                 verbose: bool = False, max_spans: int = MAX_BUFFERED_SPANS):
        self.enabled = enabled
        self.exporter = exporter  # 可选导出器（OTLP / JSON 文件等）
        #: Include sensitive attribute values in exported spans. Off unless the
        #: user asks for detailed diagnostics — see Span._redact_attributes.
        self.verbose = verbose
        #: Ring buffers, not lists. `_spans` serves the diagnostics panel;
        #: `_current` is the open-span stack and only grows when an exception
        #: escapes between start_span and end_span.
        self._spans: deque = deque(maxlen=max(1, int(max_spans)))
        self._current: deque = deque(maxlen=MAX_OPEN_SPANS)

    def start_span(self, name: SpanName | str, **attributes) -> Span:
        """开始一个 span。"""
        if not self.enabled:
            return Span(name=str(name), start_time=0)

        span_name = name.value if isinstance(name, SpanName) else name
        span = Span(name=span_name, start_time=time.time(), attributes=attributes)
        self._current.append(span)
        return span

    def end_span(self, span: Span, **extra_attrs):
        """结束 span。"""
        if not self.enabled or span.start_time == 0:
            return

        span.end_time = time.time()
        span.attributes.update(extra_attrs)
        if self._current and self._current[-1] is span:
            self._current.pop()
        self._spans.append(span)
        self._export(span)

    def record(self, name: SpanName | str, duration_ms: float = 0, **attributes):
        """一次性记录（无需 start/end）。"""
        if not self.enabled:
            return
        span = Span(
            name=name.value if isinstance(name, SpanName) else name,
            start_time=time.time() - duration_ms / 1000,
            end_time=time.time(),
            attributes=attributes,
        )
        self._spans.append(span)
        self._export(span)

    def _export(self, span: Span) -> None:
        if not self.exporter:
            return
        try:
            self.exporter(span.to_dict(verbose=self.verbose))
        except Exception:
            pass  # 遥测失败不影响主流程

    def get_spans(self) -> list[dict]:
        """获取所有 span（脱敏后）。"""
        return [s.to_dict(verbose=self.verbose) for s in self._spans]

    def stats(self) -> list[dict]:
        """Per-span-name count / error count / p50 / p95, for the panel.

        Computed from the in-memory ring only. A window that shows "the last
        2000 spans" is honest; one that silently mixes a partial disk read into
        the same percentiles is not.
        """
        by_name: dict[str, list[float]] = {}
        errors: dict[str, int] = {}
        for span in self._spans:
            by_name.setdefault(span.name, []).append(span.duration_ms)
            if span.status == "error":
                errors[span.name] = errors.get(span.name, 0) + 1
        rows = []
        for name, durations in by_name.items():
            ordered = sorted(durations)
            rows.append({
                "name": name,
                "count": len(ordered),
                "errors": errors.get(name, 0),
                "p50Ms": round(_percentile(ordered, 0.50), 2),
                "p95Ms": round(_percentile(ordered, 0.95), 2),
                "maxMs": round(ordered[-1], 2) if ordered else 0.0,
            })
        rows.sort(key=lambda r: r["count"], reverse=True)
        return rows

    def flush(self):
        """清空缓冲。"""
        self._spans.clear()


def _percentile(ordered: list[float], q: float) -> float:
    """Nearest-rank percentile over a pre-sorted list. [] -> 0.0."""
    if not ordered:
        return 0.0
    idx = int(round(q * (len(ordered) - 1)))
    return ordered[max(0, min(len(ordered) - 1, idx))]


# 全局遥测实例
_telemetry: Optional[Telemetry] = None


def _env_flag(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in ("1", "true", "yes", "on")


def _telemetry_enabled_by_config() -> bool:
    """Read `telemetry.enabled` from config.json (default True).

    The key sat in config.json for a long time with nothing reading it; this
    makes the settings toggle real. Env vars still win — a CI run asking for
    silence must not be overridden by a config file.
    """
    try:
        cfg_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
        with open(cfg_path, "r", encoding="utf-8") as f:
            val = (json.load(f).get("telemetry") or {}).get("enabled")
        return bool(val) if val is not None else True
    except Exception:
        return True


def get_telemetry() -> Telemetry:
    """The process telemetry singleton.

    Auto-initialises with the local JSONL sink on first use, so telemetry is
    durable even if nothing called ``init_telemetry`` at startup — which is how
    it used to be: the exporter was always None and every span collected was
    discarded at exit. Honour ``OVOLVE_TELEMETRY_OFF`` for a fully silent run
    (tests, CI) and ``OVOLVE_TELEMETRY_VERBOSE`` for opt-in sensitive values.
    """
    global _telemetry
    if _telemetry is None:
        if _env_flag(TELEMETRY_OFF_ENV):
            _telemetry = Telemetry(enabled=False)
        else:
            _telemetry = Telemetry(
                enabled=_telemetry_enabled_by_config(),
                exporter=JsonlSpanSink(),
                verbose=_env_flag(TELEMETRY_VERBOSE_ENV),
            )
    return _telemetry


def init_telemetry(enabled: bool = True, exporter: Any = None,
                   verbose: bool = False) -> Telemetry:
    """Replace the singleton with an explicitly configured collector.

    Pass ``exporter=None`` to get the default local JSONL sink; pass a callable
    to route spans elsewhere (a test spy, a custom aggregator). Call once at
    startup, before the first ``get_telemetry``.
    """
    global _telemetry
    if exporter is None and enabled and not _env_flag(TELEMETRY_OFF_ENV):
        exporter = JsonlSpanSink()
    _telemetry = Telemetry(enabled=enabled, exporter=exporter, verbose=verbose)
    return _telemetry

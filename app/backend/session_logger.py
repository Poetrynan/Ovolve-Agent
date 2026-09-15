"""
session_logger.py — Complete full-link conversation, reasoning, and tool execution logger.

For every conversation between the AI Agent and the user, maintains:
1. `session.log` (or `session_trace.md`): Beautiful, human-readable structured Markdown log.
2. `transcript.jsonl`: Step-by-step machine-readable event stream (agent transcript standard).
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class SessionLogger:
    """Thread-safe full-link logger for Agent-User conversations."""

    def __init__(self, base_dir: Optional[str] = None):
        if base_dir:
            self.base_dir = Path(base_dir)
        else:
            override = (os.environ.get("OVOLVE_LOGS_DIR")
                        or os.environ.get("OVOLVE_LOGS_DIR"))
            if override:
                self.base_dir = Path(override)
            else:
                try:
                    from user_dirs import home_dir
                except ImportError:  # pragma: no cover - packaged import shape
                    from app.backend.user_dirs import home_dir
                self.base_dir = home_dir() / "logs" / "sessions"

        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._step_counters: Dict[str, int] = {}

    @staticmethod
    def _fs_safe(session_id: str) -> str:
        """Sanitize a session id for use as a directory name.

        Sub-agent session ids look like ``bench-x::sub::y`` — on Windows the
        ``:`` (and ``< > " / \\ | ? *``) are illegal in file names and every
        audit write fails with OSError 22/123. Keep the id readable but
        filesystem-safe; the in-memory/logical id is untouched.
        """
        import re as _re

        return _re.sub(r'[<>:"/\\|?*]', "_", session_id or "")

    def get_session_dir(self, session_id: str) -> Path:
        sdir = self.base_dir / self._fs_safe(session_id)
        sdir.mkdir(parents=True, exist_ok=True)
        return sdir

    def get_transcript_path(self, session_id: str) -> Path:
        return self.get_session_dir(session_id) / "transcript.jsonl"

    def get_log_path(self, session_id: str) -> Path:
        return self.get_session_dir(session_id) / "session.log"

    def _next_step(self, session_id: str) -> int:
        with self._lock:
            cur = self._step_counters.get(session_id)
            if cur is None:
                tpath = self.get_transcript_path(session_id)
                if tpath.exists():
                    try:
                        with open(tpath, "r", encoding="utf-8") as f:
                            lines = f.readlines()
                            cur = len(lines)
                    except Exception:
                        cur = 0
                else:
                    cur = 0
            nxt = cur + 1
            self._step_counters[session_id] = nxt
            return cur

    @staticmethod
    def _iso_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _local_now() -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def init_session(self, session_id: str, title: str = "", workspace: str = "") -> None:
        """Initialize session directory and write header to log files."""
        log_path = self.get_log_path(session_id)
        if not log_path.exists():
            header = (
                f"# 📋 SESSION TRACE LOG: {session_id}\n"
                f"> **Title**: {title or 'Untitled Session'}\n"
                f"> **Created**: {self._local_now()}\n"
                f"> **Workspace**: {workspace or os.getcwd()}\n"
                f"{'=' * 80}\n\n"
            )
            with self._lock:
                with open(log_path, "w", encoding="utf-8") as f:
                    f.write(header)

    def log_event(
        self,
        session_id: str,
        event_type: str,
        source: str,
        payload: Dict[str, Any],
        human_text: Optional[str] = None,
    ) -> None:
        """Append event to both transcript.jsonl and session.log."""
        step_idx = self._next_step(session_id)
        ts_iso = self._iso_now()

        # 1. Machine-readable JSONL
        entry = {
            "step_index": step_idx,
            "session_id": session_id,
            "timestamp": ts_iso,
            "type": event_type,
            "source": source,
            "payload": payload,
        }
        tpath = self.get_transcript_path(session_id)
        with self._lock:
            with open(tpath, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # 2. Human-readable Markdown log
        if human_text:
            lpath = self.get_log_path(session_id)
            with self._lock:
                with open(lpath, "a", encoding="utf-8") as f:
                    f.write(human_text + "\n\n")

    def log_user_input(
        self, session_id: str, content: str, images: Optional[List[Any]] = None, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        """Log user's input prompt."""
        text_block = (
            f"## [{self._local_now()}] 👤 USER\n"
            f"{content.strip()}"
        )
        if images:
            text_block += f"\n*(Attached {len(images)} images)*"

        self.log_event(
            session_id=session_id,
            event_type="USER_INPUT",
            source="USER",
            payload={"content": content, "images": images or [], "metadata": metadata or {}},
            human_text=text_block,
        )

    def log_thinking(
        self, session_id: str, text: str, duration_ms: float = 0.0, started_at: Optional[float] = None
    ) -> None:
        """Log Agent reasoning / CoT thinking block."""
        dur_str = f"Thought for {duration_ms/1000:.1f}s" if duration_ms > 0 else "Thinking"
        text_block = (
            f"## [{self._local_now()}] 🧠 THINKING ({dur_str})\n"
            f"{text.strip()}"
        )
        self.log_event(
            session_id=session_id,
            event_type="THINKING",
            source="MODEL",
            payload={"text": text, "duration_ms": duration_ms, "started_at": started_at},
            human_text=text_block,
        )

    def log_tool_call(
        self,
        session_id: str,
        tool_name: str,
        call_id: str,
        args: Dict[str, Any],
        cwd: str = "",
        risk_level: str = "low",
    ) -> None:
        """Log Agent tool invocation."""
        cmd = args.get("CommandLine") or args.get("command") or args.get("cmd") or args.get("code") or ""
        text_block = (
            f"## [{self._local_now()}] ⚡ TOOL CALL: `{tool_name}` (call_id: `{call_id}`)\n"
        )
        if cmd:
            text_block += f"- **Command / Code**:\n```bash\n{cmd}\n```\n"
        if cwd:
            text_block += f"- **Directory**: `{cwd}`\n"
        if risk_level and risk_level != "low":
            text_block += f"- **Risk Level**: `{risk_level.upper()}`\n"
        if not cmd:
            text_block += f"- **Args**:\n```json\n{json.dumps(args, indent=2, ensure_ascii=False)}\n```\n"

        self.log_event(
            session_id=session_id,
            event_type="TOOL_CALL",
            source="AGENT",
            payload={
                "tool_name": tool_name,
                "call_id": call_id,
                "args": args,
                "cwd": cwd,
                "risk_level": risk_level,
            },
            human_text=text_block.strip(),
        )

    def log_tool_result(
        self,
        session_id: str,
        tool_name: str,
        call_id: str,
        status: str = "completed",
        exit_code: Optional[int] = 0,
        output: str = "",
        result: Any = None,
        duration_ms: float = 0.0,
        error: str = "",
    ) -> None:
        """Log tool execution result/output."""
        dur_str = f", Duration: {duration_ms/1000:.1f}s" if duration_ms > 0 else ""
        exit_str = f", Exit Code: {exit_code}" if exit_code is not None else ""
        text_block = (
            f"## [{self._local_now()}] 📋 TOOL RESULT: `{tool_name}` (Status: `{status}`{exit_str}{dur_str})\n"
        )
        out_content = output or (str(result) if result is not None else "") or error
        if out_content:
            text_block += f"```\n{out_content.strip()}\n```"
        else:
            text_block += "*(Completed with no output)*"

        self.log_event(
            session_id=session_id,
            event_type="TOOL_RESULT",
            source="SYSTEM",
            payload={
                "tool_name": tool_name,
                "call_id": call_id,
                "status": status,
                "exit_code": exit_code,
                "output": output,
                "result": result,
                "duration_ms": duration_ms,
                "error": error,
            },
            human_text=text_block,
        )

    def log_assistant_response(
        self, session_id: str, content: str, images: Optional[List[Any]] = None, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        """Log final Assistant answer to user."""
        text_block = (
            f"## [{self._local_now()}] 🤖 ASSISTANT\n"
            f"{content.strip()}"
        )
        if images:
            text_block += f"\n*(Generated {len(images)} images)*"

        self.log_event(
            session_id=session_id,
            event_type="ASSISTANT_RESPONSE",
            source="MODEL",
            payload={"content": content, "images": images or [], "metadata": metadata or {}},
            human_text=text_block,
        )

    def read_transcript(self, session_id: str) -> List[Dict[str, Any]]:
        """Read all events from transcript.jsonl."""
        tpath = self.get_transcript_path(session_id)
        if not tpath.exists():
            return []
        events = []
        with open(tpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        pass  # fail-open: 可选增强，失败不影响主流程
        return events

    def read_log_text(self, session_id: str) -> str:
        """Read raw text of session.log."""
        lpath = self.get_log_path(session_id)
        if not lpath.exists():
            return ""
        with open(lpath, "r", encoding="utf-8") as f:
            return f.read()

    def get_log_info(self, session_id: str) -> Dict[str, Any]:
        """Return file paths and statistics for session logs."""
        lpath = self.get_log_path(session_id)
        tpath = self.get_transcript_path(session_id)
        return {
            "session_id": session_id,
            "log_path": str(lpath.resolve()),
            "transcript_path": str(tpath.resolve()),
            "log_exists": lpath.exists(),
            "transcript_exists": tpath.exists(),
            "log_size_bytes": lpath.stat().st_size if lpath.exists() else 0,
            "transcript_size_bytes": tpath.stat().st_size if tpath.exists() else 0,
            "step_count": len(self.read_transcript(session_id)),
        }


# Singleton accessor
_GLOBAL_SESSION_LOGGER: Optional[SessionLogger] = None
_LOGGER_LOCK = threading.Lock()


def get_session_logger(base_dir: Optional[str] = None) -> SessionLogger:
    global _GLOBAL_SESSION_LOGGER
    with _LOGGER_LOCK:
        if _GLOBAL_SESSION_LOGGER is None:
            _GLOBAL_SESSION_LOGGER = SessionLogger(base_dir=base_dir)
        return _GLOBAL_SESSION_LOGGER

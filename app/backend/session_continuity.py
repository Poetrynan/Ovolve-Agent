# -*- coding: utf-8 -*-
"""
session_continuity.py — 会话断点自愈与崩溃恢复引擎 (Phase 64 核心硬内化)。

1. 在长任务或多轮交互中，定期落盘会话快照 (Checkpoint)；
2. 异常退出、崩溃或网络重连时，主代理自动探测断点并无缝自愈恢复；
3. 恢复后向用户明确呈现已恢复状态与未完成目标。
"""
from __future__ import annotations

import json
import os
import time
import logging
from typing import Optional, Any

log = logging.getLogger(__name__)


class SessionContinuityEngine:
    """生产级会话断点自愈引擎。"""

    def __init__(self, checkpoints_dir: str) -> None:
        self.checkpoints_dir = checkpoints_dir
        os.makedirs(self.checkpoints_dir, exist_ok=True)

    def _get_path(self, session_id: str) -> str:
        safe_id = "".join(c for c in session_id if c.isalnum() or c in ("-", "_"))
        return os.path.join(self.checkpoints_dir, f"{safe_id}.checkpoint.json")

    def save_checkpoint(
        self,
        session_id: str,
        goal_id: str = "",
        current_step: int = 0,
        turn_seq: int = 0,
        uncommitted_files: Optional[list[str]] = None,
        context_summary: str = "",
        meta: Optional[dict[str, Any]] = None
    ) -> str:
        """持久化保存会话断点快照。"""
        if not session_id:
            return ""

        path = self._get_path(session_id)
        payload = {
            "session_id": session_id,
            "goal_id": goal_id,
            "current_step": current_step,
            "turn_seq": turn_seq,
            "uncommitted_files": uncommitted_files or [],
            "context_summary": context_summary,
            "meta": meta or {},
            "timestamp": time.time(),
            "status": "in_progress"
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        log.info("[SessionContinuityEngine] Checkpoint saved for %s at step %d", session_id, current_step)
        return path

    def load_checkpoint(self, session_id: str) -> Optional[dict[str, Any]]:
        """加载指定会话的断点快照。"""
        path = self._get_path(session_id)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as exc:
            log.warning("[SessionContinuityEngine] Failed to load checkpoint %s: %s", path, exc)
            return None

    def mark_completed(self, session_id: str) -> bool:
        """会话圆满完成，标记或归档断点快照。"""
        path = self._get_path(session_id)
        if not os.path.exists(path):
            return False
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["status"] = "completed"
            data["finished_at"] = time.time()
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            return False

    def list_recoverable_sessions(self) -> list[dict[str, Any]]:
        """列出所有可自愈恢复的未完结会话断点。"""
        recoverable = []
        if not os.path.exists(self.checkpoints_dir):
            return recoverable

        for fname in os.listdir(self.checkpoints_dir):
            if not fname.endswith(".checkpoint.json"):
                continue
            fpath = os.path.join(self.checkpoints_dir, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("status") == "in_progress":
                    recoverable.append(data)
            except Exception:
                continue
        return sorted(recoverable, key=lambda x: x.get("timestamp", 0), reverse=True)

    def purge_checkpoint(self, session_id: str) -> bool:
        """物理清理断点文件。"""
        path = self._get_path(session_id)
        if os.path.exists(path):
            try:
                os.remove(path)
                return True
            except OSError:
                return False
        return False

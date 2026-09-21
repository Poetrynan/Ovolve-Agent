"""
test_f1_f2_f4_f6_features.py — F1/F2/F4/F6 新功能回归测试

F1: teammate-message 消息封装协议
F2: 框架自动通知 + 去重
F4: 终态软屏障 + merge 状态机
F6: 生命周期补全 (SPAWN_ERROR/LOST/idle_since)
"""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ── F1: teammate-message ─────────────────────────────────────────────────────

class TestTeammateMessage:
    """F1: teammate-message 封装协议。"""

    def test_format_basic(self):
        from mailbox import format_teammate_message
        msg = format_teammate_message("coder-1", "Fixed the bug", "修复完成")
        assert 'sender="coder-1"' in msg
        assert 'summary="修复完成"' in msg
        assert "Fixed the bug" in msg

    def test_format_auto_summary(self):
        from mailbox import format_teammate_message
        # 无 summary 时自动从 content 首行提取
        msg = format_teammate_message("coder-1", "第一行总结\n第二行详情")
        assert 'summary="第一行总结"' in msg

    def test_format_summary_truncation(self):
        from mailbox import format_teammate_message
        long_summary = "x" * 100
        msg = format_teammate_message("s", "", long_summary)
        # summary 截断到 80 字符
        assert 'summary="' + "x" * 80 + '"' in msg

    def test_format_empty_content(self):
        from mailbox import format_teammate_message
        msg = format_teammate_message("s", "", "")
        assert 'summary="(no content)"' in msg

    def test_strip_normal(self):
        from mailbox import strip_teammate_message
        msg = '[teammate-message sender="coder-1" summary="完成"]content[/teammate-message]'
        result = strip_teammate_message(msg)
        assert result == "[@coder-1] 完成"

    def test_strip_malformed(self):
        from mailbox import strip_teammate_message
        # 畸形输入不抛异常
        assert strip_teammate_message("plain text") == "plain text"
        assert strip_teammate_message("") == ""

    def test_roundtrip(self):
        from mailbox import format_teammate_message, strip_teammate_message
        original = format_teammate_message("researcher", "Found 3 issues", "发现")
        stripped = strip_teammate_message(original)
        assert "[@researcher]" in stripped
        assert "发现" in stripped

    def test_send_teammate(self):
        from mailbox import send_teammate, make_teammate_payload
        payload = make_teammate_payload("coder", "content", "summary")
        assert payload["sender"] == "coder"
        assert payload["summary"] == "summary"
        assert "formatted" in payload


# ── F2: 框架自动通知 ─────────────────────────────────────────────────────────

class TestFrameworkAutoNotification:
    """F2: 子代理终态后框架自动通知父 Agent。"""

    def test_classify_terminal_completed(self):
        from subagent_runtime import _classify_terminal
        assert _classify_terminal({"ok": True}) == "completed"

    def test_classify_terminal_failed(self):
        from subagent_runtime import _classify_terminal
        assert _classify_terminal({"ok": False, "error": "something broke"}) == "failed"

    def test_classify_terminal_cancelled(self):
        from subagent_runtime import _classify_terminal
        assert _classify_terminal({"ok": False, "error": "was cancelled"}) == "cancelled"

    def test_classify_terminal_timeout(self):
        from subagent_runtime import _classify_terminal
        assert _classify_terminal({"ok": False, "error": "timed out"}) == "timeout"

    def test_classify_terminal_killed(self):
        from subagent_runtime import _classify_terminal
        assert _classify_terminal({"ok": False, "error": "was killed"}) == "killed"

    def test_is_terminal(self):
        from subagent_runtime import _is_terminal
        assert _is_terminal({"ok": True}) is True
        assert _is_terminal({"ok": False}) is True
        assert _is_terminal({"ok": None}) is False
        assert _is_terminal({}) is False

    def test_terminal_verbs(self):
        from subagent_runtime import _TERMINAL_VERBS
        assert _TERMINAL_VERBS["completed"] == "completed successfully"
        assert _TERMINAL_VERBS["failed"] == "failed"
        assert _TERMINAL_VERBS["cancelled"] == "was cancelled"


# ── F4: 终态软屏障 + merge 状态机 ───────────────────────────────────────────

class TestTurnEndBarrier:
    """F4: 终态软屏障枚举与判定。"""

    def test_block_reason_enum(self):
        from subagent_runtime import TurnEndBlockReason
        assert TurnEndBlockReason.UNSPECIFIED.value == "unspecified"
        assert TurnEndBlockReason.SUBAGENTS_RUNNING.value == "subagents_running"
        assert TurnEndBlockReason.MERGE_BACK_FAILED.value == "merge_back_failed"

    def test_get_turn_end_blockers_no_active(self):
        from subagent_runtime import get_turn_end_blockers
        # 无活跃子代理 → 空列表
        blockers = get_turn_end_blockers("nonexistent-session-xyz")
        assert blockers == []


class TestMergeStatus:
    """F4: merge 状态机判定。"""

    def test_safe_merge(self):
        from work_copy import describe_merge_status
        result = {"applied": ["a.py"], "deleted": [], "conflicts": {}, "errors": []}
        assert describe_merge_status(result) == "safe_merge"

    def test_merge_with_conflicts(self):
        from work_copy import describe_merge_status
        result = {"applied": ["a.py"], "deleted": [], "conflicts": {"b.py": ["c1", "c2"]}, "errors": []}
        assert describe_merge_status(result) == "merge_with_conflicts"

    def test_merge_back_failed(self):
        from work_copy import describe_merge_status
        result = {"applied": [], "deleted": [], "conflicts": {}, "errors": [{"path": "a.py"}]}
        assert describe_merge_status(result) == "merge_back_failed"

    def test_merge_empty(self):
        from work_copy import describe_merge_status
        result = {"applied": [], "deleted": [], "conflicts": {}, "errors": []}
        assert describe_merge_status(result) == "empty"


# ── F6: 生命周期补全 ─────────────────────────────────────────────────────────

class TestLifecycleStatuses:
    """F6: SPAWN_ERROR / LOST / IDLE 状态。"""

    def test_spawn_error_status(self):
        from subagent_runtime import SubagentStatus
        assert SubagentStatus.SPAWN_ERROR.value == "spawn_error"

    def test_lost_status(self):
        from subagent_runtime import SubagentStatus
        assert SubagentStatus.LOST.value == "lost"

    def test_idle_status(self):
        from subagent_runtime import SubagentStatus
        assert SubagentStatus.IDLE.value == "idle"

    def test_spawn_error_in_terminal(self):
        from subagent_runtime import SubagentStatus, TERMINAL_STATUSES
        assert SubagentStatus.SPAWN_ERROR in TERMINAL_STATUSES

    def test_lost_in_terminal(self):
        from subagent_runtime import SubagentStatus, TERMINAL_STATUSES
        assert SubagentStatus.LOST in TERMINAL_STATUSES

    def test_idle_not_in_terminal(self):
        """IDLE 不是严格终态（空闲钩子可能触发新工作）。"""
        from subagent_runtime import SubagentStatus, TERMINAL_STATUSES
        assert SubagentStatus.IDLE not in TERMINAL_STATUSES

    def test_session_idle_since_field(self):
        from subagent_runtime import SubagentSession
        sess = SubagentSession(
            subagent_id="test", subagent_type="coder",
            label="test", parent_session_id="p", child_session_id="c",
        )
        assert sess.idle_since == 0.0  # 默认值

    def test_session_to_public_includes_idle(self):
        from subagent_runtime import SubagentSession
        sess = SubagentSession(
            subagent_id="test", subagent_type="coder",
            label="test", parent_session_id="p", child_session_id="c",
        )
        public = sess.to_public()
        assert "idleSince" in public

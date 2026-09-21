# -*- coding: utf-8 -*-
"""
test_session_continuity.py — 单元测试：会话断点自愈与崩溃恢复引擎 (Phase 64)。
"""
import os
import tempfile
import pytest
from session_continuity import SessionContinuityEngine


def test_session_continuity_lifecycle():
    with tempfile.TemporaryDirectory() as tmp_dir:
        engine = SessionContinuityEngine(tmp_dir)

        # 1. 保存断点
        session_id = "sess-crash-recovery-001"
        chk_path = engine.save_checkpoint(
            session_id=session_id,
            goal_id="goal-refactor-auth",
            current_step=4,
            turn_seq=12,
            uncommitted_files=["app/backend/auth.py"],
            context_summary="Refactoring auth token validation"
        )
        assert os.path.exists(chk_path)

        # 2. 列出可恢复会话
        recoverable = engine.list_recoverable_sessions()
        assert len(recoverable) == 1
        assert recoverable[0]["session_id"] == session_id
        assert recoverable[0]["current_step"] == 4

        # 3. 加载断点快照
        loaded = engine.load_checkpoint(session_id)
        assert loaded is not None
        assert loaded["goal_id"] == "goal-refactor-auth"
        assert loaded["uncommitted_files"] == ["app/backend/auth.py"]

        # 4. 标记完成
        engine.mark_completed(session_id)
        recoverable_after = engine.list_recoverable_sessions()
        assert len(recoverable_after) == 0

        # 5. 物理清理
        engine.purge_checkpoint(session_id)
        assert not os.path.exists(chk_path)
